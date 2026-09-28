package main

import "testing"

func TestParseConfigRejectsMutuallyExclusiveModes(t *testing.T) {
	if _, err := parseConfig([]string{"-rebuild", "-framework"}); err == nil {
		t.Fatal("rebuild and framework must be rejected together")
	}
}
