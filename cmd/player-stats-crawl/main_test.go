package main

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"huashanquery/internal/huashan"
)

func TestStatsPending(t *testing.T) {
	run := time.Date(2026, 9, 24, 15, 0, 0, 0, time.UTC)
	cutoff := time.Date(2026, 8, 25, 15, 0, 0, 0, time.UTC)

	tests := []struct {
		name         string
		retryErrors  bool
		full         bool
		maxAgeCutoff time.Time
		// wantConds are substrings that must each appear in the clause.
		wantConds []string
		// wantAbsent are substrings that must NOT appear.
		wantAbsent []string
		wantArgs   int
	}{
		{
			name:      "incremental only re-fetches players with a newer game",
			wantConds: []string{"s.player_id IS NULL", "lp.last_played >= DATE(s.fetched_at)", "s.fetch_status <> 'error'"},
			wantArgs:  1,
		},
		{
			name:       "full restores the legacy every-player sweep",
			full:       true,
			wantConds:  []string{"s.player_id IS NULL", "s.fetched_at < ?", "s.fetch_status <> 'error'"},
			wantAbsent: []string{"last_played"},
			wantArgs:   1,
		},
		{
			name:        "full with retry-errors drops the error filter",
			full:        true,
			retryErrors: true,
			wantConds:   []string{"s.player_id IS NULL", "s.fetched_at < ?"},
			wantAbsent:  []string{"last_played", "fetch_status"},
			wantArgs:    1,
		},
		{
			name:        "incremental with retry-errors adds a separate error branch",
			retryErrors: true,
			wantConds:   []string{"lp.last_played >= DATE(s.fetched_at)", "s.fetch_status = 'error'"},
			wantArgs:    2,
		},
		{
			name:         "max-age adds a staleness net on top of incremental",
			maxAgeCutoff: cutoff,
			wantConds:    []string{"lp.last_played >= DATE(s.fetched_at)", "s.fetched_at < ?"},
			wantArgs:     2,
		},
		{
			name:      "zero cutoff adds no staleness net",
			wantConds: []string{"lp.last_played >= DATE(s.fetched_at)"},
			wantArgs:  1,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, args := statsPending(run, tt.retryErrors, tt.full, tt.maxAgeCutoff)

			if !strings.HasPrefix(got, "WHERE ") {
				t.Errorf("clause must start with WHERE, got %q", got)
			}
			for _, want := range tt.wantConds {
				if !strings.Contains(got, want) {
					t.Errorf("clause missing %q\ngot:\n%s", want, got)
				}
			}
			for _, absent := range tt.wantAbsent {
				if strings.Contains(got, absent) {
					t.Errorf("clause should not contain %q\ngot:\n%s", absent, got)
				}
			}
			if len(args) != tt.wantArgs {
				t.Fatalf("got %d args %v, want %d", len(args), args, tt.wantArgs)
			}
			// Placeholder count must match arg count or the query binds wrong.
			if n := strings.Count(got, "?"); n != tt.wantArgs {
				t.Errorf("clause has %d placeholders but %d args were returned", n, len(args))
			}
			if !args[0].(time.Time).Equal(run) {
				t.Errorf("first arg = %v, want run start %v", args[0], run)
			}
			if tt.maxAgeCutoff.IsZero() == false {
				last := args[len(args)-1].(time.Time)
				if !last.Equal(cutoff) {
					t.Errorf("last arg = %v, want max-age cutoff %v", last, cutoff)
				}
			}
		})
	}
}

func TestClassifyStatusKeepsTransientFailuresRetryable(t *testing.T) {
	for _, err := range []error{
		context.DeadlineExceeded,
		context.Canceled,
		&huashan.APIError{Status: 429},
		&huashan.APIError{Status: 503},
	} {
		if got := classifyStatus(err); got != "retry" {
			t.Errorf("classifyStatus(%v) = %q, want retry", err, got)
		}
	}
	if got := classifyStatus(errors.New("invalid payload")); got != "error" {
		t.Errorf("non-transient failure = %q, want error", got)
	}
}

func TestClipNotePreservesUTF8(t *testing.T) {
	clipped := clipNote(strings.Repeat("狼", 300))
	if !strings.HasSuffix(clipped, "...") || len([]rune(clipped)) != 255 {
		t.Fatalf("clipNote returned %d runes: %q", len([]rune(clipped)), clipped)
	}
}

// The derived-table join is what makes incremental cheap; if it is ever rewritten as a
// correlated subquery the per-batch cost comes back, so pin its shape.
func TestStatsFromClauseUsesDerivedTable(t *testing.T) {
	if !strings.Contains(statsFromClause, "MAX(g.play_date) AS last_played") {
		t.Errorf("statsFromClause lost the last_played derived table:\n%s", statsFromClause)
	}
	if strings.Count(statsFromClause, "?") != 2 {
		t.Errorf("statsFromClause must bind exactly zone and season, got %d placeholders", strings.Count(statsFromClause, "?"))
	}
}

func TestScopeArgsOrdering(t *testing.T) {
	c := &crawler{cfg: config{Zone: "ALL", SeasonKey: 7}}
	got := c.scopeArgs([]any{"a", "b"})
	want := []any{"ALL", 7, "a", "b"}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("arg %d = %v, want %v", i, got[i], want[i])
		}
	}
	// Must not alias the caller's slice: appending to the result cannot write into whereArgs.
	whereArgs := []any{"a"}
	first := c.scopeArgs(whereArgs)
	first = append(first, "tail")
	if whereArgs[0] != "a" || len(whereArgs) != 1 {
		t.Errorf("scopeArgs aliased the caller slice: %v", whereArgs)
	}
}
