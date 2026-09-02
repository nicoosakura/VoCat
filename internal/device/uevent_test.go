package device

import "testing"

func TestDJIUeventMatch(t *testing.T) {
	tests := []struct {
		name    string
		payload string
		want    bool
	}{
		{
			name:    "DJI device add",
			payload: "ACTION=add\x00DEVPATH=/devices/pci0000:00/0000:00:14.0/usb1/1-4.3\x00SUBSYSTEM=usb\x00DEVTYPE=usb_device\x00PRODUCT=2ca3/4006/0100\x00TYPE=0/0/0\x00",
			want:    true,
		},
		{
			name:    "DJI device remove",
			payload: "ACTION=remove\x00DEVPATH=/devices/pci0000:00/usb1/1-4.3\x00SUBSYSTEM=usb\x00PRODUCT=2ca3/4006/0100\x00",
			want:    true,
		},
		{
			name:    "DJI device change via ID aliases",
			payload: "ACTION=change\x00DEVPATH=/devices/pci0000:00/usb1/1-4.3\x00SUBSYSTEM=usb\x00ID_VENDOR_ID=2CA3\x00ID_MODEL_ID=4006\x00",
			want:    true,
		},
		{
			name:    "upper-case PRODUCT still matches",
			payload: "ACTION=add\x00DEVPATH=/devices/usb1/1-4.3\x00PRODUCT=2CA3/4006/0100\x00",
			want:    true,
		},
		{
			name:    "other USB vendor",
			payload: "ACTION=add\x00DEVPATH=/devices/pci0000:00/usb1/1-2\x00SUBSYSTEM=usb\x00PRODUCT=2c7c/0125/0306\x00",
			want:    false,
		},
		{
			name:    "loose 2ca3 substring in an unrelated field must not match",
			payload: "ACTION=add\x00DEVPATH=/devices/usb1/1-2\x00SUBSYSTEM=usb\x00PRODUCT=2c7c/0125/0406\x00MODALIAS=foo2ca3bar4006\x00",
			want:    false,
		},
		{
			name:    "matching vendor but wrong model ID alone must not match",
			payload: "ACTION=add\x00DEVPATH=/devices/usb1/1-2\x00ID_VENDOR_ID=2CA3\x00ID_MODEL_ID=0125\x00",
			want:    false,
		},
		{
			name:    "matching model but no vendor field must not match",
			payload: "ACTION=add\x00DEVPATH=/devices/usb1/1-2\x00ID_MODEL_ID=4006\x00",
			want:    false,
		},
		{
			name:    "interface-level change without product IDs",
			payload: "ACTION=change\x00DEVPATH=/devices/pci0000:00/usb1/1-4.3/1-4.3:1.2\x00SUBSYSTEM=usb\x00INTERFACE=255/255/255\x00",
			want:    false,
		},
		{
			name:    "empty payload",
			payload: "",
			want:    false,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := djiUeventMatch([]byte(test.payload)); got != test.want {
				t.Fatalf("djiUeventMatch() = %v, want %v", got, test.want)
			}
		})
	}
}
