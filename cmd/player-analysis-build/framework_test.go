package main

import "testing"

func TestCanonicalDate(t *testing.T) {
	tests := map[string]string{
		"date":            "2026-09-23",
		"timestamp":       "2026-09-23T00:00:00+08:00",
		"mysql timestamp": "2026-09-23 00:00:00",
		"invalid":         "not-a-date",
	}
	for name, input := range tests {
		t.Run(name, func(t *testing.T) {
			want := input
			if name == "timestamp" || name == "mysql timestamp" {
				want = "2026-09-23"
			}
			if got := canonicalDate(input); got != want {
				t.Fatalf("canonicalDate(%q) = %q, want %q", input, got, want)
			}
		})
	}
}
