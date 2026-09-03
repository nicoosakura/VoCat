package server

import (
	"context"
	"testing"

	"vocat/internal/device"
	"vocat/internal/modem"
	"vocat/internal/store"
)

func TestDJIModuleTemperatureBestEffort(t *testing.T) {
	ctx := context.Background()
	const deviceID = "dji-1"
	config := store.Device{ID: deviceID, USBPath: "1-4.3"}

	// No device controller at all: never fail, just report nil.
	server := &Server{}
	if temperature := server.djiModuleTemperature(ctx, config); temperature != nil {
		t.Fatalf("temperature with nil controller = %v, want nil", *temperature)
	}

	// Configured but not physically present: nil as well.
	server = &Server{devices: fakeDeviceController{entry: device.Device{ID: deviceID, Discovered: false}}}
	if temperature := server.djiModuleTemperature(ctx, config); temperature != nil {
		t.Fatalf("temperature for offline device = %v, want nil", *temperature)
	}

	// Physically present with a healthy AT+QTEMP response.
	server = &Server{devices: fakeDeviceController{
		entry: device.Device{ID: deviceID, Discovered: true},
		atResponse: modem.Response{
			Lines: []string{"+QTEMP: 0,38"},
			Final: "OK",
		},
	}}
	if temperature := server.djiModuleTemperature(ctx, config); temperature == nil || *temperature != 38 {
		t.Fatalf("temperature = %v, want 38", temperature)
	}

	// Firmware rejects the command: report nil, not an error.
	server = &Server{devices: fakeDeviceController{
		entry:      device.Device{ID: deviceID, Discovered: true},
		atErr:      device.ErrUnsupportedCapability,
		atResponse: modem.Response{Final: "ERROR"},
	}}
	if temperature := server.djiModuleTemperature(ctx, config); temperature != nil {
		t.Fatalf("temperature on unsupported command = %v, want nil", *temperature)
	}
}
