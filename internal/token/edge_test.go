package token

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestExp(t *testing.T) {
	tok := mk(map[string]any{"exp": int64(123456)})
	if got := Exp(tok); got != 123456 {
		t.Fatalf("Exp() = %d", got)
	}
	for _, bad := range []string{"", "one-part", "a.***.c", "a.e30.c"} {
		if got := Exp(bad); got != 0 {
			t.Fatalf("Exp(%q) = %d", bad, got)
		}
	}
}

func TestValidateInterruptedBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Length", "100")
		w.Header().Set("Connection", "close")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"player_id":`))
	}))
	defer srv.Close()

	old := apiCheck
	apiCheck = srv.URL
	defer func() { apiCheck = old }()
	if _, out := validate("x"); out != valNetwork {
		t.Fatalf("truncated response = %v, want network", out)
	}
}

func TestScanReasonNetwork(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	closedURL := srv.URL
	srv.Close()

	old := apiCheck
	apiCheck = closedURL
	defer func() { apiCheck = old }()
	m := &Manager{Sources: []Source{fakeSrc{[]string{mkFuture()}}}}
	if _, _, reason := m.Current(); reason != ReasonNetwork {
		t.Fatalf("reason = %q, want network", reason)
	}
}

func TestTokenWithoutExpUsesFallbackCache(t *testing.T) {
	var calls int
	m := &Manager{
		Sources: []Source{fakeSrc{[]string{"not.a.jwt"}}},
		Validate: func(string) (string, bool) {
			calls++
			return "Ann", true
		},
	}
	if tok, _, _ := m.Current(); tok == "" {
		t.Fatal("first Current returned no token")
	}
	if tok, _, _ := m.Current(); tok == "" {
		t.Fatal("cached Current returned no token")
	}
	if calls != 1 {
		t.Fatalf("validate calls = %d", calls)
	}
	m.mu.Lock()
	remaining := time.Until(m.cachedExp)
	m.mu.Unlock()
	if remaining <= 0 || remaining > fallbackTTL {
		t.Fatalf("fallback cache remaining = %v", remaining)
	}
}
