package main

import (
	"testing"

	"vocat/internal/device"
)

func TestDJITopologyMisboundAcceptsFactoryComposition(t *testing.T) {
	topology := device.DJIUSBTopology{
		USBName: "1-1",
		Interfaces: []device.DJIUSBInterface{
			{Index: 0, Driver: "option"},
			{Index: 1, Driver: "option"},
			{Index: 2, Driver: "option"},
			{Index: 3, Driver: "option"},
			{Index: 4, Driver: "qmi_wwan"},
		},
	}
	if djiTopologyMisbound(topology) {
		t.Fatal("factory composition 0-3=option, 4=qmi_wwan reported as misbound")
	}
}

func TestDJITopologyMisboundDetectsDriverTakeover(t *testing.T) {
	cases := []device.DJIUSBTopology{
		{
			// option stole the QMI interface (the classic failure mode).
			Interfaces: []device.DJIUSBInterface{
				{Index: 0, Driver: "option"},
				{Index: 4, Driver: "option"},
			},
		},
		{
			// qmi_wwan stole a serial interface.
			Interfaces: []device.DJIUSBInterface{
				{Index: 2, Driver: "qmi_wwan"},
				{Index: 4, Driver: "qmi_wwan"},
			},
		},
	}
	for index, topology := range cases {
		if !djiTopologyMisbound(topology) {
			t.Errorf("case %d: driver takeover not detected: %+v", index, topology)
		}
	}
}

func TestDJITopologyMisboundIgnoresTransientStates(t *testing.T) {
	topology := device.DJIUSBTopology{
		USBName: "1-1",
		Interfaces: []device.DJIUSBInterface{
			{Index: 0, Driver: "missing"}, // freshly re-enumerating
			{Index: 1, Driver: ""},        // not yet bound
			{Index: 4, Driver: "qmi_wwan"},
		},
	}
	if djiTopologyMisbound(topology) {
		t.Fatal("transient missing/unbound interfaces must not count as misbound")
	}
}