//go:build linux

package device

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"golang.org/x/sys/unix"
)

// djiUeventBufferSize is larger than the maximum single uevent payload so a
// burst of interface events cannot truncate the enclosing device event.
const djiUeventBufferSize = 64 * 1024

// djiUeventDebounce is how long the watch waits after the first matching DJI
// event before firing the callback. A module reboot re-enumerates through a
// burst of add/remove/change events with separate interface sub-events; the
// quiet window coalesces that storm into one discovery pass so the scan runs
// against fully enumerated interfaces instead of a half-visible device.
const djiUeventDebounce = 500 * time.Millisecond

// WatchDJIUSBEvents subscribes to kernel uevents and invokes onEvent whenever
// a DJI 4G module (2ca3:4006) is added, removed, or changes at the USB device
// level. It blocks until ctx is cancelled. A 500 ms coalescing window folds a
// re-enumeration burst into a single callback, and callbacks are non-
// reentrant: if one is still running, a new event is dropped instead of
// stacking concurrent discovery passes. A missing subscription is always
// recoverable — callers keep their existing polling path and treat an error
// as "watch unavailable".
func WatchDJIUSBEvents(ctx context.Context, onEvent func()) error {
	if onEvent == nil {
		return errors.New("DJI uevent callback is nil")
	}
	fd, err := unix.Socket(unix.AF_NETLINK, unix.SOCK_DGRAM|unix.SOCK_CLOEXEC, unix.NETLINK_KOBJECT_UEVENT)
	if err != nil {
		return fmt.Errorf("open uevent netlink socket: %w", err)
	}
	defer unix.Close(fd)
	if err := unix.Bind(fd, &unix.SockaddrNetlink{Family: unix.AF_NETLINK, Groups: 1}); err != nil {
		return fmt.Errorf("join kernel uevent group: %w", err)
	}

	var drainMu sync.Mutex
	draining := false
	drain := func() {
		drainMu.Lock()
		already := draining
		draining = true
		drainMu.Unlock()
		if already {
			return
		}
		onEvent()
		drainMu.Lock()
		draining = false
		drainMu.Unlock()
	}

	events := make(chan []byte, 16)
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		buffer := make([]byte, djiUeventBufferSize)
		for {
			count, _, readErr := unix.Recvfrom(fd, buffer, 0)
			select {
			case <-stop:
				return
			default:
			}
			if readErr != nil {
				return
			}
			payload := make([]byte, count)
			copy(payload, buffer[:count])
			select {
			case events <- payload:
			default:
			}
		}
	}()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case payload := <-events:
			// Coalesce a re-enumeration burst: keep folding matching events
			// into a pending debounce window, then fire the callback once the
			// storm goes quiet or the window expires.
			drainDJIUeventBurst(ctx, events, djiUeventDebounce, payload, drain)
		}
	}
}

// drainDJIUeventBurst consumes the first matching uevent, folds any further
// matching uevents that arrive within each debounce window into the same
// callback, and finally runs drain(). The quiet gap after the re-enumeration
// storm guarantees the callback sees fully enumerated interfaces instead of a
// half-visible device.
func drainDJIUeventBurst(
	ctx context.Context,
	events <-chan []byte,
	debounce time.Duration,
	first []byte,
	drain func(),
) {
	if !djiUeventMatch(first) {
		return
	}
	timer := time.NewTimer(debounce)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case laterPayload := <-events:
			if !djiUeventMatch(laterPayload) {
				continue
			}
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			timer.Reset(debounce)
		case <-timer.C:
			drain()
			return
		}
	}
}
