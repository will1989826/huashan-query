package main

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"huashanquery/internal/huashan"
)

func TestDeadVerdict(t *testing.T) {
	tests := []struct {
		name          string
		err           error
		wantRecord    bool
		wantPermanent bool
		wantStatus    int
	}{
		{
			name:       "nil error records nothing",
			err:        nil,
			wantRecord: false,
		},
		{
			name:          "404 is permanent on first sight",
			err:           &huashan.APIError{Status: 404, Message: "找不到某些请求的实体"},
			wantRecord:    true,
			wantPermanent: true,
			wantStatus:    404,
		},
		{
			name:          "410 gone is permanent",
			err:           &huashan.APIError{Status: 410, Message: "gone"},
			wantRecord:    true,
			wantPermanent: true,
			wantStatus:    410,
		},
		{
			name:       "500 is recorded but retryable",
			err:        &huashan.APIError{Status: 500, Message: "upstream"},
			wantRecord: true,
			wantStatus: 500,
		},
		{
			name:       "403 is recorded but not treated as missing",
			err:        &huashan.APIError{Status: 403, Message: "forbidden"},
			wantRecord: true,
			wantStatus: 403,
		},
		{
			// A run interrupted by Ctrl-C must not blacklist in-flight games.
			name:       "context canceled records nothing",
			err:        context.Canceled,
			wantRecord: false,
		},
		{
			// The per-game timeout means we gave up, not that upstream lacks the game.
			name:       "context deadline records nothing",
			err:        context.DeadlineExceeded,
			wantRecord: false,
		},
		{
			name:       "wrapped context deadline still records nothing",
			err:        fmt.Errorf("game detail: %w", context.DeadlineExceeded),
			wantRecord: false,
		},
		{
			name:          "wrapped 404 is still permanent",
			err:           fmt.Errorf("game detail: %w", &huashan.APIError{Status: 404, Message: "nope"}),
			wantRecord:    true,
			wantPermanent: true,
			wantStatus:    404,
		},
		{
			name:       "unstructured error is recorded without a status",
			err:        errors.New("dial tcp: connection refused"),
			wantRecord: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			record, permanent, status := deadVerdict(tt.err)
			if record != tt.wantRecord {
				t.Errorf("record = %v, want %v", record, tt.wantRecord)
			}
			if permanent != tt.wantPermanent {
				t.Errorf("permanent = %v, want %v", permanent, tt.wantPermanent)
			}
			if status != tt.wantStatus {
				t.Errorf("status = %d, want %d", status, tt.wantStatus)
			}
		})
	}
}

func TestSkipGame(t *testing.T) {
	tests := []struct {
		name          string
		gid           int
		final         bool
		dead          bool
		retryDead     bool
		refreshStored bool
		want          bool
	}{
		{name: "unknown game is fetched", gid: 1, want: false},
		{name: "already stored is skipped", gid: 1, final: true, want: true},
		{name: "dead game is skipped", gid: 1, dead: true, want: true},
		{name: "dead game is retried when asked", gid: 1, dead: true, retryDead: true, want: false},
		{name: "stored game is skipped even when retrying dead", gid: 1, final: true, dead: true, retryDead: true, want: true},
		{name: "refresh-stored re-fetches a stored game", gid: 1, final: true, refreshStored: true, want: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c := &crawler{
				cfg:       config{RetryDead: tt.retryDead, RefreshStored: tt.refreshStored},
				seenFinal: map[int]bool{},
				seenDead:  map[int]bool{},
			}
			if tt.final {
				c.seenFinal[tt.gid] = true
			}
			if tt.dead {
				c.seenDead[tt.gid] = true
			}
			if got := c.skipGame(tt.gid); got != tt.want {
				t.Errorf("skipGame(%d) = %v, want %v", tt.gid, got, tt.want)
			}
		})
	}
}

func TestClipNotePreservesUTF8(t *testing.T) {
	clipped := clipNote("狼" + strings.Repeat("人", 300))
	if !strings.HasSuffix(clipped, "...") || len([]rune(clipped)) != 255 {
		t.Fatalf("clipNote returned %d runes: %q", len([]rune(clipped)), clipped)
	}
}

func TestLimitConcurrentTodo(t *testing.T) {
	c := &crawler{cfg: config{MaxGames: 5}, stored: 3}
	got, limited := c.limitConcurrentTodo([]int{1, 2, 3, 4})
	if !limited || len(got) != 2 || got[0] != 1 || got[1] != 2 {
		t.Fatalf("limitConcurrentTodo = %v, %v; want [1 2], true", got, limited)
	}

	c.cfg.MaxGames = 0
	got, limited = c.limitConcurrentTodo([]int{1, 2, 3, 4})
	if limited || len(got) != 4 {
		t.Fatalf("unlimited limitConcurrentTodo = %v, %v; want all games, false", got, limited)
	}
}

func TestB2i(t *testing.T) {
	if b2i(true) != 1 || b2i(false) != 0 {
		t.Errorf("b2i(true)=%d b2i(false)=%d, want 1 and 0", b2i(true), b2i(false))
	}
}
