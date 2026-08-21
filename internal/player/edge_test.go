package player

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"huashanquery/internal/huashan"
)

func serviceForEdgeTest(base string) *Service {
	c := huashan.New(fakeTP{tok: "TOKEN"})
	c.Base = base
	return New(c, 4)
}

func TestGetSubCallerCancelDoesNotPoisonOthers(t *testing.T) {
	// P1 回归：共享拉取跑在后台 ctx 上。调用方 A 取消只让 A 离场，搭同一子键车的 B 仍拿到成功结果。
	s := newStore(10)
	p := s.player("x")
	release := make(chan struct{})
	var calls int32
	fetch := func(context.Context) (any, error) {
		atomic.AddInt32(&calls, 1)
		<-release // 拉取悬停，模拟慢请求
		return "ok", nil
	}

	ctxA, cancelA := context.WithCancel(context.Background())
	aErr := make(chan error, 1)
	go func() { _, e := p.getSub(ctxA, "k", fetch); aErr <- e }() // A 发起拉取

	// 等 A 起了在途拉取，再让 B 搭车（同键）。
	waitFor(t, func() bool { return atomic.LoadInt32(&calls) == 1 })
	bVal := make(chan any, 1)
	bErr := make(chan error, 1)
	go func() { v, e := p.getSub(context.Background(), "k", fetch); bVal <- v; bErr <- e }()

	// 必须等 B 真正登记为等待者(refs==2)再取消 A：否则 A 归零会取消并删除该 flight，B 只能重起一次拉取。
	waitFor(t, func() bool {
		p.mu.Lock()
		defer p.mu.Unlock()
		e := p.subs["k"]
		return e != nil && e.refs == 2
	})

	cancelA() // A 取消：还有 B 在场，拉取不应被取消
	if e := <-aErr; e != context.Canceled {
		t.Fatalf("A should observe its own cancel, got %v", e)
	}
	close(release) // 放行后台拉取
	if e := <-bErr; e != nil {
		t.Fatalf("B must not be poisoned by A's cancel: %v", e)
	}
	if v := <-bVal; v != "ok" {
		t.Fatalf("B value = %v", v)
	}
	if atomic.LoadInt32(&calls) != 1 {
		t.Fatalf("shared fetch must run once, got %d", calls)
	}
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	for i := 0; i < 200; i++ {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("condition not met in time")
}

// P2 回归：多个子键拉取同时完成时，淘汰按锁保护的 done 判定——最后获锁完成者会把已完成的其他项
// 正确视为可淘汰，不会互相误判在途而永久超上限。所有拉取卡在同一屏障、同时放行以复现该并发时序。
func TestSubEvictionUnderSimultaneousCompletion(t *testing.T) {
	p := &playerCache{subs: map[string]*entry{}}
	n := maxSubsPerPlayer + 20
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		key := fmt.Sprintf("games|Z%d", i)
		wg.Add(1)
		go func() {
			defer wg.Done()
			p.getSub(context.Background(), key, func(context.Context) (any, error) {
				<-start // 卡在屏障：确保插入期彼此都在途、无从淘汰，子键堆到 n
				return &gameIndex{games: make([]Game, 1)}, nil
			})
		}()
	}
	// 等所有子键都插入并在途（此时都未完成，不会被淘汰）。
	waitFor(t, func() bool { p.mu.Lock(); defer p.mu.Unlock(); return len(p.subs) == n })
	close(start) // 同时放行 → 全部并发完成
	wg.Wait()
	p.mu.Lock()
	got := len(p.subs)
	p.mu.Unlock()
	if got > maxSubsPerPlayer {
		t.Fatalf("subs=%d exceeds hard cap %d after simultaneous completion", got, maxSubsPerPlayer)
	}
}

// P2 回归：最后一个等待者离开且拉取未完成 → 取消后台拉取并删除 flight（不留孤儿重任务）。
func TestGetSubCancelsOrphanWhenLastWaiterLeaves(t *testing.T) {
	p := &playerCache{subs: map[string]*entry{}}
	gotCtx := make(chan context.Context, 1)
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		p.getSub(ctx, "k", func(fctx context.Context) (any, error) {
			gotCtx <- fctx
			<-fctx.Done() // 悬停直到被取消
			return nil, fctx.Err()
		})
	}()
	fctx := <-gotCtx // 拉取已开始
	cancel()         // 唯一等待者取消 → 应连带取消后台拉取
	select {
	case <-fctx.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("orphan fetch was not cancelled after last waiter left")
	}
	// flight 应被删除（下次请求会重起，而非搭上已取消的车）。
	waitFor(t, func() bool { p.mu.Lock(); defer p.mu.Unlock(); _, ok := p.subs["k"]; return !ok })
}

func TestServicePassthroughs(t *testing.T) {
	var searchSeen, gameSeen bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/stats/club-players":
			searchSeen = r.URL.Query().Get("player_name") == "张三"
			_, _ = w.Write([]byte(`{"items":[]}`))
		case r.URL.Path == "/werewolves/games/99":
			gameSeen = r.Header.Get("Authorization") == "Bearer TOKEN"
			_, _ = w.Write([]byte(`{"game_id":99}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	svc := serviceForEdgeTest(srv.URL)
	if nick, exp, reason := svc.Session(false); nick != "n" || exp != 0 || reason != "" {
		t.Fatalf("Session() = (%q,%d,%q)", nick, exp, reason)
	}
	if _, err := svc.Search(context.Background(), "张三"); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Game(context.Background(), "99"); err != nil {
		t.Fatal(err)
	}
	if !searchSeen || !gameSeen {
		t.Fatalf("searchSeen=%v gameSeen=%v", searchSeen, gameSeen)
	}
}

func TestErrorStatus(t *testing.T) {
	if status, msg := ErrorStatus(&huashan.APIError{Status: http.StatusTeapot, Message: "tea"}); status != http.StatusTeapot || msg != "tea" {
		t.Fatalf("APIError => (%d,%q)", status, msg)
	}
	if status, msg := ErrorStatus(errors.New("plain")); status != http.StatusBadGateway || msg != "plain" {
		t.Fatalf("plain error => (%d,%q)", status, msg)
	}
	if !is401(&huashan.APIError{Status: http.StatusUnauthorized}) || is401(errors.New("no")) {
		t.Fatal("is401 classification")
	}
}

func TestDetailBothFailuresPrefersUnauthorized(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/stats/players/games/") {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if strings.Contains(r.URL.Path, "/stats/games/players/") {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		http.NotFound(w, r)
	}))
	defer srv.Close()

	_, err := serviceForEdgeTest(srv.URL).Detail(context.Background(), Query{ID: "1", Zone: "ALL"})
	if ae, ok := err.(*huashan.APIError); !ok || ae.Status != http.StatusUnauthorized {
		t.Fatalf("error = %#v", err)
	}
}

func TestDetailInvalidGameIsReportedAndRetried(t *testing.T) {
	var gameHits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.Contains(r.URL.Path, "/stats/players/games/"):
			atomic.AddInt32(&gameHits, 1)
			// 外层 JSON 合法，但单场字段类型错误，触发 wireGame 的强类型校验。
			_, _ = w.Write([]byte(`{"total_items":1,"items":[{"sect_name":123}]}`))
		case strings.Contains(r.URL.Path, "/stats/games/players/"):
			_, _ = w.Write([]byte(fakeStats))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	svc := serviceForEdgeTest(srv.URL)
	v, err := svc.Detail(context.Background(), Query{ID: "1", Zone: "ALL"})
	if err != nil {
		t.Fatalf("stats succeeded, detail should degrade partially: %v", err)
	}
	if v.GamesError == "" || !strings.Contains(v.GamesError, "解析失败") {
		t.Fatalf("GamesError = %q", v.GamesError)
	}
	first := atomic.LoadInt32(&gameHits)
	_, _ = svc.Detail(context.Background(), Query{ID: "1", Zone: "ALL"})
	if atomic.LoadInt32(&gameHits) <= first {
		t.Fatal("invalid game index must not be cached")
	}
}

func TestComputeHelperEdges(t *testing.T) {
	if got := orderedKV(nil); got != nil {
		t.Fatalf("orderedKV(nil) = %v", got)
	}
	if got := orderedKV(json.RawMessage(`[]`)); got != nil {
		t.Fatalf("orderedKV(array) = %v", got)
	}
	if got := orderedKV(json.RawMessage(`not-json`)); got != nil {
		t.Fatalf("orderedKV(invalid) = %v", got)
	}

	if got := unquote(json.RawMessage(`"2"`)); got != "2" {
		t.Fatalf("unquote string = %q", got)
	}
	if got := unquote(json.RawMessage(`3`)); got != "3" {
		t.Fatalf("unquote number = %q", got)
	}
	if got := unquote(json.RawMessage(`true`)); got != "" {
		t.Fatalf("unquote bool = %q", got)
	}
	if got := unquote(nil); got != "" {
		t.Fatalf("unquote nil = %q", got)
	}

	games := []Game{
		{SeasonID: 2, HasSeason: true, SectBase: "B"},
		{SeasonID: 1, HasSeason: true, SectBase: "A"},
		{SeasonID: 2, HasSeason: true, SectBase: "B"},
	}
	idx := allIdx(len(games))
	if got := seasonCandidates(games, idx, "3"); len(got) != 3 || got[0] != 3 || got[1] != 2 || got[2] != 1 {
		t.Fatalf("seasonCandidates = %v", got)
	}
	if got := seasonCandidates(games, idx, "bad"); len(got) != 2 {
		t.Fatalf("seasonCandidates bad current = %v", got)
	}
	if got := sectCandidates(games, idx, "Z"); len(got) != 3 || got[0] != "Z" {
		t.Fatalf("sectCandidates = %v", got)
	}
	if !matchSeason(Game{}, "") || matchSeason(Game{}, "1") || !matchSeason(Game{SeasonID: 1, HasSeason: true}, "1") {
		t.Fatal("matchSeason edge cases")
	}
}

func TestGameCacheReusesAndRetries(t *testing.T) {
	var hits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/werewolves/games/") {
			n := atomic.AddInt32(&hits, 1)
			if strings.HasSuffix(r.URL.Path, "/bad") {
				w.WriteHeader(http.StatusServiceUnavailable)
				return
			}
			_, _ = w.Write([]byte(`{"game_id":7,"n":` + strconv.Itoa(int(n)) + `}`))
			return
		}
		http.NotFound(w, r)
	}))
	defer srv.Close()

	svc := serviceForEdgeTest(srv.URL)
	// 成功后按 gid 缓存：重复打开只拉一次网络。
	a, err := svc.Game(context.Background(), "7")
	if err != nil {
		t.Fatal(err)
	}
	b, err := svc.Game(context.Background(), "7")
	if err != nil {
		t.Fatal(err)
	}
	if string(a) != string(b) || atomic.LoadInt32(&hits) != 1 {
		t.Fatalf("cached game should hit network once: hits=%d a=%s b=%s", hits, a, b)
	}
	// 失败不缓存：下次照常重取。
	before := atomic.LoadInt32(&hits)
	if _, err := svc.Game(context.Background(), "bad"); err == nil {
		t.Fatal("expected error for bad game")
	}
	if _, err := svc.Game(context.Background(), "bad"); err == nil {
		t.Fatal("expected error for bad game (retry)")
	}
	if atomic.LoadInt32(&hits)-before != 2 {
		t.Fatalf("failed game must not be cached: extra hits=%d", atomic.LoadInt32(&hits)-before)
	}
}

func TestCacheEdgeCases(t *testing.T) {
	s := newStore(0)
	if s.cap != defaultCacheCap || s.budget != defaultGamesBudget {
		t.Fatalf("defaults cap=%d budget=%d", s.cap, s.budget)
	}
	p := s.player("only")
	if s.evictOldestExcept(p) {
		t.Fatal("the only kept player must not be evicted")
	}

	e := &entry{ready: make(chan struct{})}
	p.subs["games|ALL"] = e
	if got := p.gameCount(); got != 0 { // 未完成(done=false)：不计入
		t.Fatalf("in-flight gameCount = %d", got)
	}
	e.val = &gameIndex{games: make([]Game, 2)}
	e.done = true // 完成标志（gameCount/淘汰按它判定，而非 ready 是否关闭）
	close(e.ready)
	if got := p.gameCount(); got != 2 {
		t.Fatalf("ready gameCount = %d", got)
	}
}
