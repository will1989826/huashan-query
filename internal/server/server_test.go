package server

import (
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"huashanquery/internal/event"
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
		case r.URL.Path == "/system/dicts/suites/season":
			w.Write([]byte(`[{"value":"29","text":"S29"}]`))
		case r.URL.Path == "/system/dicts/suites/season.type":
			w.Write([]byte(`[{"value":"4","text":"季后赛"}]`))
		case r.URL.Path == "/settings/editions":
			w.Write([]byte(`[{"value":18,"label":"侦探怪盗守卫"}]`))
		case r.URL.Path == "/settings/rpts":
			w.Write([]byte(`[{"value":2,"label":"狼","camp":2}]`))
		case r.URL.Path == "/stats/sect-stats":
			w.Write([]byte(`{"total_items":1,"items":[{"sect_id":13,"sect_name":"鱼乐会","total_point":20}]}`))
		case r.URL.Path == "/stats/players/games":
			w.Write([]byte(`[{"player_id":109,"player_name":"Will","total_round":3,"total_point":20,"average_point":6.67,"mvp_qty":2,"svp_qty":1,"bgx_qty":0,"sects":[{"id":13}]}]`))
		case r.URL.Path == "/werewolves/sects/13":
			w.Write([]byte(`{"id":13,"name":"鱼乐会"}`))
		case r.URL.Path == "/settings/players":
			w.Write([]byte(`[{"value":109,"label":"Will"}]`))
		case r.URL.Path == "/stats/players/games/109/details":
			w.Write([]byte(`{"total_items":1,"items":[{"season_id":29,"season_type_id":4,"sect_name":"鱼乐会"}]}`))
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

func svcTo(base string, tp huashan.TokenProvider) (*player.Service, *event.Service) {
	c := huashan.New(tp)
	c.Base = base
	svc := player.New(c, 50)
	return svc, event.New(c, svc)
}

// runSvc 起测试服务：装配选手服务与赛事服务（复用同一客户端），交给 Run。
func runSvc(base string, tp huashan.TokenProvider) (string, <-chan struct{}, func() error, error) {
	svc, evt := svcTo(base, tp)
	return Run(svc, evt)
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

func TestDrawToolEndpointIsWired(t *testing.T) {
	official := fakeOfficial()
	defer official.Close()
	url, _, closeFn, err := runSvc(official.URL, fakeTP{tok: "GOOD"})
	if err != nil {
		t.Fatal(err)
	}
	defer closeFn()
	status, body := get(t, url+"api/events/draw-tool?season=29&type=3&zone=SH")
	if status != http.StatusBadRequest || !strings.Contains(body, "抽局模拟仅支持季后赛和总决赛") {
		t.Fatalf("draw endpoint=%d %s", status, body)
	}
}

func TestGroupDrawEndpointIsWired(t *testing.T) {
	official := fakeOfficial()
	defer official.Close()
	url, _, closeFn, err := runSvc(official.URL, fakeTP{tok: "GOOD"})
	if err != nil {
		t.Fatal(err)
	}
	defer closeFn()
	status, body := get(t, url+"api/events/group-draw?season=29&type=4&zone=SH")
	if status != http.StatusBadRequest || !strings.Contains(body, "分组模拟仅支持踢馆赛和常规赛") {
		t.Fatalf("group draw endpoint=%d %s", status, body)
	}
}

func TestDrawPrewarmStartsFromToolboxSignal(t *testing.T) {
	official := fakeOfficial()
	defer official.Close()
	url, _, closeFn, err := runSvc(official.URL, fakeTP{tok: "GOOD"})
	if err != nil {
		t.Fatal(err)
	}
	defer closeFn()

	req, _ := http.NewRequest(http.MethodPost, url+"api/events/draw-prewarm", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("POST draw prewarm = %d, want 204", resp.StatusCode)
	}
	if status, _ := get(t, url+"api/events/draw-prewarm"); status != http.StatusMethodNotAllowed {
		t.Fatalf("GET draw prewarm = %d, want 405", status)
	}
}

// jwt 造一个可解出 exp 的令牌串（非 eyJ 开头，便于断言“响应里不含令牌”）。
func jwt(exp string) string {
	return "h." + base64.RawURLEncoding.EncodeToString([]byte(`{"exp":`+exp+`}`)) + ".s"
}

func TestSessionEndpointNoToken(t *testing.T) {
	tok := jwt("1893456000")
	url, _, closeFn, err := runSvc("http://unused", fakeTP{tok: tok, nick: "阿三"})
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

func TestManualTokenAndCopyEndpoints(t *testing.T) {
	tok := jwt("1893456000")
	mgr := &token.Manager{Validate: func(got string) (string, bool) {
		if got == tok {
			return "共享账号", true
		}
		return "", false
	}}
	url, _, closeFn, err := runSvc("http://unused", mgr)
	if err != nil {
		t.Fatal(err)
	}
	defer closeFn()

	req, _ := http.NewRequest(http.MethodPut, url+"api/token", strings.NewReader(`{"token":"`+tok+`"}`))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || !strings.Contains(string(body), "共享账号") || strings.Contains(string(body), tok) {
		t.Fatalf("PUT /api/token = %d %s", resp.StatusCode, body)
	}

	copyResp, err := http.Get(url + "api/token")
	if err != nil {
		t.Fatal(err)
	}
	copyBody, _ := io.ReadAll(copyResp.Body)
	copyResp.Body.Close()
	if copyResp.StatusCode != http.StatusOK || !strings.Contains(string(copyBody), tok) || copyResp.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("GET /api/token = %d %s (Cache-Control=%q)", copyResp.StatusCode, copyBody, copyResp.Header.Get("Cache-Control"))
	}

	bad, _ := http.NewRequest(http.MethodPut, url+"api/token", strings.NewReader(`{"token":"wrong"}`))
	bad.Header.Set("Content-Type", "application/json")
	badResp, err := http.DefaultClient.Do(bad)
	if err != nil {
		t.Fatal(err)
	}
	badResp.Body.Close()
	if badResp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("invalid PUT /api/token = %d, want 401", badResp.StatusCode)
	}
	if st, bodyText := get(t, url+"api/token"); st != http.StatusOK || !strings.Contains(bodyText, tok) {
		t.Fatal("invalid manual token replaced the valid session")
	}
}

func TestTokenEndpointRejectsCrossSiteAndSimpleForm(t *testing.T) {
	url, _, closeFn, err := runSvc("http://unused", fakeTP{tok: "GOOD"})
	if err != nil {
		t.Fatal(err)
	}
	defer closeFn()

	cross, _ := http.NewRequest(http.MethodGet, url+"api/token", nil)
	cross.Header.Set("Origin", "https://evil.example")
	resp, err := http.DefaultClient.Do(cross)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("cross-site GET /api/token = %d, want 403", resp.StatusCode)
	}

	form, _ := http.NewRequest(http.MethodPut, url+"api/token", strings.NewReader("token=GOOD"))
	form.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err = http.DefaultClient.Do(form)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnsupportedMediaType {
		t.Fatalf("form PUT /api/token = %d, want 415", resp.StatusCode)
	}
}

func TestProxySearch(t *testing.T) {
	off := fakeOfficial()
	defer off.Close()
	url, _, closeFn, err := runSvc(off.URL, fakeTP{tok: "GOOD", nick: "n"})
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
	okURL, _, closeOK, err := runSvc(off.URL, fakeTP{tok: "GOOD", nick: "n"})
	if err != nil {
		t.Fatal(err)
	}
	defer closeOK()
	st, body := get(t, okURL+"api/players/detail?id=1&zone=ALL")
	if st != 200 || !strings.Contains(body, "张三") || !strings.Contains(body, "门派A") {
		t.Fatalf("detail(GOOD) = %d %s", st, body)
	}

	// 令牌错误 → 统计与逐场都 401 → 详情端点回 401 + error 信封
	badURL, _, closeBad, err := runSvc(off.URL, fakeTP{tok: "BAD", nick: "n"})
	if err != nil {
		t.Fatal(err)
	}
	defer closeBad()
	st, body = get(t, badURL+"api/players/detail?id=1&zone=ALL")
	if st != 401 || !strings.Contains(body, `"error"`) {
		t.Fatalf("detail(BAD) = %d %s, want 401 with error envelope", st, body)
	}
}

func TestEventEndpoints(t *testing.T) {
	off := fakeOfficial()
	defer off.Close()
	url, _, closeFn, err := runSvc(off.URL, fakeTP{tok: "GOOD"})
	if err != nil {
		t.Fatal(err)
	}
	defer closeFn()

	if st, body := get(t, url+"api/events/catalog"); st != http.StatusOK || !strings.Contains(body, "季后赛") {
		t.Fatalf("catalog = %d %s", st, body)
	}
	if st, body := get(t, url+"api/events/seasons?zone=SD"); st != http.StatusOK || !strings.Contains(body, `"zone":"SD"`) || !strings.Contains(body, `"label":"S29"`) {
		t.Fatalf("seasons = %d %s", st, body)
	}
	if st, body := get(t, url+"api/events/availability?season=29&zone=SD"); st != http.StatusOK || !strings.Contains(body, `"season_types"`) || !strings.Contains(body, `"zones"`) {
		t.Fatalf("availability = %d %s", st, body)
	}
	if st, body := get(t, url+"api/events/rankings?season=29&type=4&zone=SD"); st != http.StatusOK || !strings.Contains(body, "鱼乐会") || !strings.Contains(body, `"rank":1`) || strings.Contains(body, `"days":1`) {
		t.Fatalf("rankings = %d %s", st, body)
	}
	if st, body := get(t, url+"api/events/rank-metrics?season=29&type=4&zone=SD&page=1"); st != http.StatusOK || !strings.Contains(body, `"has_more":false`) || !strings.Contains(body, `"sect_id":13`) || !strings.Contains(body, `"rounds":3`) {
		t.Fatalf("rank metrics = %d %s", st, body)
	}
	if st, body := get(t, url+"api/events/metrics?season=29&type=4&zone=SD"); st != http.StatusOK || !strings.Contains(body, `"players_available":true`) || !strings.Contains(body, `"player_name":"Will"`) || !strings.Contains(body, `"total_point":20`) || !strings.Contains(body, `"mvp":2`) {
		t.Fatalf("event metrics = %d %s", st, body)
	}
	if st, body := get(t, url+"api/events/team?id=13&season=29&type=4&zone=SD"); st != http.StatusOK || !strings.Contains(body, "Will") || !strings.Contains(body, "鱼乐会") || !strings.Contains(body, `"matches":1`) {
		t.Fatalf("team = %d %s", st, body)
	}
	if st, _ := get(t, url+"api/events/rankings?season=&type=4"); st != http.StatusBadRequest {
		t.Fatalf("invalid rankings = %d", st)
	}
}

func TestRunServeStatic(t *testing.T) {
	url, _, closeFn, err := runSvc("http://unused", fakeTP{})
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
	u1, _, c1, err := runSvc("http://unused", fakeTP{})
	if err != nil {
		t.Fatal(err)
	}
	defer c1()
	u2, _, c2, err := runSvc("http://unused", fakeTP{})
	if err != nil {
		t.Fatal(err)
	}
	defer c2()
	if u1 == u2 {
		t.Fatalf("expected distinct ephemeral ports, both %s", u1)
	}
}

func TestCloseFreesServer(t *testing.T) {
	url, _, closeFn, err := runSvc("http://unused", fakeTP{})
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
	url, done, closeFn, err := runSvc("http://unused", fakeTP{})
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

func TestSessionReportsManualTokenOnlyPlatform(t *testing.T) {
	psvc, pevt := svcTo("http://unused", fakeTP{})
	u, _, closeFn, err := Run(psvc, pevt, Options{ManualTokenOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	defer closeFn()
	if st, body := get(t, u+"api/session"); st != http.StatusOK || !strings.Contains(body, `"manual_token_only":true`) {
		t.Fatalf("session = %d %s", st, body)
	}
}

// 收到过心跳后，超过 beatTimeout 无心跳 → done 关闭（页面关标签/断连即自动退出）。用小时长快速验证。
func TestHeartbeatTimeoutClosesDone(t *testing.T) {
	defer swapDurations(30*time.Millisecond, 5*time.Second, 5*time.Millisecond)()
	url, done, closeFn, err := runSvc("http://unused", fakeTP{})
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
	_, done, closeFn, err := runSvc("http://unused", fakeTP{})
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
	_, done, closeFn, err := runSvc("http://unused", fakeTP{})
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
	url, done, closeFn, err := runSvc("http://unused", fakeTP{})
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

func TestUpdateLatest(t *testing.T) {
	// 未配置（Options 零值）：/api/latest 回 {configured:false}
	u0, _, c0, err := runSvc("http://unused", fakeTP{})
	if err != nil {
		t.Fatal(err)
	}
	st, body := get(t, u0+"api/latest")
	c0()
	if st != 200 || !strings.Contains(body, `"configured":false`) {
		t.Fatalf("empty manifest = %d %s", st, body)
	}

	// 配置 UpdateURL 指向一个清单服务：透传两个平台链接，并为当前平台选择 url。
	mf := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"version":"9.9.9","url":"https://example.com/legacy.exe","downloads":{"windows_amd64":"https://example.com/win.exe","mac_arm64":"https://example.com/mac-arm"},"notes":"hi"}`))
	}))
	defer mf.Close()

	psvc, pevt := svcTo("http://unused", fakeTP{})
	u1, _, c1, err := Run(psvc, pevt, Options{UpdateURL: mf.URL})
	if err != nil {
		t.Fatal(err)
	}
	defer c1()
	st, body = get(t, u1+"api/latest")
	if st != 200 || !strings.Contains(body, `"configured":true`) || !strings.Contains(body, "9.9.9") ||
		!strings.Contains(body, `"url":"https://example.com/win.exe"`) || !strings.Contains(body, `"mac_arm64":"https://example.com/mac-arm"`) {
		t.Fatalf("configured manifest = %d %s", st, body)
	}
}

func TestSelectUpdateURL(t *testing.T) {
	downloads := map[string]string{
		"windows_amd64": "win", "mac_arm64": "apple",
	}
	for _, tc := range []struct{ goos, arch, want string }{
		{"windows", "amd64", "win"}, {"darwin", "arm64", "apple"}, {"darwin", "amd64", ""}, {"linux", "amd64", ""},
	} {
		if got := selectUpdateURL(downloads, "legacy", tc.goos, tc.arch); got != tc.want {
			t.Errorf("selectUpdateURL(%s/%s)=%q want %q", tc.goos, tc.arch, got, tc.want)
		}
	}
}
