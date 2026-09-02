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
// USB identity.
func RepairDJIQMI(ctx context.Context) (QMIRepairResult, error) {
	return repairDJIQMI(ctx)
}