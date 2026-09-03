package server

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/bcrypt"

	"vocat/internal/auth"
	"vocat/internal/store"
)

func localIssueTestServer(t *testing.T) (*Server, *auth.Service) {
	t.Helper()
	ctx := context.Background()
	database, err := store.Open(ctx, ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	authService, err := auth.New(database, auth.Options{
		SessionTTL: time.Hour,
		BcryptCost: bcrypt.MinCost,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := authService.EnsureAdmin(ctx, "admin", "correct-password"); err != nil {
		t.Fatal(err)
	}
	return &Server{
		store:               database,
		auth:                authService,
		logger:              regionTestLogger(),
		maxRequestBodyBytes: 4096,
	}, authService
}

func localIssueRequest(secret string) *http.Request {
	body := bytes.NewBufferString(`{"secret":"` + secret + `"}`)
	request := httptest.NewRequest(http.MethodPost, "http://127.0.0.1/api/auth/local-issue", body)
	request.Header.Set("Content-Type", "application/json")
	// 本地一体服务只绑定 127.0.0.1，直连 socket 对端必为回环。
	request.RemoteAddr = "127.0.0.1:54321"
	return request
}

func TestHandleLocalIssueIssuesAuthenticatedSession(t *testing.T) {
	server, authService := localIssueTestServer(t)
	const secret = "desktop-secret-1"
	authService.SetLocalIssueSecret(secret, auth.DefaultLocalIssueTTL)

	response := httptest.NewRecorder()
	server.handleLocalIssue(response, localIssueRequest(secret))
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	sessionCookie := response.Result().Cookies()
	var sessionValue, csrfValue string
	for _, cookie := range sessionCookie {
		switch cookie.Name {
		case sessionCookieName:
			sessionValue = cookie.Value
		case csrfCookieName:
			csrfValue = cookie.Value
		}
	}
	if sessionValue == "" || csrfValue == "" {
		t.Fatalf("session/csrf cookies missing: %#v", sessionCookie)
	}
	// 换取的会话必须能通过 Authenticate（作为普通登录会话工作）。
	if _, err := authService.Authenticate(context.Background(), sessionValue); err != nil {
		t.Fatalf("issued session does not authenticate: %v", err)
	}
}

func TestHandleLocalIssueRejectsNonLoopback(t *testing.T) {
	server, authService := localIssueTestServer(t)
	authService.SetLocalIssueSecret("secret-2", auth.DefaultLocalIssueTTL)
	request := localIssueRequest("secret-2")
	request.RemoteAddr = "203.0.113.5:443"

	response := httptest.NewRecorder()
	server.handleLocalIssue(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403; body = %s", response.Code, response.Body.String())
	}
}

func TestHandleLocalIssueRejectsUnarmedAndReplay(t *testing.T) {
	server, authService := localIssueTestServer(t)
	const secret = "secret-3"

	// 未武装（服务未收到 env）→ 401。
	response := httptest.NewRecorder()
	server.handleLocalIssue(response, localIssueRequest(secret))
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("unarmed status = %d, want 401", response.Code)
	}

	authService.SetLocalIssueSecret(secret, auth.DefaultLocalIssueTTL)
	response = httptest.NewRecorder()
	server.handleLocalIssue(response, localIssueRequest(secret))
	if response.Code != http.StatusOK {
		t.Fatalf("armed status = %d, want 200; body=%s", response.Code, response.Body.String())
	}
	// 重放同一 secret → 401（单次使用）。
	response = httptest.NewRecorder()
	server.handleLocalIssue(response, localIssueRequest(secret))
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("replay status = %d, want 401", response.Code)
	}
	if !strings.Contains(response.Body.String(), "invalid_local_secret") {
		t.Fatalf("replay body = %s", response.Body.String())
	}
}