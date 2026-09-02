package device

import "strings"

// djiUeventMatch reports whether a kernel uevent payload concerns the DJI 4G
// module. uevent payloads are NUL-separated key=value properties; the USB
// device event includes PRODUCT=2ca3/4006/xxxx (and commonly ID_VENDOR_ID /
// ID_MODEL_ID aliases). Interface-level bind/unbind events do not carry the
// product IDs, so only device-level add/remove/change events match.
func djiUeventMatch(payload []byte) bool {
	text := string(payload)
	return strings.Contains(text, "2ca3") && strings.Contains(text, "4006")
}
