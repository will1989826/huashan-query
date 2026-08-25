package player

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"huashanquery/internal/huashan"
	"huashanquery/internal/token"
)

// —— 纯计算 ——

func TestBaseNameAndCamp(t *testing.T) {
	if baseName("愿得一心（鲁）") != "愿得一心" || baseName("NS") != "NS" {
		t.Fatal("baseName")
	}
	for _, r := range []string{"平民", "预言家", "白痴"} {
		if !isGood(r) {
			t.Fatalf("%s should be good", r)
		}
	}
	for _, r := range []string{"狼", "狼王", "石像鬼", "血月使徒", "梦魇", "怪盗狼王"} {
		if isGood(r) {
			t.Fatalf("%s should not be good", r)
		}
	}
}

func TestAggregateKV(t *testing.T) {
	gs := []Game{{Point: 6, Win: true}, {Point: 0, MVP: true}, {Point: -1, SVP: true, BGX: true}}
	kv := aggregate(gs, allIdx(3)).kv()
	// 有序键值（数值，无标签/百分号——那是页面的活）
	wantKeys := []string{"round_total", "total_point", "round_point_avg", "win_pct", "mvp_num", "svp_num", "bgx_num"}
	if len(kv) != len(wantKeys) {
		t.Fatalf("kv len=%d want %d", len(kv), len(wantKeys))
	}
	for i, k := range wantKeys {
		if kv[i].Key != k {
			t.Fatalf("kv[%d].Key=%s want %s", i, kv[i].Key, k)
		}
	}
	got := map[string]string{}
	for _, e := range kv {
		got[e.Key] = fmt.Sprintf("%v", e.Val)
	}
	if got["round_total"] != "3" || got["total_point"] != "5" || got["round_point_avg"] != "1.67" ||
		got["win_pct"] != "33" || got["mvp_num"] != "1" || got["svp_num"] != "1" || got["bgx_num"] != "1" {
		t.Fatalf("kv values=%v", got)
	}
	if aggregate(nil, nil).kv() != nil {
		t.Fatal("empty agg should give nil kv")
	}
}

func TestRoleBreakdownDefaultOrder(t *testing.T) {
	gs := []Game{
		{Role: "平民", Point: 6, Win: true},
		{Role: "平民", Point: 0, SVP: true, BGX: true},
		{Role: "狼", Point: 5, Win: true, MVP: true},
	}
	rb := roleBreakdown(gs, allIdx(3))
	// 默认按场次降序（列排序交由页面）：平民(2) 在 狼(1) 前
	if rb[0].Role != "平民" || rb[0].N != 2 || rb[0].Avg != 3 || rb[0].Win != 50 || rb[0].BGX != 1 {
		t.Fatalf("row0=%+v", rb[0])
	}
	if rb[1].Role != "狼" || rb[1].N != 1 || rb[1].MVP != 1 {
		t.Fatalf("row1=%+v", rb[1])
	}
}

func TestOrderedKV(t *testing.T) {
	raw := json.RawMessage(`{"round_total":3,"win_pct":67,"htsp_num":2}`)
	kv := orderedKV(raw) // 保留接口键序，不翻译、不隐藏（隐藏由页面做）
	if len(kv) != 3 || kv[0].Key != "round_total" || kv[1].Key != "win_pct" || kv[2].Key != "htsp_num" {
		t.Fatalf("orderedKV=%v", kv)
	}
	if fmt.Sprintf("%v", kv[0].Val) != "3" {
		t.Fatalf("orderedKV val=%v", kv[0].Val)
	}
}

// —— 缓存：LRU / TTL / singleflight / 失效 ——

func TestStoreLRU(t *testing.T) {
	s := newStore(2)
	s.player("a")
	s.player("b")
	s.player("a") // 刷新 a 的访问序号 → b 变成最久未访问
	s.player("c") // 超容量：顶掉 b
	if s.len() != 2 {
		t.Fatalf("len=%d want 2", s.len())
	}
	if _, ok := s.ps["b"]; ok {
		t.Fatal("b should have been evicted (least-recently-accessed)")
	}
	if _, ok := s.ps["a"]; !ok {
		t.Fatal("a should survive")
	}
}

func TestStoreSingleflight(t *testing.T) {
	s := newStore(10)
	p := s.player("x")
	var calls int32
	fetch := func(context.Context) (any, error) {
		atomic.AddInt32(&calls, 1)
		time.Sleep(20 * time.Millisecond)
		return "v", nil
	}

	// 并发同键：只真正 fetch 一次（singleflight）
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); p.getSub(context.Background(), "k", fetch) }()
	}
	wg.Wait()
	if atomic.LoadInt32(&calls) != 1 {
		t.Fatalf("singleflight: calls=%d want 1", calls)
	}
	// 命中缓存（无时间过期）：再取不重新 fetch
	p.getSub(context.Background(), "k", fetch)
	if atomic.LoadInt32(&calls) != 1 {
		t.Fatalf("cache hit: calls=%d want 1", calls)
	}
}

func TestStoreErrorNotCached(t *testing.T) {
	s := newStore(10)
	p := s.player("x")
	var calls int32
	fetch := func(context.Context) (any, error) { atomic.AddInt32(&calls, 1); return nil, fmt.Errorf("boom") }
	p.getSub(context.Background(), "k", fetch)
	p.getSub(context.Background(), "k", fetch)
	if atomic.LoadInt32(&calls) != 2 {
		t.Fatalf("errors must not be cached: calls=%d want 2", calls)
	}
}

// —— Detail 端到端（假官方服务）——

const fakeStats = `{"player":{"name":"张三","avatar":"a.png"},"joined_zone_ids":[{"ordering":"SD","text":"山东赛区"}],` +
	`"honors":[{"zone_id":"SD","season_id":6,"code":"1"}],"summary":{"round_total":3,"win_pct":67},` +
	`"haoren":{"toulang_pct":10,"zhanbian_pct":80,"htsp_num":2},"langren":{"bgx_num":1,"molang_pct":50},"power":1234}`

const fakeGames = `{"total_items":2,"items":[` +
	`{"game_id":11,"play_date":"2024-01-02","season_id":6,"season_type_id":3,"round":1,"seat":3,"sect_name":"门派A（鲁）","edition_name":"狼王摄梦人","rpt_name":"平民","total_point":6,"win":1,"mvp":1,"svp":0,"bgx":0},` +
	`{"game_id":12,"play_date":"2024-01-01","season_id":6,"season_type_id":4,"round":2,"seat":4,"sect_name":"门派A（宁）","edition_name":"狼王摄梦人","rpt_name":"狼","total_point":5,"win":0,"mvp":0,"svp":0,"bgx":1}]}`

type fakeTP struct{ tok string }

func (f fakeTP) Current() (string, string, token.Reason) { return f.tok, "n", token.ReasonOK }
func (f fakeTP) Refresh() (string, string, token.Reason) { return f.tok, "n", token.ReasonOK }

func fakeService(t *testing.T, gamesHits *int32) (*Service, func()) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.Contains(r.URL.Path, "/stats/players/games/"): // 逐场分页
			if gamesHits != nil {
				atomic.AddInt32(gamesHits, 1)
			}
			if r.URL.Query().Get("page") == "1" {
				w.Write([]byte(fakeGames))
			} else {
				w.Write([]byte(`{"total_items":2,"items":[]}`))
			}
		case strings.Contains(r.URL.Path, "/stats/games/players/"): // 统计
			w.Write([]byte(fakeStats))
		default:
			w.WriteHeader(404)
		}
	}))
	c := huashan.New(fakeTP{tok: "GOOD"})
	c.Base = srv.URL
	return New(c, 50), srv.Close
}

func TestDetailNoSect(t *testing.T) {
	svc, done := fakeService(t, nil)
	defer done()
	v, err := svc.Detail(context.Background(), Query{ID: "8178", Zone: "ALL"})
	if err != nil {
		t.Fatal(err)
	}
	if v.Player.Name != "张三" || fmt.Sprintf("%v", jsonVal(v.Power)) != "1234" {
		t.Fatalf("player=%+v power=%s", v.Player, v.Power)
	}
	// 无门派：综合方块 = 接口 summary 的有序数值键值（无标签、无百分号）
	if kvVal(v.Comprehensive, "round_total") != "3" || kvVal(v.Comprehensive, "win_pct") != "67" {
		t.Fatalf("comprehensive=%v", v.Comprehensive)
	}
	// Go 不隐藏字段（隐藏由页面做）：好人局仍带 htsp_num；含 toulang_pct 供页面算头部指标
	if !kvHas(v.Good, "toulang_pct") || !kvHas(v.Good, "htsp_num") {
		t.Fatalf("good=%v", v.Good)
	}
	// 候选：赛季 [6]，门派归并为「门派A」，队伍名保留两个赛区变体
	if fmt.Sprint(v.SeasonCands) != "[6]" || fmt.Sprint(v.SectCands) != "[门派A]" {
		t.Fatalf("cands season=%v sect=%v", v.SeasonCands, v.SectCands)
	}
	if len(v.Teams) != 2 {
		t.Fatalf("teams=%v", v.Teams)
	}
	// 荣誉：原样代码/名次码（中文名与文案由页面拼）
	if len(v.Honors) != 1 || v.Honors[0].ZoneID != "SD" || v.Honors[0].Code != "1" {
		t.Fatalf("honors=%+v", v.Honors)
	}
	// 逐场：作用域内全部行（索引顺序，页面负责排序/分页），共 2 场
	if len(v.Games) != 2 {
		t.Fatalf("games=%d want 2", len(v.Games))
	}
	if len(v.Roles) != 2 {
		t.Fatalf("roles=%v", v.Roles)
	}
	if len(v.Editions) != 1 || v.Editions[0].Edition != "狼王摄梦人" || v.Editions[0].N != 2 || v.Editions[0].Avg != 5.5 {
		t.Fatalf("editions=%v", v.Editions)
	}
}

func TestDetailSectComputesFromGames(t *testing.T) {
	svc, done := fakeService(t, nil)
	defer done()
	v, err := svc.Detail(context.Background(), Query{ID: "8178", Zone: "ALL", Sect: "门派A"})
	if err != nil {
		t.Fatal(err)
	}
	// 门派维度：综合方块用逐场现算（2 场，总分 11，场均 5.5，胜率 50）
	if kvVal(v.Comprehensive, "round_total") != "2" || kvVal(v.Comprehensive, "total_point") != "11" ||
		kvVal(v.Comprehensive, "round_point_avg") != "5.5" || kvVal(v.Comprehensive, "win_pct") != "50" {
		t.Fatalf("sect comprehensive=%v", v.Comprehensive)
	}
	// 门派维度好人子集现算，不含 toulang_pct（页面据此显示“—”）
	if kvHas(v.Good, "toulang_pct") {
		t.Fatalf("sect good should not carry toulang_pct: %v", v.Good)
	}
}

func TestDetailCache(t *testing.T) {
	var hits int32
	svc, done := fakeService(t, &hits)
	defer done()
	svc.Detail(context.Background(), Query{ID: "8178", Zone: "ALL"})
	base := atomic.LoadInt32(&hits)
	// 再取同赛区（换门派作用域）→ 命中缓存，不再打官方
	svc.Detail(context.Background(), Query{ID: "8178", Zone: "ALL", Sect: "门派A"})
	if atomic.LoadInt32(&hits) != base {
		t.Fatalf("second query should hit cache, hits went %d→%d", base, atomic.LoadInt32(&hits))
	}
	if svc.CachedPlayers() != 1 {
		t.Fatalf("cached players=%d want 1", svc.CachedPlayers())
	}
}

func TestParseGame(t *testing.T) {
	// 数字/字符串数字混用都能解析；门派归并去后缀
	g, err := parseGame(json.RawMessage(`{"season_id":6,"season_type_id":4,"sect_name":"门派A（鲁）","edition_name":"梦魇守卫","rpt_name":"狼","total_point":"5","win":1,"mvp":0}`))
	if err != nil {
		t.Fatal(err)
	}
	if !g.HasSeason || g.SeasonID != 6 || g.SeasonTypeID != 4 || g.SectBase != "门派A" || g.Edition != "梦魇守卫" || g.Role != "狼" || g.Point != 5 || !g.Win || g.Good {
		t.Fatalf("parseGame got %+v", g)
	}
	// 截断/非法 JSON → 报错（不能静默成空场次）
	if _, err := parseGame(json.RawMessage(`{"season_id":6`)); err == nil {
		t.Fatal("truncated JSON should error")
	}
	// win/mvp/svp/bgx 可能是 JSON 布尔 → 按 1/0 归一（不能静默成 0）
	gb, err := parseGame(json.RawMessage(`{"rpt_name":"平民","win":true,"mvp":false,"svp":true,"bgx":true}`))
	if err != nil {
		t.Fatal(err)
	}
	if !gb.Win || gb.MVP || !gb.SVP || !gb.BGX {
		t.Fatalf("bool fields parse: win=%v mvp=%v svp=%v bgx=%v", gb.Win, gb.MVP, gb.SVP, gb.BGX)
	}
}

// 头部：只取 stats，绝不碰逐场（不被首页拖住）。
func TestDetailHeadIsStatsOnly(t *testing.T) {
	var gamesHits int32
	svc, done := fakeService(t, &gamesHits)
	defer done()
	v, err := svc.Detail(context.Background(), Query{ID: "8178", Zone: "ALL", Head: true})
	if err != nil {
		t.Fatal(err)
	}
	if atomic.LoadInt32(&gamesHits) != 0 {
		t.Fatalf("head must not fetch games, hits=%d", gamesHits)
	}
	if v.Player.Name != "张三" || kvVal(v.Comprehensive, "win_pct") != "67" {
		t.Fatalf("head should carry stats header: %+v / %v", v.Player, v.Comprehensive)
	}
	if len(v.Games) != 0 || len(v.Roles) != 0 {
		t.Fatalf("head must omit games/roles: games=%d roles=%d", len(v.Games), len(v.Roles))
	}
	if v.GamesTotalKnown {
		t.Fatalf("head must not claim a known total (games not loaded)")
	}
}

// 首屏预览：只取赛区第 1 页逐场（不取 stats），返回首页行 + 总场数。
func TestDetailFirstPagePreview(t *testing.T) {
	var gamesHits int32
	svc, done := fakeService(t, &gamesHits)
	defer done()
	v, err := svc.Detail(context.Background(), Query{ID: "8178", Zone: "ALL", FirstPage: true})
	if err != nil {
		t.Fatal(err)
	}
	if atomic.LoadInt32(&gamesHits) != 1 {
		t.Fatalf("firstpage should fetch exactly page 1, hits=%d", gamesHits)
	}
	if len(v.Games) != 2 || v.GamesTotal != 2 || !v.GamesTotalKnown {
		t.Fatalf("firstpage preview: games=%d total=%d known=%v", len(v.Games), v.GamesTotal, v.GamesTotalKnown)
	}
}

// P2/P3：官方缺 total_items 时，GamesTotal 归一为已拉行数、GamesTotalKnown=false（前端据此不谎报“共 N 场”）。
func TestDetailFirstPageUnknownTotal(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/stats/players/games/") {
			if r.URL.Query().Get("page") == "1" {
				w.Write([]byte(`{"items":[{},{},{}]}`)) // 无 total_items
			} else {
				w.Write([]byte(`{"items":[]}`))
			}
			return
		}
		w.WriteHeader(404)
	}))
	defer srv.Close()
	c := huashan.New(fakeTP{tok: "GOOD"})
	c.Base = srv.URL
	v, err := New(c, 50).Detail(context.Background(), Query{ID: "1", Zone: "ALL", FirstPage: true})
	if err != nil {
		t.Fatal(err)
	}
	if v.GamesTotal != 3 || v.GamesTotalKnown {
		t.Fatalf("unknown total: GamesTotal=%d known=%v (want 3,false)", v.GamesTotal, v.GamesTotalKnown)
	}
}

// 多页：首屏预览拉第 1 页；随后全量复用 gp1（p1 不再拉），其余页各拉一次、无重复。
func TestDetailFirstPageReusedAcrossPhases(t *testing.T) {
	var p1, p2 int32
	page := func(n int) string {
		return `{"total_items":150,"items":[` + strings.TrimSuffix(strings.Repeat("{},", n), ",") + `]}`
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.Contains(r.URL.Path, "/stats/players/games/"):
			switch r.URL.Query().Get("page") {
			case "1":
				atomic.AddInt32(&p1, 1)
				w.Write([]byte(page(100)))
			case "2":
				atomic.AddInt32(&p2, 1)
				w.Write([]byte(page(50)))
			default:
				w.Write([]byte(`{"total_items":150,"items":[]}`))
			}
		case strings.Contains(r.URL.Path, "/stats/games/players/"):
			w.Write([]byte(fakeStats))
		default:
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()
	c := huashan.New(fakeTP{tok: "GOOD"})
	c.Base = srv.URL
	svc := New(c, 50)

	pv, err := svc.Detail(context.Background(), Query{ID: "1", Zone: "ALL", FirstPage: true})
	if err != nil {
		t.Fatal(err)
	}
	if atomic.LoadInt32(&p1) != 1 || atomic.LoadInt32(&p2) != 0 {
		t.Fatalf("preview: p1=%d p2=%d (want 1,0)", p1, p2)
	}
	if len(pv.Games) != 100 || pv.GamesTotal != 150 {
		t.Fatalf("preview games=%d total=%d", len(pv.Games), pv.GamesTotal)
	}
	// 完整：第 1 页复用（p1 不增），第 2 页拉一次，角色补齐。
	f, err := svc.Detail(context.Background(), Query{ID: "1", Zone: "ALL"})
	if err != nil {
		t.Fatal(err)
	}
	if atomic.LoadInt32(&p1) != 1 {
		t.Fatalf("first page must be reused across phases: p1=%d", p1)
	}
	if atomic.LoadInt32(&p2) != 1 {
		t.Fatalf("rest page fetched once: p2=%d", p2)
	}
	if len(f.Games) != 150 || len(f.Roles) == 0 {
		t.Fatalf("full games=%d roles=%d", len(f.Games), len(f.Roles))
	}
	if f.GamesTotal != 150 || !f.GamesTotalKnown {
		t.Fatalf("full untruncated: total=%d known=%v (want 150,true)", f.GamesTotal, f.GamesTotalKnown)
	}
}

// 全量截断（缺页/达安全上限）时 GamesTotalKnown=false（完整未截断为 true，见上一测试）。
func TestDetailFullTruncatedTotalUnknown(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.Contains(r.URL.Path, "/stats/players/games/"):
			if r.URL.Query().Get("page") == "1" {
				w.Write([]byte(`{"total_items":150,"items":[` + strings.TrimSuffix(strings.Repeat("{},", 100), ",") + `]}`))
			} else {
				w.WriteHeader(http.StatusBadRequest) // 非瞬时、非鉴权：GamesRest 容忍缺页 → 标记不完整
			}
		case strings.Contains(r.URL.Path, "/stats/games/players/"):
			w.Write([]byte(fakeStats))
		default:
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()
	c := huashan.New(fakeTP{tok: "GOOD"})
	c.Base = srv.URL
	v, err := New(c, 50).Detail(context.Background(), Query{ID: "1", Zone: "ALL"})
	if err != nil {
		t.Fatal(err)
	}
	if !v.GamesTrunc || v.GamesTotalKnown {
		t.Fatalf("truncated full: trunc=%v known=%v (want true,false)", v.GamesTrunc, v.GamesTotalKnown)
	}
	if len(v.Games) != 100 {
		t.Fatalf("truncated full games=%d want 100", len(v.Games))
	}
}

// #4 回归：逐场是 player() 之后才写入缓存的，写入完成后需重查预算，
// 否则并发拉取多个重度选手时总量会持续超预算而不回收。
func TestEnforceBudgetAfterWrite(t *testing.T) {
	s := newStore(100)
	s.budget = 150
	for _, id := range []string{"a", "b"} {
		s.player(id).getSub(context.Background(), "games|ALL", func(context.Context) (any, error) { return &gameIndex{games: make([]Game, 100)}, nil })
	}
	// 两人各 100 场（player() 时对方数据尚未写入，未触发回收）；总 200 > 150。
	s.enforceBudgetNow(s.ps["b"]) // 写入后重查：保留 b，顶掉 a
	if s.len() != 1 {
		t.Fatalf("after post-write enforce want 1 kept, got %d", s.len())
	}
	if _, ok := s.ps["b"]; !ok {
		t.Fatal("kept player b should survive")
	}
}

// 缓存：总战绩条数超预算时按 LRU 顶替（兜住重度选手最坏内存）
func TestStoreGamesBudget(t *testing.T) {
	s := newStore(100)
	s.budget = 150
	add := func(id string, n int) {
		s.player(id).getSub(context.Background(), "games|ALL", func(context.Context) (any, error) { return &gameIndex{games: make([]Game, n)}, nil })
	}
	add("a", 100)
	add("b", 100) // a+b=200 > 150（预算在下次访问结算）
	s.player("a") // 触发 enforceBudget：保留 a，顶掉最久未访问的 b
	if _, ok := s.ps["b"]; ok {
		t.Fatal("b should be evicted by games budget")
	}
	if _, ok := s.ps["a"]; !ok {
		t.Fatal("kept player a should survive")
	}
}

// 缓存：单选手子键数量有上限，超出按 LRU 顶掉最久未用的已就绪子项（防单选手无限累积子缓存）。
func TestSubKeyLRUCap(t *testing.T) {
	p := &playerCache{subs: map[string]*entry{}}
	for i := 0; i < maxSubsPerPlayer+20; i++ {
		key := fmt.Sprintf("games|Z%d", i)
		p.getSub(context.Background(), key, func(context.Context) (any, error) { return &gameIndex{games: make([]Game, 1)}, nil })
	}
	if got := len(p.subs); got > maxSubsPerPlayer {
		t.Fatalf("subs=%d exceeds cap %d", got, maxSubsPerPlayer)
	}
	// 最近访问的键应仍在，最早的应被顶掉
	last := fmt.Sprintf("games|Z%d", maxSubsPerPlayer+20-1)
	if _, ok := p.subs[last]; !ok {
		t.Errorf("most-recent sub %q should be retained", last)
	}
	if _, ok := p.subs["games|Z0"]; ok {
		t.Errorf("oldest sub games|Z0 should be evicted")
	}
}

// #1 回归：统计返回非法 JSON → 明确标记 StatsError，不静默成空数据、且不缓存（可重试）
func TestDetailStatsInvalidNotCached(t *testing.T) {
	var statsHits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.Contains(r.URL.Path, "/stats/players/games/"):
			if r.URL.Query().Get("page") == "1" {
				w.Write([]byte(fakeGames))
			} else {
				w.Write([]byte(`{"total_items":2,"items":[]}`))
			}
		case strings.Contains(r.URL.Path, "/stats/games/players/"):
			atomic.AddInt32(&statsHits, 1)
			w.Write([]byte(`{"summary":{`)) // 截断的非法 JSON
		}
	}))
	defer srv.Close()
	c := huashan.New(fakeTP{tok: "GOOD"})
	c.Base = srv.URL
	svc := New(c, 50)

	v, err := svc.Detail(context.Background(), Query{ID: "1", Zone: "ALL"})
	if err != nil { // 战绩成功 → 不整体失败
		t.Fatalf("games ok should not hard-fail: %v", err)
	}
	if v.StatsError == "" {
		t.Fatal("invalid stats must surface StatsError, not silent empty")
	}
	if len(v.Comprehensive) != 0 {
		t.Fatalf("invalid stats must not produce tiles, got %v", v.Comprehensive)
	}
	first := atomic.LoadInt32(&statsHits)
	svc.Detail(context.Background(), Query{ID: "1", Zone: "ALL"}) // 未缓存 → 重新拉取
	if atomic.LoadInt32(&statsHits) <= first {
		t.Fatal("invalid stats must not be cached")
	}
}

func kvHas(kvs []KV, key string) bool {
	for _, k := range kvs {
		if k.Key == key {
			return true
		}
	}
	return false
}

func kvVal(kvs []KV, key string) string {
	for _, k := range kvs {
		if k.Key == key {
			return fmt.Sprintf("%v", k.Val)
		}
	}
	return ""
}

func jsonVal(raw json.RawMessage) any {
	var v any
	json.Unmarshal(raw, &v)
	return v
}
