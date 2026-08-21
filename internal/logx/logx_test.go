package logx

import (
	"bytes"
	"log"
	"strings"
	"testing"
)

func TestErrorf(t *testing.T) {
	var buf bytes.Buffer
	mu.Lock()
	logger = log.New(&buf, "", 0)
	mu.Unlock()
	Errorf("boom %d", 42)
	if !strings.Contains(buf.String(), "[ERROR] boom 42") {
		t.Fatalf("Errorf got %q", buf.String())
	}
}

func TestRecoverCapturesStack(t *testing.T) {
	var buf bytes.Buffer
	mu.Lock()
	logger = log.New(&buf, "", 0)
	mu.Unlock()
	func() {
		defer Recover("scope-x")
		panic("kaboom")
	}()
	s := buf.String()
	if !strings.Contains(s, "[PANIC] scope-x: kaboom") || !strings.Contains(s, "goroutine") {
		t.Fatalf("panic log missing message/stack: %q", s)
	}
}

func TestInitReturnsPath(t *testing.T) {
	if p := Init("vtest"); p == "" || Path() == "" {
		t.Fatalf("Init path empty (p=%q)", p)
	}
}
