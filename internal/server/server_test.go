package server

import (
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"huashanquery/internal/huashan"
	"huashanquery/internal/player"
	"huashanquery/internal/token"
)

// fakeTP 实现 huashan.TokenProvider；带鉴权的官方接口要求 "Bearer GOOD"。
type fakeTP struct{ tok, nick string }

func (f fakeTP) reason() token.Reason {
	if f.tok != "" {
		return token.ReasonOK
	}
	return token.ReasonNoToken
}
func (f fakeTP) Current() (string, string, token.Reason) { return f.tok, f.nick, f.reason() }
func (f fakeTP) Refresh() (string, string, token.Reason) { return f.tok, f.nick, f.reason() }

const stubStats = `{"player":{"name":"张三","avatar":""},"joined_zone_ids":[{"ordering":"SD","text":"山东赛区"}],` +
	`"honors":[],"summary":{"round_total":1},"haoren":{},"langren":{},"power":9}`
const stubGames = `{"total_items":1,"items":[{"game_id":11,"play_date":"2024-01-01","season_id":6,"seat":3,"sect_name":"门派A","rpt_name":"平民","total_point":5,"win":1}]}`

// fakeOfficial 模拟官方接口：搜索免鉴权；统计/逐场需正确令牌，否则 401。
func fakeOfficial() *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization") == "Bearer GOOD"
		switch {
		case strings.HasPrefix(r.URL.Path, "/stats/club-players"):
			w.Write([]byte(`{"items":[{"player_id":42,"player_name":"张三"}]}`))
		case strings.Contains(r.URL.Path, "/stats/players/games/"):
			if !auth {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			if r.URL.Query().Get("page") == "1" {
				w.Write([]byte(stubGames))
			} else {
				w.Write([]byte(`{"total_items":1,"items":[]}`))
			}
		case strings.Contains(r.URL.Path, "/stats/games/players/"):
			if !auth {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			w.Write([]byte(stubStats))
		default:
			w.WriteHeader(http.StatusNotFound)
			w.Write([]byte(`{"error":{"message":"nope"}}`))
		}
	}))
}

func svcTo(base string, tp huashan.TokenProvider) *player.Service {
	c := huashan.New(tp)
	c.Base = base
	return player.New(c, 50)
}

func get(t *testing.T, url string) (int, string) {
	t.Helper()
	r, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(r.Body)
	r.Body.Close()
	return r.StatusCode, string(b)
}

// jwt 造一个可解出 exp 的令牌串（非 eyJ 开头，便于断言“响应里不含令牌”）。
func jwt(exp string) string {
	return "h." + base64.RawURLEncoding.EncodeToString([]byte(`{"exp":`+exp+`}`)) + ".s"
}

func TestSessionEndpointNoToken(t *testing.T) {
	tok := jwt("1893456000")
	url, _, closeFn, err := Run(svcTo("http://unused", fakeTP{tok: tok, nick: "阿三"}))
	if err != nil {
		t.Fatal(err)
	}
	defer closeFn()
	st, body := get(t, url+"api/session")
	if st != 200 || !strings.Contains(body, "阿三") || !strings.Contains(body, "1893456000") {
		t.Fatalf("/api/session = %d %s", st, body)
	}
	if strings.Contains(body, tok) { // 令牌本身绝不下发页面
		t.Fatalf("/api/session leaked the token: %s", body)
	}
}

func TestProxySearch(t *testing.T) {
	off := fakeOfficial()
	defer off.Close()
	url, _, closeFn, err := Run(svcTo(off.URL, fakeTP{tok: "GOOD", nick: "n"}))
	if err != nil {
		t.Fatal(err)
	}
	defer closeFn()
	st, body := get(t, url+"api/players/search?name=%E5%BC%A0%E4%B8%89")
	if st != 200 || !strings.Contains(body, "张三") {
		t.Fatalf("search proxy = %d %s", st, body)
	}
}

func TestDetailEndpoint(t *testing.T) {
	off := fakeOfficial()
	defer off.Close()

	// 令牌正确 → 详情视图（含计算好的选手信息与逐场）
	okURL, _, closeOK, err := Run(svcTo(off.URL, fakeTP{tok: "GOOD", nick: "n"}))
	if err != nil {
		t.Fatal(err)
	}
	defer closeOK()
	st, body := get(t, okURL+"api/players/detail?id=1&zone=ALL")
	if st != 200 || !strings.Contains(body, "张三") || !strings.Contains(body, "门派A") {
		t.Fatalf("detail(GOOD) = %d %s", st, body)
	}

	// 令牌错误 → 统计与逐场都 401 → 详情端点回 401 + error 信封
	badURL, _, closeBad, err := Run(svcTo(off.URL, fakeTP{tok: "BAD", nick: "n"}))
	if err != nil {
		t.Fatal(err)
	}
	defer closeBad()
	st, body = get(t, badURL+"api/players/detail?id=1&zone=ALL")
	if st != 401 || !strings.Contains(body, `"error"`) {
		t.Fatalf("detail(BAD) = %d %s, want 401 with error envelope", st, body)
	}
}

func TestRunServeStatic(t *testing.T) {
	url, _, closeFn, err := Run(svcTo("http://unused", fakeTP{}))
	if err != nil {
		t.Fatal(err)
	}
	defer closeFn()

	st, body := get(t, url)
	if st != 200 || !strings.Contains(body, "华山论剑") || !strings.Contains(body, `src="js/main.js"`) {
		t.Fatal("served index.html missing expected markers")
	}
	if strings.Contains(body, "eyJ") { // 页面不应内嵌任何令牌
		t.Fatal("index.html should not embed a token")
	}

	rjs, err := http.Get(url + "js/format.js")
	if err != nil {
		t.Fatal(err)
	}
	jsBody, _ := io.ReadAll(rjs.Body)
	ct := rjs.Header.Get("Content-Type")
	rjs.Body.Close()
	if rjs.StatusCode != 200 || !strings.Contains(string(jsBody), "export") {
		t.Fatalf("js asset not served: status=%d", rjs.StatusCode)
	}
	if !strings.HasPrefix(ct, "text/javascript") {
		t.Fatalf("js served with wrong Content-Type %q (module scripts require a JS MIME)", ct)
	}
}

func TestRunDistinctPorts(t *testing.T) {
	u1, _, c1, err := Run(svcTo("http://unused", fakeTP{}))
	if err != nil {
		t.Fatal(err)
	}
	defer c1()
	u2, _, c2, err := Run(svcTo("http://unused", fakeTP{}))
	if err != nil {
		t.Fatal(err)
	}
	defer c2()
	if u1 == u2 {
		t.Fatalf("expected distinct ephemeral ports, both %s", u1)
	}
}

func TestCloseFreesServer(t *testing.T) {
	url, _, closeFn, err := Run(svcTo("http://unused", fakeTP{}))
	if err != nil {
		t.Fatal(err)
	}
	if err := closeFn(); err != nil {
		t.Fatalf("close: %v", err)
	}
	if _, err := http.Get(url); err == nil {
		t.Fatal("expected error after close (server should be down)")
	}
}

func TestHeartbeatAndQuit(t *testing.T) {
	url, done, closeFn, err := Run(svcTo("http://unused", fakeTP{}))
	if err != nil {
		t.Fatal(err)
	}
	defer closeFn()

	// 心跳端点应回 204，且不触发退出
	if st, _ := get(t, url+"api/heartbeat"); st != http.StatusNoContent {
		t.Fatalf("/api/heartbeat = %d, want 204", st)
	}
	select {
	case <-done:
		t.Fatal("done closed after a heartbeat; watchdog should keep it open")
	default:
	}

	// /api/quit 应关闭 done（页面点“退出程序”→ 立即结束）
	if st, _ := get(t, url+"api/quit"); st != http.StatusNoContent {
		t.Fatalf("/api/quit = %d, want 204", st)
	}
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("done not closed after /api/quit")
	}
}

func TestTestModeQueryLimit(t *testing.T) {
	off := fakeOfficial()
	defer off.Close()
	url, done, closeFn, err := Run(svcTo(off.URL, fakeTP{tok: "GOOD"}), Options{
		TestMode: true, TestQueries: 2, TestDuration: time.Minute,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer closeFn()

	if st, body := get(t, url+"api/session"); st != http.StatusOK || !strings.Contains(body, `"test_mode":true`) {
		t.Fatalf("test session = %d %s", st, body)
	}
	for _, view := range []string{"a", "a", "b"} {
		if st, body := get(t, url+"api/players/detail?id=1&zone=ALL&view="+view); st != http.StatusOK {
			t.Fatalf("view %q = %d %s", view, st, body)
		}
	}
	if st, body := get(t, url+"api/players/detail?id=1&zone=ALL&view=c"); st != http.StatusGone || !strings.Contains(body, "test_expired") {
		t.Fatalf("query over limit = %d %s", st, body)
	}
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("test query limit did not stop the server")
	}
}

func TestTestModeDurationLimit(t *testing.T) {
	url, done, closeFn, err := Run(svcTo("http://unused", fakeTP{}), Options{
		TestMode: true, TestQueries: 20, TestDuration: 20 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer closeFn()
	time.Sleep(30 * time.Millisecond)
	if st, body := get(t, url+"api/heartbeat"); st != http.StatusGone || !strings.Contains(body, "test_expired") {
		t.Fatalf("expired heartbeat = %d %s", st, body)
	}
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("test duration limit did not stop the server")
	}
}

// 收到过心跳后，超过 beatTimeout 无心跳 → done 关闭（页面关标签/断连即自动退出）。用小时长快速验证。
func TestHeartbeatTimeoutClosesDone(t *testing.T) {
	defer swapDurations(30*time.Millisecond, 5*time.Second, 5*time.Millisecond)()
	url, done, closeFn, err := Run(svcTo("http://unused", fakeTP{}))
	if err != nil {
		t.Fatal(err)
	}
	defer closeFn()
	if st, _ := get(t, url+"api/heartbeat"); st != http.StatusNoContent { // 先敲一次 → firstSeen=true
		t.Fatalf("/api/heartbeat = %d, want 204", st)
	}
	select { // 之后不再敲，应在 beatTimeout 后关闭
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("done not closed after heartbeat timeout")
	}
}

// 首个心跳前只走 bootGrace 宽限；宽限内不应退出。用小时长快速验证。
func TestBootGraceKeepsAliveBeforeFirstBeat(t *testing.T) {
	defer swapDurations(5*time.Millisecond, 500*time.Millisecond, 5*time.Millisecond)()
	_, done, closeFn, err := Run(svcTo("http://unused", fakeTP{}))
	if err != nil {
		t.Fatal(err)
	}
	defer closeFn()
	select {
	case <-done:
		t.Fatal("done closed within boot grace before any heartbeat")
	case <-time.After(150 * time.Millisecond):
	}
}

// 页面始终没加载成功、一次心跳也没有时，启动宽限结束后同样退出。
func TestBootGraceTimeoutClosesDone(t *testing.T) {
	defer swapDurations(5*time.Second, 30*time.Millisecond, 5*time.Millisecond)()
	_, done, closeFn, err := Run(svcTo("http://unused", fakeTP{}))
	if err != nil {
		t.Fatal(err)
	}
	defer closeFn()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("done not closed after boot grace without a heartbeat")
	}
}

// 即使看门狗很久才得到一次调度（例如系统刚从休眠恢复），也不能重置超时窗口。
func TestLongWatchGapStillClosesDone(t *testing.T) {
	defer swapDurations(5*time.Millisecond, 5*time.Second, 20*time.Millisecond)()
	url, done, closeFn, err := Run(svcTo("http://unused", fakeTP{}))
	if err != nil {
		t.Fatal(err)
	}
	defer closeFn()
	if st, _ := get(t, url+"api/heartbeat"); st != http.StatusNoContent {
		t.Fatalf("/api/heartbeat = %d, want 204", st)
	}
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("done not closed after a delayed watchdog check")
	}
}

// swapDurations 临时改小看门狗时长，返回还原函数（测试用）。Run 在启动协程前把这些值快照到局部，
// 因此写全局只发生在测试主协程、且不与看门狗协程并发——-race 干净。
func swapDurations(beat, boot, tick time.Duration) func() {
	ob, og, ot := beatTimeout, bootGrace, watchTick
	beatTimeout, bootGrace, watchTick = beat, boot, tick
	return func() { beatTimeout, bootGrace, watchTick = ob, og, ot }
}
