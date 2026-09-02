//go:build linux

package device

import (
	"context"
	"sync/atomic"
	"testing"
	"time"
)

func TestDrainDJIUeventBurstCoalescesStormIntoOneCallback(t *testing.T) {
	events := make(chan []byte, 8)
	djiAdd := func(devpath string) []byte {
		return []byte("ACTION=add\x00DEVPATH=" + devpath + "\x00SUBSYSTEM=usb\x00PRODUCT=2ca3/4006/0100\x00")
	}
	// A module reboot fans out several device-level events plus interface
	// sub-events. All matching events inside the debounce window must fold
	// into a single callback.
	events <- djiAdd("usb1/1-4.3")
	events <- []byte("ACTION=change\x00DEVPATH=usb1/1-4.3/1-4.3:1.0\x00SUBSYSTEM=usb\x00")
	events <- djiAdd("usb1/1-4.3")
	close(events)

	var calls atomic.Int32
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	drainDJIUeventBurst(ctx, events, 50*time.Millisecond, djiAdd("usb1/1-4.3"), func() {
		calls.Add(1)
	})
	if got := calls.Load(); got != 1 {
		t.Fatalf("drainDJIUeventBurst fired %d callback(s), want 1", got)
	}
}

func TestDrainDJIUeventBurstIgnoresUnrelatedEvents(t *testing.T) {
	events := make(chan []byte, 8)
	events <- []byte("ACTION=add\x00DEVPATH=usb1/1-2\x00SUBSYSTEM=usb\x00PRODUCT=2c7c/0125/0306\x00")
	close(events)

	var calls atomic.Int32
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	drainDJIUeventBurst(ctx, events, 20*time.Millisecond, []byte("ACTION=remove\x00DEVPATH=usb1/1-9\x00SUBSYSTEM=usb\x00"), func() {
		calls.Add(1)
	})
	if got := calls.Load(); got != 0 {
		t.Fatalf("drainDJIUeventBurst fired %d callback(s) for unrelated events, want 0", got)
	}
}

func TestDrainDJIUeventBurstStopsOnContextCancel(t *testing.T) {
	events := make(chan []byte)
	defer close(events)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	var calls atomic.Int32
	drainDJIUeventBurst(ctx, events, time.Hour, []byte("ACTION=add\x00PRODUCT=2ca3/4006/0100\x00"), func() {
		calls.Add(1)
	})
	if got := calls.Load(); got != 0 {
		t.Fatalf("drainDJIUeventBurst fired %d callback(s) after cancel, want 0", got)
	}
}