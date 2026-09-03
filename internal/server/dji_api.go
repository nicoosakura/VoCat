package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"vocat/internal/device"
	"vocat/internal/store"
)

const (
	djiRepairAuditAction = "dji_qmi_repair"
	djiAuditEntityType   = "device"
)

// recordDJIQMIRepairAudit persists an on-demand DJI binding repair outcome to
// the audit trail. Automatic repairs are recorded by the device manager's
// OnDJIRepair callback instead; both share the same action and entity shape so
// the DJI health card can render one history.
func (s *Server) recordDJIQMIRepairAudit(w http.ResponseWriter, r *http.Request, usbPath string, success bool, details map[string]any) bool {
	entityID := strings.TrimSpace(usbPath)
	outcome := "failure"
	if success {
		outcome = "success"
	}
	if _, err := s.store.AppendAuditEvent(r.Context(), store.AuditEvent{
		Actor:      "system",
		Action:     djiRepairAuditAction,
		EntityType: djiAuditEntityType,
		EntityID:   entityID,
		Outcome:    outcome,
		Details:    mustJSON(details),
	}); err != nil {
		s.writeStoreError(w, err)
		return true
	}
	return false
}

func mustJSON(value map[string]any) json.RawMessage {
	encoded, err := json.Marshal(value)
	if err != nil {
		return json.RawMessage(`{}`)
	}
	return encoded
}

// auditEventWire converts persisted audit events into the camelCase shape the
// SPA reads for the DJI health card history.
func auditEventWire(events []store.AuditEvent) []map[string]any {
	result := make([]map[string]any, 0, len(events))
	for _, event := range events {
		details := map[string]any{}
		if len(event.Details) > 0 {
			_ = json.Unmarshal(event.Details, &details)
		}
		result = append(result, map[string]any{
			"action":     event.Action,
			"entity_id":  event.EntityID,
			"outcome":    event.Outcome,
			"details":    details,
			"created_at": event.CreatedAt,
			"id":         event.ID,
		})
	}
	return result
}

// handleDJITopology serves the read-only USB interface layout of a configured
// DJI 4G module plus its recent repair history. It never writes sysfs or NV.
func (s *Server) handleDJITopology(w http.ResponseWriter, r *http.Request, config store.Device) bool {
	if !requireMethod(w, r, http.MethodGet) {
		return true
	}
	if store.NormalizeDeviceType(config.DeviceType) != store.DeviceTypeDJI4G {
		writeError(w, http.StatusBadRequest, "not_dji_device", "USB topology is available only for DJI 4G modules")
		return true
	}
	usbPath := strings.TrimSpace(config.USBPath)
	if usbPath == "" {
		writeError(w, http.StatusNotFound, "dji_usb_path_missing", "the device has no recorded USB path")
		return true
	}
	topology, err := device.DJITopology("/sys", usbPath)
	if err != nil {
		if errors.Is(err, device.ErrDJITopologyUnsupported) {
			writeError(w, http.StatusNotImplemented, "topology_unsupported", err.Error())
			return true
		}
		s.writeDeviceError(w, err)
		return true
	}
	events, listErr := s.store.ListAuditEvents(r.Context(), store.AuditFilter{
		Action: djiRepairAuditAction,
		Limit:  8,
	})
	if listErr != nil {
		s.writeStoreError(w, listErr)
		return true
	}
	// The device card keys history by USB path; a repair recorded minutes ago
	// under the same physical port must survive a re-enumeration with a new
	// devnum, so match on the device name portion as well.
	writeJSON(w, http.StatusOK, map[string]any{
		"data": map[string]any{
			"topology":    topology,
			"audit":       auditEventWire(djiAuditForPath(events, usbPath)),
			"temperature": s.djiModuleTemperature(r.Context(), config),
		},
	})
	return true
}

// djiModuleTemperature queries the module's operating temperature with the
// Quectel AT+QTEMP extension. It is best-effort diagnostic data: firmware
// revisions that do not implement the command, transient AT failures, and
// offline devices all yield a nil reading instead of failing the request.
func (s *Server) djiModuleTemperature(ctx context.Context, config store.Device) *float64 {
	if s.devices == nil {
		return nil
	}
	_, physicalID, present := s.physicalForConfig(config)
	if !present {
		return nil
	}
	queryContext, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	response, err := s.devices.ExecuteAT(queryContext, physicalID, "AT+QTEMP")
	if err != nil || !response.OK() {
		return nil
	}
	if value, ok := device.ParseDJITemperature(response.Lines); ok {
		return &value
	}
	return nil
}

// handleDJIRepairFor runs the binding repair against one specific configured
// DJI 4G module, addressed by its recorded USB path. Unlike the bus-wide
// repair endpoint, it works in multi-module setups because it never assumes a
// single DJI device.
func (s *Server) handleDJIRepairFor(w http.ResponseWriter, r *http.Request, config store.Device) bool {
	if !requireMethod(w, r, http.MethodPost) {
		return true
	}
	if store.NormalizeDeviceType(config.DeviceType) != store.DeviceTypeDJI4G {
		writeError(w, http.StatusBadRequest, "not_dji_device", "DJI binding repair is available only for DJI 4G modules")
		return true
	}
	usbPath := strings.TrimSpace(config.USBPath)
	if usbPath == "" {
		writeError(w, http.StatusNotFound, "dji_usb_path_missing", "the device has no recorded USB path")
		return true
	}
	result, err := device.RepairDJIQMIFor(r.Context(), usbPath)
	if err != nil {
		if s.recordDJIQMIRepairAudit(w, r, usbPath, false, map[string]any{"error": err.Error()}) {
			return true
		}
		switch {
		case errors.Is(err, device.ErrDJIRepairNotRoot):
			writeError(w, http.StatusForbidden, "repair_requires_root", err.Error())
		case errors.Is(err, device.ErrDJIRepairUnsupported):
			writeError(w, http.StatusNotImplemented, "repair_unsupported", err.Error())
		default:
			s.writeDeviceError(w, err)
		}
		return true
	}
	if s.recordDJIQMIRepairAudit(w, r, usbPath, true, map[string]any{
		"at_device":      result.ATDevice,
		"control_device": result.ControlDevice,
		"attempts":       result.Attempts,
	}) {
		return true
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{
		"repaired":       true,
		"at_device":      result.ATDevice,
		"control_device": result.ControlDevice,
	}})
	return true
}

func djiAuditForPath(events []store.AuditEvent, usbPath string) []store.AuditEvent {
	exact := strings.TrimSpace(usbPath)
	short := filepath.Base(filepath.Clean(usbPath))
	result := make([]store.AuditEvent, 0, len(events))
	for _, event := range events {
		entity := strings.TrimSpace(event.EntityID)
		if entity == "" || entity == exact || filepath.Base(filepath.Clean(entity)) == short {
			result = append(result, event)
		}
	}
	return result
}
