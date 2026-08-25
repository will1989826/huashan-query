package huashan

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"

	"huashanquery/internal/token"
)

type fakeTP struct {
	cur, ref, nick string
	refreshed      int
}

func (f *fakeTP) Current() (string, string, token.Reason) { return f.cur, f.nick, token.ReasonOK }
func (f *fakeTP) Refresh() (string, string, token.Reason) {
	f.refreshed++
	return f.ref, f.nick, token.ReasonOK
}

func newClient(tp TokenProvider, base string) *Client {
	return &Client{TP: tp, HTTP: http.DefaultClient, Base: base}
}

// 401 → 强刷令牌 → 用新令牌重试成功（对应令牌被吊销/重新登录）。
func TestGet401RefreshRetry(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer GOOD" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Write([]byte(`{"ok":1}`))
	}))
	defer srv.Close()
	tp := &fakeTP{cur: "BAD", ref: "GOOD"}
	c := newClient(tp, srv.URL)
	b, err := c.get(context.Background(), "/x", true)
	if err != nil {
		t.Fatalf("expected success after refresh, got %v", err)
	}
	if !strings.Contains(string(b), `"ok":1`) {
		t.Fatalf("unexpected body %s", b)
	}
	if tp.refreshed != 1 {
		t.Fatalf("expected exactly one refresh, got %d", tp.refreshed)
	}
}

// 刷新后仍 401 → 返回 401 APIError（需重新登录微信）。
func TestGet401Persists(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()
	c := newClient(&fakeTP{cur: "A", ref: "B"}, srv.URL)
	_, err := c.get(context.Background(), "/x", true)
	ae, ok := err.(*APIError)
	if !ok || ae.Status != http.StatusUnauthorized {
		t.Fatalf("expected 401 APIError, got %#v", err)
	}
}

// 错误信封归一：200+error → 502；非 200 → 原状态 + 抽出的消息；无消息退回 HTTP <status>。
func TestErrorEnvelope(t *testing.T) {
	cases := []struct {
		name    string
		status  int
		body    string
		wantSt  int
		wantMsg string
	}{
		{"200 with error field", 200, `{"error":{"message":"boom"}}`, http.StatusBadGateway, "boom"},
		{"500 verbose", 500, `{"error":{"verbose_message":"bad"}}`, 500, "bad"},
		{"404 plain", 404, `not json`, 404, "HTTP 404"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tc.status)
				w.Write([]byte(tc.body))
			}))
			defer srv.Close()
			c := newClient(&fakeTP{}, srv.URL)
			_, err := c.get(context.Background(), "/x", false)
			ae, ok := err.(*APIError)
			if !ok || ae.Status != tc.wantSt || ae.Message != tc.wantMsg {
				t.Fatalf("got %#v, want status=%d msg=%q", err, tc.wantSt, tc.wantMsg)
			}
		})
	}
}

// gamesServer 按 page 返回指定条数与可选 total_items；每条带 {"page":N} 以便校验拼接顺序。
func gamesServer(t *testing.T, pageItems map[int]int, total *int) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		page, _ := strconv.Atoi(r.URL.Query().Get("page"))
		n := pageItems[page]
		items := make([]json.RawMessage, n)
		for i := range items {
			items[i] = json.RawMessage(fmt.Sprintf(`{"page":%d}`, page))
		}
		out := map[string]any{"items": items}
		if total != nil {
			out["total_items"] = *total
		}
		json.NewEncoder(w).Encode(out)
	}))
}

// 已知总数：按 ceil(total/100) 并发拉取整数页，拼接顺序须按页递增。
func TestPlayerGamesKnownTotalConcurrent(t *testing.T) {
	total := 250
	srv := gamesServer(t, map[int]int{1: 100, 2: 100, 3: 50}, &total)
	defer srv.Close()
	items, trunc, err := newClient(&fakeTP{cur: "T", ref: "T"}, srv.URL).PlayerGames(context.Background(), "1", "ALL")
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 250 || trunc {
		t.Fatalf("got n=%d trunc=%v, want 250/false", len(items), trunc)
	}
	last := 0 // 顺序校验：并发拉取但按页下标拼接，page 必须非递减
	for _, it := range items {
		var d struct {
			Page int `json:"page"`
		}
		json.Unmarshal(it, &d)
		if d.Page < last {
			t.Fatalf("out-of-order page %d after %d", d.Page, last)
		}
		last = d.Page
	}
}

func TestPlayerGamesUnknownTotalShortPageEnds(t *testing.T) {
	srv := gamesServer(t, map[int]int{1: 100, 2: 100, 3: 50}, nil)
	defer srv.Close()
	items, _, err := newClient(&fakeTP{cur: "T", ref: "T"}, srv.URL).PlayerGames(context.Background(), "1", "ALL")
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 250 {
		t.Fatalf("unknown total short page: got n=%d, want 250", len(items))
	}
}

func TestPlayerGamesEmptyPageGuard(t *testing.T) {
	srv := gamesServer(t, map[int]int{1: 100}, nil) // page2+ → 0 条
	defer srv.Close()
	items, _, err := newClient(&fakeTP{cur: "T", ref: "T"}, srv.URL).PlayerGames(context.Background(), "1", "ALL")
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 100 {
		t.Fatalf("empty page guard: got n=%d, want 100", len(items))
	}
}

func TestPlayerGamesTruncation(t *testing.T) {
	total := 1_000_000_000
	pages := map[int]int{}
	for p := 1; p <= gamesMaxPage+5; p++ {
		pages[p] = gamesPerPage
	}
	srv := gamesServer(t, pages, &total)
	defer srv.Close()
	items, trunc, err := newClient(&fakeTP{cur: "T", ref: "T"}, srv.URL).PlayerGames(context.Background(), "1", "ALL")
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != gamesMaxPage*gamesPerPage || !trunc {
		t.Fatalf("truncation: got n=%d trunc=%v, want %d/true", len(items), trunc, gamesMaxPage*gamesPerPage)
	}
}

// PlayerGames：zone=ALL 不带 zone_id；具体赛区带 zone_id。
func TestPlayerGamesZoneParam(t *testing.T) {
	var mu sync.Mutex
	var gotZone []string
	total := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		gotZone = append(gotZone, r.URL.Query().Get("zone_id"))
		mu.Unlock()
		json.NewEncoder(w).Encode(map[string]any{"items": []json.RawMessage{}, "total_items": total})
	}))
	defer srv.Close()
	c := newClient(&fakeTP{cur: "T", ref: "T"}, srv.URL)
	c.PlayerGames(context.Background(), "1", "ALL")
	c.PlayerGames(context.Background(), "1", "SD")
	if len(gotZone) != 2 || gotZone[0] != "" || gotZone[1] != "SD" {
		t.Fatalf("zone params = %#v, want ['' 'SD']", gotZone)
	}
}

// Session 只回昵称与到期时间，由令牌载荷解出 exp；令牌本身不返回。
func TestSession(t *testing.T) {
	payload := base64.RawURLEncoding.EncodeToString([]byte(`{"exp":1893456000}`))
	tok := "h." + payload + ".s"
	c := newClient(&fakeTP{cur: tok, nick: "阿三"}, "")
	nick, exp, reason := c.Session(false)
	if nick != "阿三" || exp != 1893456000 || reason != string(token.ReasonOK) {
		t.Fatalf("Session = (%q,%d,%q), want (阿三,1893456000,ok)", nick, exp, reason)
	}
}

// PlayerStats：zone 恒传(含 ALL)、leagueTier=1 固定、season 非空才带。
func TestPlayerStatsQuery(t *testing.T) {
	var got string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.URL.RawQuery
		w.Write([]byte(`{}`))
	}))
	defer srv.Close()
	c := newClient(&fakeTP{cur: "T", ref: "T"}, srv.URL)
	c.PlayerStats(context.Background(), "8178", "ALL", "")
	if !strings.Contains(got, "zone_id=ALL") || !strings.Contains(got, "leagueTier=1") || strings.Contains(got, "season_id") {
		t.Fatalf("stats query without season = %q", got)
	}
	c.PlayerStats(context.Background(), "8178", "SD", "6")
	if !strings.Contains(got, "season_id=6") {
		t.Fatalf("stats query with season = %q", got)
	}
}

// PlayerLatestSect：size=1、season/zone 非 ALL 才带；返回最新一场门派名；无出场记录返回空串。
func TestPlayerLatestSectQuery(t *testing.T) {
	var got string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.URL.RawQuery
		if strings.Contains(r.URL.Path, "/9/") {
			w.Write([]byte(`{"total_items":0,"items":[]}`))
			return
		}
		w.Write([]byte(`{"total_items":3,"items":[{"sect_name":"任易门"}]}`))
	}))
	defer srv.Close()
	c := newClient(&fakeTP{cur: "T", ref: "T"}, srv.URL)

	name, err := c.PlayerLatestSect(context.Background(), "7053", "SD", "29")
	if err != nil || name != "任易门" {
		t.Fatalf("scoped latest sect = (%q,%v)", name, err)
	}
	if !strings.Contains(got, "size=1") || !strings.Contains(got, "zone_id=SD") || !strings.Contains(got, "season_id=29") {
		t.Fatalf("query = %q", got)
	}

	// zone=ALL：不带 zone_id。
	if _, err := c.PlayerLatestSect(context.Background(), "7053", "ALL", "29"); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(got, "zone_id") {
		t.Fatalf("ALL zone should omit zone_id: %q", got)
	}

	// 无出场记录：空串、无错误。
	name, err = c.PlayerLatestSect(context.Background(), "9", "SD", "29")
	if err != nil || name != "" {
		t.Fatalf("no appearance = (%q,%v)", name, err)
	}
}
