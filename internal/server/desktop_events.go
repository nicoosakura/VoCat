package server

// desktopEventBus is a small in-memory event stream that the desktop shell
// (Electron) consumes through a polling endpoint. It exists because the
// desktop bridge cannot hold a WebSocket-style push channel open across host
// switch / process restarts without reimplementing authentication, while the
// existing SMS notification providers are outbound HTTP integrations.
//
// The bus keeps only a bounded history of the most recent events; a poller
// that fell too far behind simply misses the gap and resumes at the latest
// sequence number — the desktop bridge treats this as "no new events".

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"vocat/internal/store"
)

const (
	desktopEventCapacity = 256

	desktopEventSMSReceived   = "sms.received"
	desktopEventDeviceOffline = "device.offline"
	desktopEventDeviceOnline  = "device.online"

	desktopEventPollInterval  = 2 * time.Second
	desktopDevicePollInterval = 10 * time.Second
)

type desktopEvent struct {
	Seq     int64          `json:"seq"`
	Kind    string         `json:"kind"`
	Payload map[string]any `json:"payload"`
	Time    time.Time      `json:"time"`
}

type desktopEventBus struct {
	mu     sync.Mutex
	next   int64
	events []desktopEvent // ring buffer; oldest at events[0]
}

func newDesktopEventBus() *desktopEventBus {
	return &desktopEventBus{next: 1}
}

// publish appends one event and returns it with its assigned sequence number.
func (b *desktopEventBus) publish(kind string, payload map[string]any) desktopEvent {
	b.mu.Lock()
	defer b.mu.Unlock()
	event := desktopEvent{Seq: b.next, Kind: kind, Payload: payload, Time: time.Now().UTC()}
	b.next++
	b.events = append(b.events, event)
	if len(b.events) > desktopEventCapacity {
		b.events = b.events[len(b.events)-desktopEventCapacity:]
	}
	return event
}

// poll returns every event newer than since, oldest first. Events outside the
// retained window are dropped; the caller should treat an empty result as a
// gap and resume from the latest sequence number.
func (b *desktopEventBus) poll(since int64) []desktopEvent {
	b.mu.Lock()
	defer b.mu.Unlock()
	events := make([]desktopEvent, 0, 8)
	for _, event := range b.events {
		if event.Seq > since {
			events = append(events, event)
		}
	}
	return events
}

// latest returns the most recent sequence number (0 when the bus is empty).
func (b *desktopEventBus) latest() int64 {
	b.mu.Lock()
	defer b.mu.Unlock()
	if len(b.events) == 0 {
		return 0
	}
	return b.events[len(b.events)-1].Seq
}

// StartDesktopEventDispatchers feeds the desktop notification bridge. Two
// producers run independently so one failing source cannot stall the other:
//   - inbound SMS: an independent cursor over the stored inbox, mirroring the
//     existing SMS notification dispatchers;
//   - device lifecycle: hotplug/discovery transitions when the DeviceController
//     exposes SubscribeDeviceLifecycleEvents.
func (s *Server) StartDesktopEventDispatchers(ctx context.Context) {
	if ctx == nil {
		ctx = context.Background()
	}
	if s.desktopEvents == nil {
		s.desktopEvents = newDesktopEventBus()
	}
	go s.runDesktopSMSPublisher(ctx)
	go s.runDesktopDevicePublisher(ctx)
}

func (s *Server) desktopEventBus() *desktopEventBus {
	if s.desktopEvents == nil {
		s.desktopEvents = newDesktopEventBus()
	}
	return s.desktopEvents
}

func (s *Server) runDesktopSMSPublisher(ctx context.Context) {
	var cursor int64
	cursorInitialized := false
	for ctx.Err() == nil {
		if !cursorInitialized {
			latest, err := s.store.LatestSMSMessageID(ctx)
			if err != nil {
				if !sleepDesktopPoll(ctx, desktopEventPollInterval) {
					return
				}
				continue
			}
			cursor, cursorInitialized = latest, true
		}
		messages, err := s.store.ListInboundSMSAfterID(ctx, cursor, 100)
		if err != nil {
			if !sleepDesktopPoll(ctx, desktopEventPollInterval) {
				return
			}
			continue
		}
		for _, message := range messages {
			// Only publish a desktop event once the long SMS reassembly chain is
			// considered ready, matching the semantic of the notification hooks.
			if !store.ConcatSMSReadyToNotify(message.MessageID, message.Extra) {
				cursor = message.ID
				continue
			}
			notification := s.newSMSNotification(ctx, message)
			s.desktopEventBus().publish(desktopEventSMSReceived, map[string]any{
				"device_id":    notification.DeviceID,
				"device_label": notification.DeviceLabel,
				"number":       notification.Number,
				"content":      notification.Content,
				"time":         message.Timestamp.UTC().Format(time.RFC3339),
			})
			cursor = message.ID
		}
		if !sleepDesktopPoll(ctx, desktopEventPollInterval) {
			return
		}
	}
}

func (s *Server) runDesktopDevicePublisher(ctx context.Context) {
	source, ok := s.devices.(cellularDeviceLifecycleController)
	if !ok {
		s.logger.Debug("desktop event dispatcher: device lifecycle events unavailable")
		return
	}
	events, err := source.SubscribeDeviceLifecycleEvents(ctx)
	if err != nil {
		s.logger.Warn("desktop event dispatcher: subscribe device lifecycle events", "error", err)
		return
	}
	lastSeen := make(map[string]bool)
	for {
		select {
		case <-ctx.Done():
			return
		case event, ok := <-events:
			if !ok {
				return
			}
			if lastSeen[event.ID] == event.Present {
				continue
			}
			lastSeen[event.ID] = event.Present
			kind := desktopEventDeviceOnline
			if !event.Present {
				kind = desktopEventDeviceOffline
			}
			label := s.desktopDeviceLabel(ctx, event.ID)
			s.desktopEventBus().publish(kind, map[string]any{
				"device_id":    event.ID,
				"device_label": label,
				"time":         time.Now().UTC().Format(time.RFC3339),
			})
		}
	}
}

func (s *Server) desktopDeviceLabel(ctx context.Context, deviceID string) string {
	if deviceID == "" {
		return "--"
	}
	if configured, err := s.store.Device(ctx, deviceID); err == nil && strings.TrimSpace(configured.Name) != "" {
		return strings.TrimSpace(configured.Name)
	}
	return deviceID
}

func sleepDesktopPoll(ctx context.Context, interval time.Duration) bool {
	timer := time.NewTimer(interval)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

// handleDesktopEventsPoll serves GET /api/events/poll?since=<seq>. It returns
// the events newer than the client cursor, or an empty list when nothing new
// has arrived. The endpoint sits behind the normal session authentication so
// the desktop bridge never needs a second credentials path.
func (s *Server) handleDesktopEventsPoll(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet) {
		return
	}
	var since int64
	if raw := r.URL.Query().Get("since"); raw != "" {
		parsed, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || parsed < 0 {
			writeError(w, http.StatusBadRequest, "invalid_since", "since must be a non-negative integer")
			return
		}
		since = parsed
	}
	events := s.desktopEventBus().poll(since)
	writeJSON(w, http.StatusOK, map[string]any{
		"data": map[string]any{
			"events": events,
			"latest": s.desktopEventBus().latest(),
		},
	})
}
