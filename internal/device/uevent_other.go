//go:build !linux

package device

import (
	"context"
	"errors"
)

// WatchDJIUSBEvents is unavailable outside Linux, where kernel uevents cannot
// be subscribed. Callers keep their polling-based discovery path.
func WatchDJIUSBEvents(context.Context, func()) error {
	return errors.New("DJI uevent watch is supported only on Linux")
}
