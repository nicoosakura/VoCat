package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

func newTestDesktopEventBus() *desktopEventBus {
	return newDesktopEventBus()
}

func TestDesktopEventBusPublishPollLatest(t *testing.T) {
	bus := newTestDesktopEventBus()

	first := bus.publish(desktopEventSMSReceived, map[string]any{"number": "10086"})
	if first.Seq != 1 {
		t.Fatalf("first seq = %d, want 1", first.Seq)
	}
	second := bus.publish(desktopEventDeviceOffline, map[string]any{"device_id": "m1"})
	if second.Seq != 2 {
		t.Fatalf("second seq = %d, want 2", second.Seq)
	}

	// poll since=0 → 全部按序返回。
	events := bus.poll(0)
	if len(events) != 2 {
		t.Fatalf("poll(0) len = %d, want 2", len(events))
	}
	if events[0].Kind != desktopEventSMSReceived || events[1].Kind != desktopEventDeviceOffline {
		t.Fatalf("event order wrong: %#v", events)
	}

	// poll since=1 → 只返回第二件。
	events = bus.poll(1)
	if len(events) != 1 || events[0].Seq != 2 {
		t.Fatalf("poll(1) = %#v, want only seq 2", events)
	}

	if latest := bus.latest(); latest != 2 {
		t.Fatalf("latest = %d, want 2", latest)
	}
}

func TestDesktopEventBusConcurrentPublish(t *testing.T) {
	bus := newTestDesktopEventBus()
	var group sync.WaitGroup
	for index := 0; index < 8; index++ {
		group.Add(1)
		go func() {
			defer group.Done()
			for attempt := 0; attempt < 200; attempt++ {
				bus.publish(desktopEventSMSReceived, map[string]any{"n": attempt})
			}
		}()
	}
	group.Wait()
	if latest := bus.latest(); latest != 1600 {
		t.Fatalf("latest = %d, want 1600", latest)
	}
	// 环形缓冲有界：不是所有事件都被保留。
	if events := bus.poll(0); len(events) > desktopEventCapacity {
		t.Fatalf("retained %d events, cap %d", len(events), desktopEventCapacity)
	}
}

func TestDesktopEventsPollEndpointRequiresAuth(t *testing.T) {
	server, _ := localIssueTestServer(t)
	request := httptest.NewRequest(http.MethodGet, "/api/events/poll?since=0", nil)
	response := httptest.NewRecorder()
	server.handleAPI(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", response.Code)
	}
}

func TestDesktopEventsPollEndpointAuthenticated(t *testing.T) {
	server, authService := localIssueTestServer(t)
	const secret = "desktop-secret-poll"
	authService.SetLocalIssueSecret(secret, time.Hour)

	// 签发真实会话（走 handleLocalIssue，模拟桌面端一次性口令流程）。
	issue := httptest.NewRecorder()
	server.handleLocalIssue(issue, localIssueRequest(secret))
	if issue.Code != http.StatusOK {
		t.Fatalf("issue status = %d, body=%s", issue.Code, issue.Body.String())
	}
	var sessionValue, csrfValue string
	for _, cookie := range issue.Result().Cookies() {
		switch cookie.Name {
		case sessionCookieName:
			sessionValue = cookie.Value
		case csrfCookieName:
			csrfValue = cookie.Value
		}
	}

	// 发布两条事件后轮询。
	server.desktopEventBus().publish(desktopEventSMSReceived, map[string]any{"number": "10086", "content": "您的验证码是 123456"})
	server.desktopEventBus().publish(desktopEventDeviceOffline, map[string]any{"device_id": "m1", "device_label": "EC20"})

	request := httptest.NewRequest(http.MethodGet, "/api/events/poll?since=0", nil)
	request.AddCookie(&http.Cookie{Name: sessionCookieName, Value: sessionValue})
	request.AddCookie(&http.Cookie{Name: csrfCookieName, Value: csrfValue})
	response := httptest.NewRecorder()
	server.handleAPI(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", response.Code, response.Body.String())
	}
	var payload struct {
		Data struct {
			Events []desktopEvent `json:"events"`
			Latest int64          `json:"latest"`
		} `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if len(payload.Data.Events) != 2 {
		t.Fatalf("events = %d, want 2; body=%s", len(payload.Data.Events), response.Body.String())
	}
	if payload.Data.Latest != 2 {
		t.Fatalf("latest = %d, want 2", payload.Data.Latest)
	}
	if payload.Data.Events[0].Kind != desktopEventSMSReceived {
		t.Fatalf("first kind = %s", payload.Data.Events[0].Kind)
	}

	// 增量轮询：since=2 之后无新事件。
	request = httptest.NewRequest(http.MethodGet, "/api/events/poll?since=2", nil)
	request.AddCookie(&http.Cookie{Name: sessionCookieName, Value: sessionValue})
	request.AddCookie(&http.Cookie{Name: csrfCookieName, Value: csrfValue})
	response = httptest.NewRecorder()
	server.handleAPI(response, request)
	var incremental struct {
		Data struct {
			Events []desktopEvent `json:"events"`
		} `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &incremental); err != nil {
		t.Fatalf("decode incremental body: %v", err)
	}
	if len(incremental.Data.Events) != 0 {
		t.Fatalf("incremental events = %d, want 0", len(incremental.Data.Events))
	}
}

func TestDesktopEventsPollEndpointRejectsBadSince(t *testing.T) {
	server, authService := localIssueTestServer(t)
	const secret = "desktop-secret-bad"
	authService.SetLocalIssueSecret(secret, time.Hour)
	issue := httptest.NewRecorder()
	server.handleLocalIssue(issue, localIssueRequest(secret))
	var sessionValue, csrfValue string
	for _, cookie := range issue.Result().Cookies() {
		switch cookie.Name {
		case sessionCookieName:
			sessionValue = cookie.Value
		case csrfCookieName:
			csrfValue = cookie.Value
		}
	}
	request := httptest.NewRequest(http.MethodGet, "/api/events/poll?since=abc", nil)
	request.AddCookie(&http.Cookie{Name: sessionCookieName, Value: sessionValue})
	request.AddCookie(&http.Cookie{Name: csrfCookieName, Value: csrfValue})
	response := httptest.NewRecorder()
	server.handleAPI(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", response.Code)
	}
}

func TestDesktopDeviceLabel(t *testing.T) {
	server, _ := localIssueTestServer(t)
	ctx := context.Background()
	if label := server.desktopDeviceLabel(ctx, ""); label != "--" {
		t.Fatalf("empty label = %q, want --", label)
	}
	if label := server.desktopDeviceLabel(ctx, "ghost-device"); label != "ghost-device" {
		t.Fatalf("unknown label = %q, want ghost-device", label)
	}
}
