package main

import (
	"encoding/json"
	"strconv"
	"testing"
)

func rosterRows(playerIDsBySeat []int) []map[string]json.RawMessage {
	rows := make([]map[string]json.RawMessage, 0, len(playerIDsBySeat))
	for i, pid := range playerIDsBySeat {
		rows = append(rows, map[string]json.RawMessage{
			"seat":      json.RawMessage(strconv.Itoa(i + 1)),
			"player_id": json.RawMessage(strconv.Itoa(pid)),
		})
	}
	return rows
}

func TestEvaluateRoster(t *testing.T) {
	twelveDistinct := []int{11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22}
	tests := []struct {
		name      string
		seats     []int
		wantOK    bool
		wantIssue string
	}{
		{"valid 12 distinct", twelveDistinct, true, ""},
		{"duplicate real player across seats", []int{11, 12, 13, 14, 15, 12, 17, 18, 19, 20, 21, 22}, false, "duplicate_player_seats"},
		{"npc filler repeated", []int{7103, 7103, 7103, 14, 15, 16, 17, 7103, 19, 20, 7103, 7103}, false, "duplicate_player_seats"},
		{"missing player seat (zero id)", []int{11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 0}, false, "missing_player_seat"},
		{"incomplete roster", []int{11, 12, 13, 14, 15, 16, 17, 18}, false, "incomplete_roster"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ok, issue := evaluateRoster(rosterRows(tt.seats))
			if ok != tt.wantOK || issue != tt.wantIssue {
				t.Fatalf("evaluateRoster(%v) = (%v, %q), want (%v, %q)", tt.seats, ok, issue, tt.wantOK, tt.wantIssue)
			}
		})
	}
}

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
