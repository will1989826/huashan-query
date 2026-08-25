package huashan

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

type interruptedBody struct{ sent bool }

func (b *interruptedBody) Read(p []byte) (int, error) {
	if !b.sent {
		b.sent = true
		return copy(p, `{"partial":`), nil
	}
	return 0, errors.New("read interrupted")
}

func (*interruptedBody) Close() error { return nil }

func TestNewClientDefaults(t *testing.T) {
	tp := &fakeTP{}
	c := New(tp)
	if c.TP != tp || c.HTTP == nil || c.HTTP.Timeout != 30*time.Second {
		t.Fatalf("New() = %#v", c)
	}
	if c.Base != "https://v2.huashan.tv/api" {
		t.Fatalf("Base = %q", c.Base)
	}
	if got := (&APIError{Message: "boom"}).Error(); got != "boom" {
		t.Fatalf("APIError.Error() = %q", got)
	}
}

func TestSearchAndGameEndpoints(t *testing.T) {
	var searchSeen, gameSeen bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/stats/club-players":
			searchSeen = true
			if r.URL.Query().Get("page") != "1" || r.URL.Query().Get("size") != "30" || r.URL.Query().Get("player_name") != "张 三&x" {
				t.Errorf("search query = %q", r.URL.RawQuery)
			}
			if got := r.Header.Get("Authorization"); got != "" {
				t.Errorf("search unexpectedly authenticated: %q", got)
			}
			_, _ = w.Write([]byte(`{"items":[]}`))
		case r.URL.Path == "/werewolves/games/g 1":
			gameSeen = true
			if got := r.Header.Get("Authorization"); got != "Bearer TOKEN" {
				t.Errorf("game auth = %q", got)
			}
			_, _ = w.Write([]byte(`{"game_id":"g 1"}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	c := newClient(&fakeTP{cur: "TOKEN"}, srv.URL)
	if _, err := c.SearchPlayers(context.Background(), "张 三&x"); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Game(context.Background(), "g 1"); err != nil {
		t.Fatal(err)
	}
	if !searchSeen || !gameSeen {
		t.Fatalf("searchSeen=%v gameSeen=%v", searchSeen, gameSeen)
	}
}

func TestEventEndpoints(t *testing.T) {
	want := map[string]string{
		"/system/dicts/suites/season":      "",
		"/system/dicts/suites/season.type": "",
		"/settings/editions":               "",
		"/settings/rpts":                   "",
		"/werewolves/sects/门 派":            "",
		"/settings/players":                "sect_id=门 派",
		"/stats/sect-stats":                "page=2&season_id=29&season_type_id=4&size=500&zone_id=SD",
		"/stats/players/games":             "page=3&season_id=29&season_type_id=4&size=500&zone_id=SD",
	}
	seen := map[string]bool{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		query, ok := want[r.URL.Path]
		if !ok {
			http.NotFound(w, r)
			return
		}
		if got := r.Header.Get("Authorization"); got != "Bearer TOKEN" {
			t.Errorf("%s auth = %q", r.URL.Path, got)
		}
		if query != "" {
			values, _ := url.ParseQuery(query)
			if got := r.URL.Query(); fmt.Sprint(got) != fmt.Sprint(values) {
				t.Errorf("%s query = %v, want %v", r.URL.Path, got, values)
			}
		}
		seen[r.URL.Path] = true
		_, _ = w.Write([]byte(`[]`))
	}))
	defer srv.Close()
	c := newClient(&fakeTP{cur: "TOKEN"}, srv.URL)
	ctx := context.Background()
	calls := []func() ([]byte, error){
		func() ([]byte, error) { return c.EventSeasons(ctx) },
		func() ([]byte, error) { return c.EventSeasonTypes(ctx) },
		func() ([]byte, error) { return c.Editions(ctx) },
		func() ([]byte, error) { return c.Roles(ctx) },
		func() ([]byte, error) { return c.Team(ctx, "门 派") },
		func() ([]byte, error) { return c.TeamMembers(ctx, "门 派") },
		func() ([]byte, error) { return c.SectStats(ctx, "29", "4", "SD", 2, 500) },
		func() ([]byte, error) { return c.EventPlayerStats(ctx, "29", "4", "SD", 3, 500) },
	}
	for _, call := range calls {
		if _, err := call(); err != nil {
			t.Fatal(err)
		}
	}
	if len(seen) != len(want) {
		t.Fatalf("seen=%v want=%v", seen, want)
	}
}

// addZoneID：SectStats/EventPlayerStats 对 ALL 或空赛区不带 zone_id，具体赛区才带。
func TestEventEndpointsZoneOmittedForAll(t *testing.T) {
	var seen []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r.URL.Query().Get("zone_id"))
		_, _ = w.Write([]byte(`[]`))
	}))
	defer srv.Close()
	c := newClient(&fakeTP{cur: "TOKEN"}, srv.URL)
	ctx := context.Background()
	c.SectStats(ctx, "29", "4", "ALL", 1, 10)
	c.SectStats(ctx, "29", "4", "", 1, 10)
	c.EventPlayerStats(ctx, "29", "4", "ALL", 1, 10)
	c.EventPlayerStats(ctx, "29", "4", "SD", 1, 10)
	want := []string{"", "", "", "SD"}
	if fmt.Sprint(seen) != fmt.Sprint(want) {
		t.Fatalf("zone_id seen=%v want=%v", seen, want)
	}
}

func TestSessionForceRefresh(t *testing.T) {
	tp := &fakeTP{ref: "not-a-jwt", nick: "刷新账号"}
	c := newClient(tp, "")
	nick, exp, _ := c.Session(true)
	if nick != "刷新账号" || exp != 0 || tp.refreshed != 1 {
		t.Fatalf("Session(true) = (%q,%d), refreshes=%d", nick, exp, tp.refreshed)
	}
}

func TestDoErrorPaths(t *testing.T) {
	t.Run("invalid URL", func(t *testing.T) {
		c := newClient(&fakeTP{}, "://bad")
		_, _, err := c.do(context.Background(), "/x", false, false)
		if ae, ok := err.(*APIError); !ok || ae.Status != http.StatusBadGateway {
			t.Fatalf("error = %#v", err)
		}
	})

	t.Run("transport failure", func(t *testing.T) {
		c := newClient(&fakeTP{}, "http://example.invalid")
		c.HTTP = &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			return nil, errors.New("dial failed")
		})}
		_, _, err := c.do(context.Background(), "/x", false, false)
		if ae, ok := err.(*APIError); !ok || ae.Status != http.StatusBadGateway || !strings.Contains(ae.Message, "dial failed") {
			t.Fatalf("error = %#v", err)
		}
	})

	t.Run("context cancellation", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		c := newClient(&fakeTP{}, "http://example.invalid")
		c.HTTP = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
			return nil, r.Context().Err()
		})}
		_, _, err := c.do(ctx, "/x", false, false)
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("error = %v", err)
		}
	})

	t.Run("interrupted response body", func(t *testing.T) {
		c := newClient(&fakeTP{}, "http://example.invalid")
		c.HTTP = &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: &interruptedBody{}}, nil
		})}
		_, _, err := c.do(context.Background(), "/x", false, false)
		if ae, ok := err.(*APIError); !ok || !strings.Contains(ae.Message, "读取失败") {
			t.Fatalf("error = %#v", err)
		}
	})
}

func TestPlayerGamesFirstPageEdges(t *testing.T) {
	t.Run("empty first page", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte(`{"total_items":0,"items":[]}`))
		}))
		defer srv.Close()
		items, trunc, err := newClient(&fakeTP{cur: "T"}, srv.URL).PlayerGames(context.Background(), "1", "ALL")
		if err != nil || trunc || len(items) != 0 {
			t.Fatalf("items=%d trunc=%v err=%v", len(items), trunc, err)
		}
	})

	t.Run("single page", func(t *testing.T) {
		var hits int
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			hits++
			_, _ = w.Write([]byte(`{"total_items":1,"items":[{"id":1}]}`))
		}))
		defer srv.Close()
		items, trunc, err := newClient(&fakeTP{cur: "T"}, srv.URL).PlayerGames(context.Background(), "1", "ALL")
		if err != nil || trunc || len(items) != 1 || hits != 1 {
			t.Fatalf("items=%d trunc=%v hits=%d err=%v", len(items), trunc, hits, err)
		}
	})

	t.Run("malformed page", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte(`{"items":`))
		}))
		defer srv.Close()
		_, _, err := newClient(&fakeTP{cur: "T"}, srv.URL).PlayerGames(context.Background(), "1", "ALL")
		if ae, ok := err.(*APIError); !ok || ae.Status != http.StatusBadGateway {
			t.Fatalf("error = %#v", err)
		}
	})
}

func TestGamesFirstPageAndRest(t *testing.T) {
	page := func(n int) string {
		return `{"total_items":150,"items":[` + strings.TrimSuffix(strings.Repeat("{},", n), ",") + `]}`
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Query().Get("page") {
		case "1":
			w.Write([]byte(page(100)))
		case "2":
			w.Write([]byte(page(50)))
		default:
			w.Write([]byte(`{"total_items":150,"items":[]}`))
		}
	}))
	defer srv.Close()
	c := newClient(&fakeTP{cur: "T", ref: "T"}, srv.URL)

	first, total, err := c.GamesFirstPage(context.Background(), "1", "ALL")
	if err != nil || total != 150 || len(first) != 100 {
		t.Fatalf("first page: len=%d total=%d err=%v", len(first), total, err)
	}
	// GamesRest 给定首页+总数，拼装全量（首页 100 + 第 2 页 50 = 150），无截断。
	all, trunc, err := c.GamesRest(context.Background(), "1", "ALL", first, total)
	if err != nil || trunc || len(all) != 150 {
		t.Fatalf("rest: len=%d trunc=%v err=%v", len(all), trunc, err)
	}
}

func TestPlayerGamesPageFailures(t *testing.T) {
	// 重试退避调零，测试不真的睡。
	defer func(b []time.Duration) { gamesRetryBackoff = b }(gamesRetryBackoff)
	gamesRetryBackoff = []time.Duration{0, 0}

	t.Run("known total: transient page failure tolerated as partial", func(t *testing.T) {
		// 第 2 页恒 503（瞬时）：重试仍失败 → 跳过该页、标记不完整，但不放弃已得数据。
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Query().Get("page") == "1" {
				_, _ = w.Write([]byte(`{"total_items":200,"items":[{}]}`))
				return
			}
			w.WriteHeader(http.StatusServiceUnavailable)
		}))
		defer srv.Close()
		items, trunc, err := newClient(&fakeTP{cur: "T"}, srv.URL).PlayerGames(context.Background(), "1", "ALL")
		if err != nil || !trunc || len(items) != 1 {
			t.Fatalf("expected partial success: items=%d trunc=%v err=%v", len(items), trunc, err)
		}
	})

	t.Run("known total: 401 is fatal, aborts all", func(t *testing.T) {
		// 401（令牌失效）是唯一致命错误：中止全部、上抛，不做部分容忍。
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Query().Get("page") == "1" {
				_, _ = w.Write([]byte(`{"total_items":200,"items":[{}]}`))
				return
			}
			w.WriteHeader(http.StatusUnauthorized)
		}))
		defer srv.Close()
		_, _, err := newClient(&fakeTP{cur: "T"}, srv.URL).PlayerGames(context.Background(), "1", "ALL")
		if ae, ok := err.(*APIError); !ok || ae.Status != http.StatusUnauthorized {
			t.Fatalf("error = %#v", err)
		}
	})

	t.Run("known total: transient recovers on retry → full success", func(t *testing.T) {
		// 第 2 页前两次 503、第三次成功：重试吃掉瞬时抖动，最终拼齐 total(150)、无截断。
		var p2 int32
		page := func(n int) string {
			return `{"total_items":150,"items":[` + strings.TrimSuffix(strings.Repeat("{},", n), ",") + `]}`
		}
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Query().Get("page") == "1" {
				_, _ = w.Write([]byte(page(100)))
				return
			}
			if atomic.AddInt32(&p2, 1) < 3 {
				w.WriteHeader(http.StatusServiceUnavailable)
				return
			}
			_, _ = w.Write([]byte(page(50)))
		}))
		defer srv.Close()
		items, trunc, err := newClient(&fakeTP{cur: "T"}, srv.URL).PlayerGames(context.Background(), "1", "ALL")
		if err != nil || trunc || len(items) != 150 {
			t.Fatalf("expected full success after retry: items=%d trunc=%v err=%v", len(items), trunc, err)
		}
	})

	t.Run("known total: successful pages under-fill total → trunc", func(t *testing.T) {
		// 各页都 200 成功，但拼接条数(100)< total(150)：第 2 页成功却返回 0 条 → 应标记不完整。
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Query().Get("page") == "1" {
				_, _ = w.Write([]byte(`{"total_items":150,"items":[` + strings.TrimSuffix(strings.Repeat("{},", 100), ",") + `]}`))
				return
			}
			_, _ = w.Write([]byte(`{"total_items":150,"items":[]}`)) // 成功但空页
		}))
		defer srv.Close()
		items, trunc, err := newClient(&fakeTP{cur: "T"}, srv.URL).PlayerGames(context.Background(), "1", "ALL")
		if err != nil || !trunc || len(items) != 100 {
			t.Fatalf("under-filled total must mark trunc: items=%d trunc=%v err=%v", len(items), trunc, err)
		}
	})

	t.Run("known total but first page empty → trunc", func(t *testing.T) {
		// total>0 但第 1 页空、后续也空：拼接为空且 < total → 不完整（不静默当作 0 场完整数据）。
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte(`{"total_items":150,"items":[]}`))
		}))
		defer srv.Close()
		items, trunc, err := newClient(&fakeTP{cur: "T"}, srv.URL).PlayerGames(context.Background(), "1", "ALL")
		if err != nil || !trunc || len(items) != 0 {
			t.Fatalf("empty first with total>0 must mark trunc: items=%d trunc=%v err=%v", len(items), trunc, err)
		}
	})

	t.Run("known total: pages over-fill total → trunc", func(t *testing.T) {
		// total 报 150，但两页各返回 100（分页漂移/期间新增）→ 拼接 200 > total：无法保证无重复无遗漏，标记不完整。
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte(`{"total_items":150,"items":[` + strings.TrimSuffix(strings.Repeat("{},", 100), ",") + `]}`))
		}))
		defer srv.Close()
		items, trunc, err := newClient(&fakeTP{cur: "T"}, srv.URL).PlayerGames(context.Background(), "1", "ALL")
		if err != nil || !trunc || len(items) != 200 {
			t.Fatalf("over-filled total must mark trunc: items=%d trunc=%v err=%v", len(items), trunc, err)
		}
	})

	t.Run("total=0 but first page non-empty → trunc", func(t *testing.T) {
		// total 报 0 却返回了行：反向不一致，同样不可当完整。
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte(`{"total_items":0,"items":[{},{}]}`))
		}))
		defer srv.Close()
		items, trunc, err := newClient(&fakeTP{cur: "T"}, srv.URL).PlayerGames(context.Background(), "1", "ALL")
		if err != nil || !trunc || len(items) != 2 {
			t.Fatalf("total=0 with rows must mark trunc: items=%d trunc=%v err=%v", len(items), trunc, err)
		}
	})

	t.Run("unknown total sequential page fails", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Query().Get("page") == "1" {
				items := strings.Repeat(`{},`, gamesPerPage-1) + `{}`
				_, _ = io.WriteString(w, `{"items":[`+items+`]}`)
				return
			}
			w.WriteHeader(http.StatusBadGateway)
		}))
		defer srv.Close()
		_, _, err := newClient(&fakeTP{cur: "T"}, srv.URL).PlayerGames(context.Background(), "1", "ALL")
		if ae, ok := err.(*APIError); !ok || ae.Status != http.StatusBadGateway {
			t.Fatalf("error = %#v", err)
		}
	})
}
