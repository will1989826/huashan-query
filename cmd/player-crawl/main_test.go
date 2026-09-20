package main

import "testing"

func TestPlayerPendingWhere(t *testing.T) {
	tests := []struct {
		name        string
		retryErrors bool
		want        string
	}{
		{
			name: "skip prior errors by default",
			want: `WHERE crawled_at IS NULL OR (crawled_at < ? AND crawled <> 2)`,
		},
		{
			name:        "retry only errors from before this run",
			retryErrors: true,
			want:        `WHERE crawled_at IS NULL OR crawled_at < ?`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := playerPendingWhere(tt.retryErrors); got != tt.want {
				t.Fatalf("playerPendingWhere(%v) = %q, want %q", tt.retryErrors, got, tt.want)
			}
		})
	}
}
