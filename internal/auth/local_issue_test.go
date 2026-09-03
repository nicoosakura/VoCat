package auth

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestIssueLocalSessionOneTimeAndTamperProof(t *testing.T) {
	ctx := context.Background()
	service := newTestService(t)
	const secret = "local-secret-abc123"

	// 未武装时拒绝。
	if _, err := service.IssueLocalSession(ctx, secret); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("IssueLocalSession() before arming error = %v, want ErrUnauthorized", err)
	}

	service.SetLocalIssueSecret(secret, DefaultLocalIssueTTL)

	// 错误 secret 也会消耗口令（防暴力猜测）。
	if _, err := service.IssueLocalSession(ctx, "wrong"); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("IssueLocalSession() wrong secret error = %v, want ErrUnauthorized", err)
	}
	if _, err := service.IssueLocalSession(ctx, secret); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("IssueLocalSession() after failed attempt error = %v, want ErrUnauthorized (single-use)", err)
	}

	// 重新武装后正确 secret 换取真实会话。
	service.SetLocalIssueSecret(secret, DefaultLocalIssueTTL)
	credentials, err := service.IssueLocalSession(ctx, secret)
	if err != nil {
		t.Fatalf("IssueLocalSession() error = %v", err)
	}
	if credentials.Principal.Username != "admin" || credentials.SessionToken == "" || credentials.CSRFToken == "" {
		t.Fatalf("credentials = %+v", credentials)
	}
	if _, err := service.Authenticate(ctx, credentials.SessionToken); err != nil {
		t.Fatalf("issued session does not authenticate: %v", err)
	}

	// 重放同一个 secret 必须失败。
	if _, err := service.IssueLocalSession(ctx, secret); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("IssueLocalSession() replay error = %v, want ErrUnauthorized", err)
	}
}

func TestIssueLocalSessionExpiresAfterTTL(t *testing.T) {
	ctx := context.Background()
	service := newTestService(t)
	const secret = "short-lived-secret"
	service.SetLocalIssueSecret(secret, 50*time.Millisecond)
	time.Sleep(80 * time.Millisecond)
	if _, err := service.IssueLocalSession(ctx, secret); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("IssueLocalSession() after TTL error = %v, want ErrUnauthorized", err)
	}
}

func TestIssueLocalSessionClearedByEmptySecret(t *testing.T) {
	ctx := context.Background()
	service := newTestService(t)
	const secret = "clear-me"
	service.SetLocalIssueSecret(secret, DefaultLocalIssueTTL)
	service.SetLocalIssueSecret("", DefaultLocalIssueTTL)
	if _, err := service.IssueLocalSession(ctx, secret); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("IssueLocalSession() after disarm error = %v, want ErrUnauthorized", err)
	}
}