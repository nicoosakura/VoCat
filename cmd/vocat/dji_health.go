package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"strings"
	"time"

	"vocat/internal/device"
	"vocat/internal/store"
)

const (
	// djiHealthPollInterval cadence for the configured-device health check. It
	// only reads /dev node existence and is far lighter than a re-scan.
	djiHealthPollInterval = 60 * time.Second
	djiRescanTimeout      = 45 * time.Second
)

// recordDJIQMIRepairAudit returns the OnDJIRepair callback for the device
// manager: every automatic DJI binding repair outcome is persisted to the
// audit trail so the health card can show history. EntityID is the sysfs USB
// path, matching the on-demand repair endpoint's records.
func recordDJIQMIRepairAudit(database *store.Store) func(device.DJIRepairRecord) {
	return func(record device.DJIRepairRecord) {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		details := map[string]any{
			"at_device": record.ATDevice,
			"attempts":  record.Attempts,
			"device_id": record.DeviceID,
			"usb_path":  record.USBPath,
		}
		if record.Error != "" {
			details["error"] = record.Error
		} else {
			details["control_device"] = record.ControlDevice
		}
		outcome := "failure"
		if record.Success {
			outcome = "success"
		}
		encoded, _ := json.Marshal(details)
		if _, err := database.AppendAuditEvent(ctx, store.AuditEvent{
			Actor:      "system",
			Action:     "dji_qmi_repair",
			EntityType: "device",
			EntityID:   record.USBPath,
			Outcome:    outcome,
			Details:    encoded,
		}); err != nil && ctx.Err() == nil {
			slog.Default().Warn("persist DJI repair audit event", "error", err)
		}
	}
}

// pollDJIHealth periodically checks every configured DJI 4G module whose AT or
// QMI device node has vanished while the process was running (typical after a
// USBIP reconnect). Missing nodes trigger one re-scan, which feeds the
// automatic binding repair with its own cooldown.
func pollDJIHealth(ctx context.Context, logger *slog.Logger, database *store.Store, manager *device.Manager) {
	ticker := time.NewTicker(djiHealthPollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			checkConfiguredDJIHealth(ctx, logger, database, manager)
		}
	}
}

func checkConfiguredDJIHealth(ctx context.Context, logger *slog.Logger, database *store.Store, manager *device.Manager) {
	configured, err := database.ListDevices(ctx)
	if err != nil {
		logger.Warn("list configured devices for DJI health check", "error", err)
		return
	}
	needRescan := false
	for _, stored := range configured {
		if store.NormalizeDeviceType(stored.DeviceType) != store.DeviceTypeDJI4G {
			continue
		}
		usbPath := strings.TrimSpace(stored.USBPath)
		if usbPath == "" {
			continue
		}
		for _, entry := range manager.List() {
			if !entry.Discovered || strings.TrimSpace(entry.Candidate.USBPath) != usbPath {
				continue
			}
			atPath := strings.TrimSpace(entry.Candidate.ATPort.OpenPath())
			qmiPath := strings.TrimSpace(entry.Candidate.QMIControl)
			if (atPath != "" && !exists(atPath)) || (qmiPath != "" && !exists(qmiPath)) {
				needRescan = true
				logger.Info("configured DJI module lost AT/QMI device nodes; re-scanning",
					"device_id", stored.ID,
					"usb_path", usbPath,
					"at_port", atPath,
					"qmi_control", qmiPath,
				)
			}
			break
		}
	}
	if !needRescan {
		return
	}
	scanContext, cancel := context.WithTimeout(ctx, djiRescanTimeout)
	defer cancel()
	if _, err := manager.Discover(scanContext); err != nil && ctx.Err() == nil {
		logger.Warn("DJI health re-scan failed", "error", err)
	}
}

// watchDJIUSBEvents subscribes to kernel uevents for the DJI module and
// re-scans on add/remove. The subscription is best-effort: when it is
// unavailable (non-Linux, or missing netlink permission) the health poller is
// the fallback and a single warning explains the degradation.
func watchDJIUSBEvents(ctx context.Context, logger *slog.Logger, manager *device.Manager) {
	err := device.WatchDJIUSBEvents(ctx, func() {
		if manager == nil {
			return
		}
		scanContext, cancel := context.WithTimeout(context.Background(), djiRescanTimeout)
		defer cancel()
		if _, scanErr := manager.Discover(scanContext); scanErr != nil {
			logger.Warn("DJI uevent-triggered re-scan failed", "error", scanErr)
		}
	})
	if err != nil && ctx.Err() == nil {
		logger.Warn("DJI uevent watch unavailable; falling back to polling", "error", err)
	}
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
