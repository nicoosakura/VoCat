package server

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"sort"
	"strings"
	"time"

	"vocat/internal/store"
)

const (
	latencyProbeAttempts   = 3
	latencyProbePerAttempt = 2 * time.Second
	latencyDefaultTarget   = "223.5.5.5:53"
)

// handleLatencyTest measures TCP connect latency to a public target from the
// modem's own network interface when one is configured. It is aimed at DJI 4G
// modules used as a secondary data path, where round-trip quality decides
// whether the link is usable. Results are best-effort diagnostics.
func (s *Server) handleLatencyTest(w http.ResponseWriter, r *http.Request, config store.Device) bool {
	if !requireMethod(w, r, http.MethodPost) {
		return true
	}
	target := strings.TrimSpace(r.URL.Query().Get("target"))
	if target == "" {
		target = latencyDefaultTarget
	}
	if !strings.Contains(target, ":") {
		writeError(w, http.StatusBadRequest, "invalid_latency_target", "latency target must be host:port")
		return true
	}
	localIP := interfaceIPv4(config.Interface)
	probeContext, cancel := context.WithTimeout(r.Context(), latencyProbeAttempts*latencyProbePerAttempt+time.Second)
	defer cancel()
	samples, probeErr := probeTCPLatency(probeContext, target, localIP, latencyProbeAttempts, latencyProbePerAttempt)
	summary := latencySummary(samples)
	path := "default"
	if localIP != nil {
		path = "interface"
	}
	data := map[string]any{
		"target":     target,
		"interface":  config.Interface,
		"source_ip":  localIP,
		"attempts":   len(samples),
		"samples_ms": samples,
		"min_ms":     summary.Min,
		"avg_ms":     summary.Avg,
		"max_ms":     summary.Max,
		"path":       path,
	}
	if probeErr != nil {
		data["error"] = probeErr.Error()
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": data})
	return true
}

func interfaceIPv4(name string) net.IP {
	if strings.TrimSpace(name) == "" {
		return nil
	}
	iface, err := net.InterfaceByName(name)
	if err != nil {
		return nil
	}
	addrs, err := iface.Addrs()
	if err != nil {
		return nil
	}
	for _, addr := range addrs {
		ipNet, ok := addr.(*net.IPNet)
		if ok && ipNet.IP.To4() != nil {
			return ipNet.IP
		}
	}
	return nil
}

func probeTCPLatency(ctx context.Context, target string, localIP net.IP, attempts int, perAttempt time.Duration) ([]float64, error) {
	if attempts <= 0 {
		attempts = latencyProbeAttempts
	}
	var samples []float64
	var failures []error
	for index := 0; index < attempts; index++ {
		started := time.Now()
		var dialer net.Dialer
		if localIP != nil {
			dialer.LocalAddr = &net.TCPAddr{IP: localIP}
		}
		attemptContext, cancel := context.WithTimeout(ctx, perAttempt)
		connection, err := dialer.DialContext(attemptContext, "tcp", target)
		cancel()
		if err != nil {
			failures = append(failures, err)
			continue
		}
		_ = connection.Close()
		samples = append(samples, float64(time.Since(started).Microseconds())/1000.0)
	}
	if len(failures) > 0 && len(samples) == 0 {
		return samples, fmt.Errorf("all %d probe attempts failed (first error: %v)", attempts, failures[0])
	}
	return samples, nil
}

type latencySummaryResult struct {
	Min float64 `json:"min_ms"`
	Avg float64 `json:"avg_ms"`
	Max float64 `json:"max_ms"`
}

func latencySummary(samples []float64) latencySummaryResult {
	sorted := append([]float64(nil), samples...)
	sort.Float64s(sorted)
	result := latencySummaryResult{}
	switch len(sorted) {
	case 0:
	case 1:
		result.Min, result.Avg, result.Max = sorted[0], sorted[0], sorted[0]
	default:
		result.Min = sorted[0]
		result.Max = sorted[len(sorted)-1]
		var total float64
		for _, value := range sorted {
			total += value
		}
		result.Avg = total / float64(len(sorted))
	}
	return result
}
