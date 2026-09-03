package server

import (
	"errors"
	"net"
	"net/http"
	"time"

	"vocat/internal/auth"
)

// handleLocalIssue exchanges a one-time, short-lived secret for a real
// administrator session. It exists so the desktop shell (which launches the
// bundled service binary bound to loopback only) can open an authenticated
// session without ever transmitting the administrator password.
//
// Security posture (PRD D4):
//   - The request is accepted only from a loopback source address. The service
//     itself is bound to 127.0.0.1 in local-integrated mode, so a remote host
//     cannot reach this endpoint at all; this check is a second layer for any
//     proxy or dual-binding setup.
//   - The secret is single-use and expires quickly (auth.DefaultLocalIssueTTL).
//     Any consumption attempt — correct, wrong, or expired — disarms it, so an
//     attacker cannot brute-force guesses against an armed secret.
//   - On success the response is identical in shape to a password login
//     (Set-Auth-Cookies + csrf_token), so the SPA treats it transparently.
func (s *Server) handleLocalIssue(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	if !loopbackRequest(r) {
		writeError(w, http.StatusForbidden, "loopback_required", "local session issuance is restricted to loopback clients")
		return
	}
	var request struct {
		Secret string `json:"secret"`
	}
	if err := s.decodeJSON(w, r, &request); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	credentials, err := s.auth.IssueLocalSession(r.Context(), request.Secret)
	if err != nil {
		switch {
		case errors.Is(err, auth.ErrUnauthorized):
			writeError(w, http.StatusUnauthorized, "invalid_local_secret", "invalid or expired local issue secret")
		default:
			s.logger.Error("local session issuance failed", "error", err)
			writeError(w, http.StatusInternalServerError, "internal_error", "an internal error occurred")
		}
		return
	}
	s.setAuthCookies(w, credentials.SessionToken, credentials.CSRFToken, credentials.ExpiresAt)
	writeJSON(w, http.StatusOK, map[string]any{
		"data": map[string]any{
			"user":          credentials.Principal,
			"csrf_token":    credentials.CSRFToken,
			"expires_at":    credentials.ExpiresAt.Format(time.RFC3339),
			"authenticated": true,
			"status":        "ok",
		},
	})
}

// loopbackRequest reports whether the direct peer is a loopback address.
// Local-integrated mode binds the service to 127.0.0.1, so the socket peer is
// loopback by construction; proxy deployments that terminate elsewhere should
// not be allowed to mint sessions from a plain secret.
func loopbackRequest(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return false
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}