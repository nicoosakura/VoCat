//go:build linux

package device

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func djiTopology(sysRoot, usbPath string) (DJIUSBTopology, error) {
	usbRoot := filepath.Join(sysRoot, "bus", "usb", "devices")
	usbName := filepath.Base(filepath.Clean(usbPath))
	if usbPath == "" || usbName == "." || usbName == string(filepath.Separator) {
		return DJIUSBTopology{}, errors.New("DJI module USB path is required for topology inspection")
	}
	devicePath := filepath.Join(usbRoot, usbName)
	vendor, vendorErr := readTrimmedFile(filepath.Join(devicePath, "idVendor"))
	product, productErr := readTrimmedFile(filepath.Join(devicePath, "idProduct"))
	if vendorErr != nil || productErr != nil ||
		!strings.EqualFold(vendor, djiVendorID) || !strings.EqualFold(product, djiProductID) {
		return DJIUSBTopology{}, fmt.Errorf(
			"USB device %s is not a DJI %s:%s module (vendor %q product %q)",
			usbName, djiVendorID, djiProductID, vendor, product,
		)
	}
	result := DJIUSBTopology{USBName: usbName}
	for index := djiFirstSerialIndex; index <= djiQMIIndex; index++ {
		iface := DJIUSBInterface{Index: index}
		interfacePath := filepath.Join(usbRoot, fmt.Sprintf("%s:1.%d", usbName, index))
		if info, err := os.Stat(interfacePath); err != nil || !info.IsDir() {
			iface.Driver = "missing"
			result.Interfaces = append(result.Interfaces, iface)
			continue
		}
		iface.Driver = usbInterfaceDriver(interfacePath)
		iface.SerialNode = firstEntryName(interfacePath, "ttyUSB")
		iface.QMINode = firstEntryName(filepath.Join(interfacePath, "usbmisc"), "cdc-wdm")
		iface.NetworkInterface = firstEntryName(filepath.Join(interfacePath, "net"), "")
		result.Interfaces = append(result.Interfaces, iface)
	}
	return result, nil
}
