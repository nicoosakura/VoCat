package device

import (
	"bytes"
	"strings"
)

// djiUeventMatch reports whether a kernel uevent payload concerns the DJI 4G
// module. uevent payloads are NUL-separated key=value properties; a USB device
// event carries PRODUCT=vendor/product/version (2ca3/4006/xxxx) plus often
// ID_VENDOR_ID / ID_MODEL_ID aliases. Matching is exact against those product
// fields rather than a loose substring, so a DIAG or unrelated device whose
// descriptor happens to mention "2ca3" or "4006" cannot trigger a rescan.
// Interface-level bind/unbind events do not carry product IDs and never match.
func djiUeventMatch(payload []byte) bool {
	if len(payload) == 0 {
		return false
	}
	productMatch := false
	idVendor := ""
	idModel := ""
	for _, field := range bytes.Split(payload, []byte{0}) {
		key, value, ok := bytes.Cut(field, []byte("="))
		if !ok {
			continue
		}
		switch string(key) {
		case "PRODUCT":
			parts := strings.Split(string(value), "/")
			if len(parts) >= 2 &&
				strings.EqualFold(strings.TrimSpace(parts[0]), djiVendorID) &&
				strings.EqualFold(strings.TrimSpace(parts[1]), djiProductID) {
				productMatch = true
			}
		case "ID_VENDOR_ID", "ID_VENDOR":
			idVendor = strings.TrimSpace(string(value))
		case "ID_MODEL_ID", "ID_MODEL":
			idModel = strings.TrimSpace(string(value))
		}
	}
	// The kernel's PRODUCT=vendor/product/[version] field is authoritative.
	// The ID_VENDOR_ID / ID_MODEL_ID pair must agree with each other, so a
	// single colliding field can never misclassify an unrelated device.
	return productMatch ||
		(strings.EqualFold(idVendor, djiVendorID) && strings.EqualFold(idModel, djiProductID))
}
