//go:build linux

package device

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/unix"
)

const (
	djiVendorID         = "2ca3"
	djiProductID        = "4006"
	djiFirstSerialIndex = 0
	djiLastSerialIndex  = 3
	djiATIndex          = 2
	djiQMIIndex         = 4
)

type usbControlTransfer struct {
	RequestType uint8
	Request     uint8
	Value       uint16
	Index       uint16
	Length      uint16
	Timeout     uint32
	Data        uintptr
}

func repairDJIQMI(ctx context.Context) (QMIRepairResult, error) {
	qmicli, err := djiQMIRequirements()
	if err != nil {
		return QMIRepairResult{}, err
	}
	return retryDJIQMI(ctx, 3, 500*time.Millisecond, func(attemptContext context.Context) (QMIRepairResult, error) {
		return repairDJIQMIAt(attemptContext, "/sys", "/dev", qmicli, "")
	})
}

// repairDJIQMIFor restores the factory AT/QMI USB binding on one specific DJI
// 4G module, identified by its sysfs device path (for example
// "/sys/bus/usb/devices/1-4.3"). It is the building block that lets discovery
// repair several DJI modules independently instead of requiring exactly one
// module on the bus.
func repairDJIQMIFor(ctx context.Context, usbPath string) (QMIRepairResult, error) {
	qmicli, err := djiQMIRequirements()
	if err != nil {
		return QMIRepairResult{}, err
	}
	usbName := filepath.Base(filepath.Clean(usbPath))
	if usbPath == "" || usbName == "." || usbName == string(filepath.Separator) {
		return QMIRepairResult{}, errors.New("DJI module USB path is required for per-device repair")
	}
	return retryDJIQMI(ctx, 3, 500*time.Millisecond, func(attemptContext context.Context) (QMIRepairResult, error) {
		return repairDJIQMIAt(attemptContext, "/sys", "/dev", qmicli, usbName)
	})
}

// djiQMIRequirements verifies the two host prerequisites shared by every DJI
// repair entry point: the qmicli binary for the final readiness probe, and
// root access for sysfs rebinding and /dev/bus/usb control transfers.
func djiQMIRequirements() (string, error) {
	qmicli, err := exec.LookPath("qmicli")
	if err != nil {
		return "", errors.New("qmicli is required to verify DJI QMI readiness; install libqmi-utils on Debian/Ubuntu/Fedora, libqmi on Arch Linux, or qmi-utils on Alpine")
	}
	if os.Geteuid() != 0 {
		return "", ErrDJIRepairNotRoot
	}
	return qmicli, nil
}

func retryDJIQMI(
	ctx context.Context,
	maxAttempts int,
	delay time.Duration,
	attempt func(context.Context) (QMIRepairResult, error),
) (QMIRepairResult, error) {
	var result QMIRepairResult
	var err error
	for attemptNumber := 1; attemptNumber <= maxAttempts; attemptNumber++ {
		result, err = attempt(ctx)
		result.Attempts = attemptNumber
		if err == nil {
			return result, nil
		}
		if ctx.Err() != nil {
			break
		}
		timer := time.NewTimer(time.Duration(attemptNumber) * delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return result, errors.Join(err, ctx.Err())
		case <-timer.C:
		}
	}
	return result, fmt.Errorf("failed after %d DTR repair attempt(s): %w", result.Attempts, err)
}

func repairDJIQMIAt(ctx context.Context, sysRoot, devRoot, qmicli, targetUSBName string) (result QMIRepairResult, returnErr error) {
	usbRoot := filepath.Join(sysRoot, "bus", "usb", "devices")
	entries, err := os.ReadDir(usbRoot)
	if err != nil {
		return result, fmt.Errorf("read USB topology: %w", err)
	}
	var usbNames []string
	for _, entry := range entries {
		devicePath := filepath.Join(usbRoot, entry.Name())
		vendor, vendorErr := readTrimmedFile(filepath.Join(devicePath, "idVendor"))
		product, productErr := readTrimmedFile(filepath.Join(devicePath, "idProduct"))
		if vendorErr == nil && productErr == nil &&
			strings.EqualFold(vendor, djiVendorID) && strings.EqualFold(product, djiProductID) {
			usbNames = append(usbNames, entry.Name())
		}
	}
	if targetUSBName != "" {
		found := false
		for _, name := range usbNames {
			if name == targetUSBName {
				found = true
				break
			}
		}
		if !found {
			return result, fmt.Errorf("DJI %s:%s USB device %s is not present", djiVendorID, djiProductID, targetUSBName)
		}
		usbNames = []string{targetUSBName}
	} else if len(usbNames) != 1 {
		return result, fmt.Errorf("expected exactly one DJI %s:%s USB device, found %d", djiVendorID, djiProductID, len(usbNames))
	}
	result.USBName = usbNames[0]
	result.Interface = fmt.Sprintf("%s:1.%d", result.USBName, djiQMIIndex)
	devicePath := filepath.Join(usbRoot, result.USBName)
	interfacePath := filepath.Join(usbRoot, result.Interface)
	if _, err := os.Stat(interfacePath); err != nil {
		return result, fmt.Errorf("DJI QMI interface %s unavailable: %w", result.Interface, err)
	}

	busNumber, err := readUSBNumber(filepath.Join(devicePath, "busnum"))
	if err != nil {
		return result, err
	}
	deviceNumber, err := readUSBNumber(filepath.Join(devicePath, "devnum"))
	if err != nil {
		return result, err
	}
	result.USBDevice = filepath.Join(devRoot, "bus", "usb", fmt.Sprintf("%03d", busNumber), fmt.Sprintf("%03d", deviceNumber))

	driversRoot := filepath.Join(sysRoot, "bus", "usb", "drivers")
	if err := ensureUSBDriverLoaded(ctx, driversRoot, "qmi_wwan", "qmi_wwan"); err != nil {
		return result, err
	}
	if err := ensureUSBDriverLoaded(ctx, driversRoot, "option", "option"); err != nil {
		return result, err
	}

	// qmi_wwan's USB dynamic ID is device-wide. Leaving it installed makes it
	// probe every vendor-specific interface after a USBIP reconnect; on this DJI
	// composition that can turn interfaces 1-3 into bogus cdc-wdm devices and
	// remove the AT port. Remove it before detaching anything, then add it only
	// briefly below while interface 4 is the sole unbound interface.
	qmiDriverRoot := filepath.Join(driversRoot, "qmi_wwan")
	if err := removeDynamicUSBID(qmiDriverRoot, djiVendorID+" "+djiProductID); err != nil {
		return result, fmt.Errorf("remove broad DJI qmi_wwan dynamic ID: %w", err)
	}

	serialInterfaces, serialDevices, atDevice, err := bindDJISerialInterfaces(ctx, sysRoot, devRoot, usbRoot, driversRoot, result.USBName)
	if err != nil {
		return result, err
	}
	result.SerialInterfaces = serialInterfaces
	result.SerialDevices = serialDevices
	result.ATDevice = atDevice

	result.OriginalDriver = usbInterfaceDriver(interfacePath)
	if result.OriginalDriver != "" && result.OriginalDriver != "option" && result.OriginalDriver != "qmi_wwan" {
		return result, fmt.Errorf("refusing to replace unexpected interface driver %q", result.OriginalDriver)
	}

	interfaceDetached := false
	restoreOriginal := func() {
		if !interfaceDetached {
			return
		}
		if currentDriver := usbInterfaceDriver(interfacePath); currentDriver != "" {
			_ = writeSysfs(filepath.Join(driversRoot, currentDriver, "unbind"), result.Interface)
		}
		switch result.OriginalDriver {
		case "qmi_wwan":
			_ = bindDJIQMIInterface(qmiDriverRoot, interfacePath, result.Interface)
		case "option":
			_ = writeSysfs(filepath.Join(driversRoot, result.OriginalDriver, "bind"), result.Interface)
		}
	}
	defer func() {
		if returnErr != nil {
			restoreOriginal()
		}
	}()
	if result.OriginalDriver != "" {
		if err := writeSysfs(filepath.Join(driversRoot, result.OriginalDriver, "unbind"), result.Interface); err != nil {
			return result, fmt.Errorf("unbind %s from %s: %w", result.OriginalDriver, result.Interface, err)
		}
		interfaceDetached = true
	}
	if err := assertUSBDTR(result.USBDevice, djiQMIIndex); err != nil {
		return result, err
	}

	if err := bindDJIQMIInterface(qmiDriverRoot, interfacePath, result.Interface); err != nil {
		return result, err
	}

	deadline := time.Now().Add(2 * time.Second)
	for {
		result.ControlDevice = firstDeviceNode(filepath.Join(interfacePath, "usbmisc"), devRoot, "cdc-wdm")
		result.NetworkInterface = firstEntryName(filepath.Join(interfacePath, "net"), "")
		if result.ControlDevice != "" {
			break
		}
		if err := ctx.Err(); err != nil {
			return result, err
		}
		if time.Now().After(deadline) {
			return result, fmt.Errorf("qmi_wwan bound but no cdc-wdm node appeared for %s", result.Interface)
		}
		time.Sleep(25 * time.Millisecond)
	}
	// The requested driver topology is now established. A later DMS timeout is
	// a QMI/USBIP readiness problem, so do not roll interface 4 back to option.
	interfaceDetached = false
	result.QMIProbe, returnErr = probeDJIQMIReady(ctx, qmicli, result.ControlDevice)
	if returnErr != nil {
		return result, returnErr
	}
	return result, nil
}

// probeDJIQMIReady runs the DMS operating-mode probe that proves the QMI
// control channel answers after a DTR wake. Right after a rebind the QDC507
// baseband may still be mid-restart: its first responses arrive as an endpoint
// hangup or a QMI operation timeout rather than a clean operating-mode value
// (community measurements put the readiness window at roughly 10-50 seconds).
// Probe failures that look like "not ready yet" are retried until the modem
// really answers or the surrounding repair context budget runs out.
func probeDJIQMIReady(ctx context.Context, qmicli, controlDevice string) (string, error) {
	probeTimeout := 8 * time.Second
	retryDelay := 3 * time.Second
	for {
		probeContext, cancelProbe := context.WithTimeout(ctx, probeTimeout)
		output, probeErr := exec.CommandContext(probeContext, qmicli, "-d", controlDevice, "--dms-get-operating-mode").CombinedOutput()
		probeContextErr := probeContext.Err()
		cancelProbe()
		lastOutput := strings.TrimSpace(string(output))
		if probeErr == nil {
			return lastOutput, nil
		}
		if probeContextErr != nil {
			probeErr = errors.Join(probeErr, probeContextErr)
		}
		if !djiQMIReadyTransient(probeErr, lastOutput) {
			return lastOutput, fmt.Errorf("DMS readiness check after DTR repair: %w: %s", probeErr, lastOutput)
		}
		if ctx.Err() != nil {
			return lastOutput, fmt.Errorf("DMS readiness check after DTR repair: %w: %s",
				errors.Join(probeErr, ctx.Err()), lastOutput)
		}
		timer := time.NewTimer(retryDelay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return lastOutput, fmt.Errorf("DMS readiness check after DTR repair: %w: %s",
				errors.Join(probeErr, ctx.Err()), lastOutput)
		case <-timer.C:
		}
	}
}

// djiQMIReadyTransient reports whether a qmicli DMS failure is the baseband's
// "still waking up" signature rather than a real binding problem. Endpoint
// disconnects and transaction timeouts reappear for tens of seconds after a
// module soft-restart, so the readiness probe must retry them instead of
// reporting a failed repair.
func djiQMIReadyTransient(err error, output string) bool {
	blob := strings.ToLower(fmt.Sprintf("%s %s", err, output))
	for _, marker := range []string{
		"endpoint hangup",
		"qmi operation timed out",
		"transaction timed out",
		"timed out",
		"device or resource busy",
		"not connected",
	} {
		if strings.Contains(blob, marker) {
			return true
		}
	}
	return false
}

func bindDJIQMIInterface(driverRoot, interfacePath, interfaceName string) (returnErr error) {
	bindPath := filepath.Join(driverRoot, "bind")
	dynamicIDAdded := false
	defer func() {
		if dynamicIDAdded {
			removeErr := removeDynamicUSBID(driverRoot, djiVendorID+" "+djiProductID)
			if returnErr == nil && removeErr != nil {
				returnErr = fmt.Errorf("remove temporary DJI qmi_wwan dynamic ID: %w", removeErr)
			}
		}
	}()
	if err := writeSysfs(bindPath, interfaceName); err != nil {
		newIDErr := writeSysfs(filepath.Join(driverRoot, "new_id"), djiVendorID+" "+djiProductID)
		if newIDErr != nil && !errors.Is(newIDErr, syscall.EEXIST) {
			return fmt.Errorf("register DJI qmi_wwan dynamic ID after bind failure %v: %w", err, newIDErr)
		}
		dynamicIDAdded = true
		if usbInterfaceDriver(interfacePath) != "qmi_wwan" {
			if retryErr := writeSysfs(bindPath, interfaceName); retryErr != nil {
				return fmt.Errorf("bind qmi_wwan to %s: %w", interfaceName, retryErr)
			}
		}
	}
	if driver := usbInterfaceDriver(interfacePath); driver != "qmi_wwan" {
		return fmt.Errorf("interface %s driver is %q after qmi_wwan bind", interfaceName, driver)
	}
	return nil
}

func ensureUSBDriverLoaded(ctx context.Context, driversRoot, driverName, moduleName string) error {
	if _, err := os.Stat(filepath.Join(driversRoot, driverName)); err == nil {
		return nil
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("inspect %s driver: %w", driverName, err)
	}
	modprobe, err := exec.LookPath("modprobe")
	if err != nil {
		return fmt.Errorf("%s is not loaded and modprobe is unavailable", driverName)
	}
	if output, loadErr := exec.CommandContext(ctx, modprobe, moduleName).CombinedOutput(); loadErr != nil {
		return fmt.Errorf("load %s: %w: %s", moduleName, loadErr, strings.TrimSpace(string(output)))
	}
	if _, err := os.Stat(filepath.Join(driversRoot, driverName)); err != nil {
		return fmt.Errorf("%s driver is unavailable after loading module %s: %w", driverName, moduleName, err)
	}
	return nil
}

func bindDJISerialInterfaces(
	ctx context.Context,
	sysRoot, devRoot, usbRoot, driversRoot, usbName string,
) ([]string, []string, string, error) {
	interfaceNames := make([]string, 0, djiLastSerialIndex-djiFirstSerialIndex+1)
	interfacePaths := make([]string, 0, cap(interfaceNames))
	needsDynamicID := false
	for index := djiFirstSerialIndex; index <= djiLastSerialIndex; index++ {
		name := fmt.Sprintf("%s:1.%d", usbName, index)
		path := filepath.Join(usbRoot, name)
		if _, err := os.Stat(path); err != nil {
			return nil, nil, "", fmt.Errorf("DJI serial interface %s unavailable: %w", name, err)
		}
		driver := usbInterfaceDriver(path)
		if driver != "" && driver != "option" && driver != "qmi_wwan" {
			return nil, nil, "", fmt.Errorf("refusing to replace unexpected driver %q on %s", driver, name)
		}
		interfaceNames = append(interfaceNames, name)
		interfacePaths = append(interfacePaths, path)
		needsDynamicID = needsDynamicID || driver != "option"
	}

	if needsDynamicID {
		// Detach every false QMI claim before option's new_id triggers probing.
		for index, path := range interfacePaths {
			if usbInterfaceDriver(path) != "qmi_wwan" {
				continue
			}
			if err := writeSysfs(filepath.Join(driversRoot, "qmi_wwan", "unbind"), interfaceNames[index]); err != nil {
				return nil, nil, "", fmt.Errorf("unbind qmi_wwan from serial interface %s: %w", interfaceNames[index], err)
			}
		}

		optionSerialRoot := filepath.Join(sysRoot, "bus", "usb-serial", "drivers", "option1")
		if _, err := os.Stat(optionSerialRoot); err != nil {
			return nil, nil, "", fmt.Errorf("option USB-serial driver is unavailable: %w", err)
		}
		if err := writeSysfs(filepath.Join(optionSerialRoot, "new_id"), djiVendorID+" "+djiProductID); err != nil && !errors.Is(err, syscall.EEXIST) {
			return nil, nil, "", fmt.Errorf("register DJI option dynamic ID: %w", err)
		}

		for index, path := range interfacePaths {
			if usbInterfaceDriver(path) == "option" {
				continue
			}
			if err := writeSysfs(filepath.Join(driversRoot, "option", "bind"), interfaceNames[index]); err != nil {
				return nil, nil, "", fmt.Errorf("bind option to %s: %w", interfaceNames[index], err)
			}
		}
	}
	for index, path := range interfacePaths {
		if driver := usbInterfaceDriver(path); driver != "option" {
			return nil, nil, "", fmt.Errorf("serial interface %s driver is %q after option bind", interfaceNames[index], driver)
		}
	}

	deadline := time.Now().Add(2 * time.Second)
	serialDevices := make([]string, len(interfacePaths))
	for {
		complete := true
		for index, path := range interfacePaths {
			name := firstEntryName(path, "ttyUSB")
			if name == "" {
				complete = false
				continue
			}
			serialDevices[index] = filepath.Join(devRoot, name)
		}
		if complete {
			break
		}
		if err := ctx.Err(); err != nil {
			return nil, nil, "", err
		}
		if time.Now().After(deadline) {
			return nil, nil, "", fmt.Errorf("option bound but not all ttyUSB nodes appeared for %s", usbName)
		}
		time.Sleep(25 * time.Millisecond)
	}
	return interfaceNames, serialDevices, serialDevices[djiATIndex-djiFirstSerialIndex], nil
}

func removeDynamicUSBID(driverRoot, id string) error {
	path := filepath.Join(driverRoot, "remove_id")
	if _, err := os.Stat(path); err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	if err := writeSysfs(path, id); err != nil && !errors.Is(err, syscall.ENODEV) && !errors.Is(err, syscall.ENOENT) {
		return err
	}
	return nil
}

func assertUSBDTR(devicePath string, interfaceIndex int) error {
	fd, err := unix.Open(devicePath, unix.O_RDWR|unix.O_CLOEXEC, 0)
	if err != nil {
		return fmt.Errorf("open USB device %s: %w", devicePath, err)
	}
	defer unix.Close(fd)
	if err := setUSBControlLineState(fd, interfaceIndex, false); err != nil {
		return fmt.Errorf("clear CDC DTR on %s interface %d: %w", devicePath, interfaceIndex, err)
	}
	time.Sleep(50 * time.Millisecond)
	if err := setUSBControlLineState(fd, interfaceIndex, true); err != nil {
		return fmt.Errorf("assert CDC DTR on %s interface %d: %w", devicePath, interfaceIndex, err)
	}
	// QDC507 acknowledges the control transfer before its QMI firmware is ready.
	time.Sleep(time.Second)
	return nil
}

func setUSBControlLineState(fd, interfaceIndex int, dtr bool) error {
	var value uint16
	if dtr {
		value = 1 // USB_CDC_CTRL_DTR
	}
	transfer := usbControlTransfer{
		RequestType: 0x21, // host-to-device, class, interface
		Request:     0x22, // USB_CDC_REQ_SET_CONTROL_LINE_STATE
		Value:       value,
		Index:       uint16(interfaceIndex),
		Timeout:     5000,
	}
	const ioctlDirectionReadWrite = uintptr(3)
	request := ioctlDirectionReadWrite<<30 |
		uintptr(unsafe.Sizeof(transfer))<<16 |
		uintptr('U')<<8
	_, _, errno := unix.Syscall(unix.SYS_IOCTL, uintptr(fd), request, uintptr(unsafe.Pointer(&transfer)))
	if errno != 0 {
		return errno
	}
	return nil
}

func readTrimmedFile(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(data)), nil
}

func readUSBNumber(path string) (int, error) {
	value, err := readTrimmedFile(path)
	if err != nil {
		return 0, fmt.Errorf("read %s: %w", filepath.Base(path), err)
	}
	number, err := strconv.Atoi(value)
	if err != nil || number < 1 || number > 999 {
		return 0, fmt.Errorf("invalid %s %q", filepath.Base(path), value)
	}
	return number, nil
}

func usbInterfaceDriver(interfacePath string) string {
	resolved, err := filepath.EvalSymlinks(filepath.Join(interfacePath, "driver"))
	if err != nil {
		return ""
	}
	return filepath.Base(resolved)
}

func writeSysfs(path, value string) error {
	file, err := os.OpenFile(path, os.O_WRONLY, 0)
	if err != nil {
		return err
	}
	_, writeErr := file.WriteString(value)
	closeErr := file.Close()
	return errors.Join(writeErr, closeErr)
}

func firstDeviceNode(directory, devRoot, prefix string) string {
	name := firstEntryName(directory, prefix)
	if name == "" {
		return ""
	}
	return filepath.Join(devRoot, name)
}

func firstEntryName(directory, prefix string) string {
	entries, err := os.ReadDir(directory)
	if err != nil {
		return ""
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), prefix) {
			return entry.Name()
		}
	}
	return ""
}
