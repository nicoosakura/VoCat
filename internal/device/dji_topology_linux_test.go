//go:build linux

package device

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestDJITopologyReadsInterfaceBindings(t *testing.T) {
	root := t.TempDir()
	sysRoot := filepath.Join(root, "sys")
	usbRoot := filepath.Join(sysRoot, "bus", "usb", "devices")
	driversRoot := filepath.Join(sysRoot, "bus", "usb", "drivers")
	if err := os.MkdirAll(driversRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	optionRoot := filepath.Join(driversRoot, "option")
	qmiRoot := filepath.Join(driversRoot, "qmi_wwan")
	for _, driverRoot := range []string{optionRoot, qmiRoot} {
		if err := os.MkdirAll(driverRoot, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.MkdirAll(usbRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(usbRoot, "1-1"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(usbRoot, "1-1", "idVendor"), []byte("2ca3\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(usbRoot, "1-1", "idProduct"), []byte("4006\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	for index := 0; index <= 3; index++ {
		interfacePath := filepath.Join(usbRoot, fmt.Sprintf("1-1:1.%d", index))
		if err := os.MkdirAll(filepath.Join(interfacePath, fmt.Sprintf("ttyUSB%d", index)), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(optionRoot, filepath.Join(interfacePath, "driver")); err != nil {
			t.Fatal(err)
		}
	}
	qmiInterfacePath := filepath.Join(usbRoot, "1-1:1.4")
	if err := os.MkdirAll(filepath.Join(qmiInterfacePath, "usbmisc", "cdc-wdm0"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(qmiInterfacePath, "net", "wwan0"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(qmiRoot, filepath.Join(qmiInterfacePath, "driver")); err != nil {
		t.Fatal(err)
	}

	topology, err := DJITopology(sysRoot, filepath.Join(usbRoot, "1-1"))
	if err != nil {
		t.Fatalf("DJITopology() error = %v", err)
	}
	if topology.USBName != "1-1" || len(topology.Interfaces) != 5 {
		t.Fatalf("topology = %#v, want USBName 1-1 with 5 interfaces", topology)
	}
	if topology.Interfaces[0].Driver != "option" || topology.Interfaces[0].SerialNode != "ttyUSB0" {
		t.Fatalf("interface 0 = %#v, want option/ttyUSB0", topology.Interfaces[0])
	}
	if topology.Interfaces[2].Driver != "option" || topology.Interfaces[2].SerialNode != "ttyUSB2" {
		t.Fatalf("interface 2 = %#v, want option/ttyUSB2 (AT)", topology.Interfaces[2])
	}
	if topology.Interfaces[4].Driver != "qmi_wwan" ||
		topology.Interfaces[4].QMINode != "cdc-wdm0" ||
		topology.Interfaces[4].NetworkInterface != "wwan0" {
		t.Fatalf("interface 4 = %#v, want qmi_wwan/cdc-wdm0/wwan0", topology.Interfaces[4])
	}

	// A USB path that does not point at a DJI device must fail cleanly.
	other := filepath.Join(usbRoot, "2-1")
	if err := os.MkdirAll(other, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(other, "idVendor"), []byte("2c7c\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := DJITopology(sysRoot, other); err == nil {
		t.Fatal("DJITopology(non-DJI device) unexpectedly succeeded")
	}
}
