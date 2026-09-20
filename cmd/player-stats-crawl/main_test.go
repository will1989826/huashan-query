package main

import "testing"

func TestStatsPendingWhere(t *testing.T) {
	tests := []struct {
		name        string
		retryErrors bool
		want        string
	}{
		{
			name: "skip prior errors by default",
			want: `WHERE s.player_id IS NULL OR (s.fetched_at < ? AND s.fetch_status <> 'error')`,
		},
		{
			name:        "retry only errors from before this run",
			retryErrors: true,
			want:        `WHERE s.player_id IS NULL OR s.fetched_at < ?`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := statsPendingWhere(tt.retryErrors); got != tt.want {
				t.Fatalf("statsPendingWhere(%v) = %q, want %q", tt.retryErrors, got, tt.want)
			}
		})
	}
}
