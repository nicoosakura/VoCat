package device

import (
	"context"
	"log/slog"
	"testing"
	"time"

	"vocat/internal/modem"
)

func TestDJINeedsRepair(t *testing.T) {
	base := modem.Candidate{
		VendorID:     "2ca3",
		ProductID:    "4006",
		HardwareKind: "usb",
		ATPort:       modem.Port{Path: "/dev/ttyUSB2"},
		QMIControl:   "/dev/cdc-wdm0",
	}
	if djiNeedsRepair(base) {
		t.Fatal("healthy DJI module unexpectedly flagged for repair")
	}

	broken := base
	broken.ATPort = modem.Port{}
	if !djiNeedsRepair(broken) {
		t.Fatal("DJI module without an AT port was not flagged for repair")
	}

	noQMI := base
	noQMI.QMIControl = ""
	if !djiNeedsRepair(noQMI) {
		t.Fatal("DJI module without a QMI node was not flagged for repair")
	}

	withIssue := base
	withIssue.DiscoveryIssue = "at_port_missing"
	if !djiNeedsRepair(withIssue) {
		t.Fatal("DJI module with a discovery issue was not flagged for repair")
	}

	nonDJI := base
	nonDJI.VendorID = "2c7c"
	if djiNeedsRepair(nonDJI) {
		t.Fatal("non-DJI modem unexpectedly flagged for DJI repair")
	}

	reader := base
	reader.HardwareKind = "pcsc"
	reader.ATPort = modem.Port{}
	if djiNeedsRepair(reader) {
		t.Fatal("PC/SC reader unexpectedly flagged for DJI repair")
	}
}

func TestDJIRepairDue(t *testing.T) {
	now := time.Now()
	if !djiRepairDue(time.Time{}, now) {
		t.Fatal("first repair is always due")
	}
	if djiRepairDue(now, now.Add(djiRepairCooldown-time.Second)) {
		t.Fatal("repair retried inside the cooldown window")
	}
	if !djiRepairDue(now, now.Add(djiRepairCooldown)) {
		t.Fatal("repair still throttled after the cooldown window")
	}
}

func TestAutoRepairDJIQMIThrottlesRepeatedAttempts(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	manager := &Manager{
		logger:           slog.New(slog.DiscardHandler),
		djiRepairAttempt: map[string]time.Time{},
	}
	candidate := modem.Candidate{
		ID:             "usb-dji",
		VendorID:       "2ca3",
		ProductID:      "4006",
		HardwareKind:   "usb",
		USBPath:        "1-1",
		DiscoveryIssue: "at_port_missing",
	}
	candidates := []modem.Candidate{candidate}
	if got := manager.autoRepairDJIQMI(context.Background(), candidates); len(got) != 1 {
		t.Fatalf("candidate count = %d, want 1", len(got))
	}
	firstAttempt, ok := manager.djiRepairAttempt["1-1"]
	if !ok || firstAttempt.IsZero() {
		t.Fatal("first repair attempt was not recorded")
	}

	// A second call within the cooldown must not start another repair.
	manager.djiRepairAttempt["1-1"] = time.Now()
	if got := manager.autoRepairDJIQMI(context.Background(), candidates); len(got) != 1 {
		t.Fatalf("throttled candidate count = %d, want 1", len(got))
	}
}

func TestAutoRepairDJIQMIHandlesMultipleDegradedDevices(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	manager := &Manager{
		logger:           slog.New(slog.DiscardHandler),
		djiRepairAttempt: map[string]time.Time{},
	}
	candidates := []modem.Candidate{
		{ID: "a", VendorID: "2ca3", ProductID: "4006", HardwareKind: "usb", USBPath: "1-1", DiscoveryIssue: "at_port_missing"},
		{ID: "b", VendorID: "2ca3", ProductID: "4006", HardwareKind: "usb", USBPath: "1-2", DiscoveryIssue: "at_port_missing"},
	}
	got := manager.autoRepairDJIQMI(context.Background(), candidates)
	if len(got) != 2 {
		t.Fatalf("candidate count = %d, want 2", len(got))
	}
	// Both degraded devices must have been attempted independently, each
	// throttled under its own key. The repair itself fails here without
	// qmicli; the throttle bookkeeping is what this test asserts.
	if len(manager.djiRepairAttempt) != 2 {
		t.Fatalf("repair attempts = %#v, want independent keys for both devices", manager.djiRepairAttempt)
	}
	for _, path := range []string{"1-1", "1-2"} {
		attempt, ok := manager.djiRepairAttempt[path]
		if !ok || attempt.IsZero() {
			t.Fatalf("device %s has no recorded repair attempt", path)
		}
	}
}
