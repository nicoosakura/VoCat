//go:build linux

package device

import (
	"context"
	"errors"
	"fmt"
	"sync"

	"golang.org/x/sys/unix"
)

// djiUeventBufferSize is larger than the maximum single uevent payload so a
// burst of interface events cannot truncate the enclosing device event.
const djiUeventBufferSize = 64 * 1024

// WatchDJIUSBEvents subscribes to kernel uevents and invokes onEvent whenever
// a DJI 4G module (2ca3:4006) is added, removed, or changes at the USB device
// level. It blocks until ctx is cancelled. Callbacks are coalesced: if one is
// still running, a new event is dropped instead of stacking concurrent
// discovery passes. A missing subscription is always recoverable — callers
// keep their existing polling path and treat an error as "watch unavailable".
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
			if !djiUeventMatch(payload) {
				continue
			}
			drain()
		}
	}
}
