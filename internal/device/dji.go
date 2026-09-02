package device

import (
	"context"
	"errors"
)

var (
	// ErrDJIRepairUnsupported reports that the host platform has no DJI binding
	// repair implementation. Only Linux exposes the sysfs and USB control
	// transfers the repair sequence needs.
	ErrDJIRepairUnsupported = errors.New("DJI QMI repair is supported only on Linux")

	// ErrDJIRepairNotRoot reports that the repair requires root because it
	// rebinds sysfs USB drivers and opens /dev/bus/usb device nodes.
	ErrDJIRepairNotRoot = errors.New("DJI QMI repair requires root access to /sys and /dev")

	// ErrDJITopologyUnsupported reports that USB topology inspection is not
	// implemented on this platform. It is a read-only diagnostic, so it carries
	// no red-line risk.
	ErrDJITopologyUnsupported = errors.New("DJI USB topology inspection is supported only on Linux")
)

// QMIRepairResult describes the state of a DJI 4G module (USB 2ca3:4006) after
// its factory AT/QMI interface bindings have been restored. The same result is
// used by the CLI doctor, the on-demand HTTP repair endpoint, and the automatic
// discovery repair path.
type QMIRepairResult struct {
	USBName          string   `json:"usb_name"`
	Interface        string   `json:"interface"`
	USBDevice        string   `json:"usb_device"`
	OriginalDriver   string   `json:"original_driver,omitempty"`
	SerialInterfaces []string `json:"serial_interfaces,omitempty"`
	SerialDevices    []string `json:"serial_devices,omitempty"`
	ATDevice         string   `json:"at_device,omitempty"`
	ControlDevice    string   `json:"control_device"`
	NetworkInterface string   `json:"network_interface,omitempty"`
	QMIProbe         string   `json:"qmi_probe"`
	Attempts         int      `json:"attempts"`
}

// RepairDJIQMI restores the factory 2ca3:4006 AT/QMI USB binding on a DJI 4G
// module and wakes its QMI control channel. It requires Linux plus root access
// to sysfs and the USB device node, and returns a descriptive error on any
// other platform. Implementations must not write modem NV memory or change the
// USB identity. Only the automatic and on-demand repair paths may call this;
// it never rewrites AT+QCFG settings.
func RepairDJIQMI(ctx context.Context) (QMIRepairResult, error) {
	return repairDJIQMI(ctx)
}

// RepairDJIQMIFor restores the factory AT/QMI USB binding on one specific DJI
// 4G module, identified by its sysfs USB device path (for example
// "/sys/bus/usb/devices/1-4.3"). Per-device targeting lets discovery repair
// several DJI modules independently; see the Linux implementation.
func RepairDJIQMIFor(ctx context.Context, usbPath string) (QMIRepairResult, error) {
	return repairDJIQMIFor(ctx, usbPath)
}

// DJIUSBInterface describes one USB interface of a DJI 4G module and the
// kernel driver currently attached to it.
type DJIUSBInterface struct {
	Index            int    `json:"index"`
	Driver           string `json:"driver"`
	SerialNode       string `json:"serial_node,omitempty"`
	QMINode          string `json:"qmi_node,omitempty"`
	NetworkInterface string `json:"network_interface,omitempty"`
}

// DJIUSBTopology is a read-only snapshot of the DJI 4G module's five
// interfaces (indexes 0-4), used by the device detail card for troubleshooting.
type DJIUSBTopology struct {
	USBName    string            `json:"usb_name"`
	Interfaces []DJIUSBInterface `json:"interfaces"`
}

// DJITopology reads the current driver binding and device node layout of a DJI
// 4G module without changing anything. It is diagnostic-only and never writes
// sysfs or NV memory.
func DJITopology(sysRoot, usbPath string) (DJIUSBTopology, error) {
	return djiTopology(sysRoot, usbPath)
}
