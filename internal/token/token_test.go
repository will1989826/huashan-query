package token

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func mk(payload map[string]any) string {
	b, _ := json.Marshal(payload)
	return "eyJ0." + base64.RawURLEncoding.EncodeToString(b) + ".s"
}

// mkFuture 造一枚 exp 在未来的令牌，使 Current 缓存能命中。
func mkFuture() string {
	return mk(map[string]any{"exp": time.Now().Add(time.Hour).Unix()})
}

// Reason：无候选→no_token；有候选但校验都失败→expired；有效→ok。
func TestScanReason(t *testing.T) {
	if _, _, r := (&Manager{Sources: []Source{fakeSrc{nil}}}).Current(); r != ReasonNoToken {
		t.Fatalf("no candidates → reason %q, want no_token", r)
	}
	allFail := &Manager{
		Sources:  []Source{fakeSrc{[]string{mk(map[string]any{"exp": 1})}}},
		Validate: func(string) (string, bool) { return "", false },
	}
	if _, _, r := allFail.Current(); r != ReasonExpired {
		t.Fatalf("candidates all-fail → reason %q, want expired", r)
	}
	okMgr := &Manager{
		Sources:  []Source{fakeSrc{[]string{mkFuture()}}},
		Validate: func(string) (string, bool) { return "Ann", true },
	}
	if tk, _, r := okMgr.Current(); tk == "" || r != ReasonOK {
		t.Fatalf("valid → tok %q reason %q, want non-empty + ok", tk, r)
	}
}

// validate 分类：200 合法→ok；200 非法/429/5xx→server；401/403→expired；连不上→network。
func TestValidateOutcomes(t *testing.T) {
	cases := []struct {
		status int
		body   string
		want   valOutcome
	}{
		{200, `{"player_id":42,"nickname":"Ann"}`, valOK},
		{200, `<html>maintenance</html>`, valServer}, // 200 但结构非法（维护页）
		{401, ``, valExpired},
		{403, ``, valExpired},
		{429, ``, valServer},
		{500, ``, valServer},
		{503, ``, valServer},
	}
	old := apiCheck
	defer func() { apiCheck = old }()
	for _, c := range cases {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(c.status)
			w.Write([]byte(c.body))
		}))
		apiCheck = srv.URL
		_, out := validate("x")
		srv.Close()
		if out != c.want {
			t.Fatalf("status %d body %q → outcome %v, want %v", c.status, c.body, out, c.want)
		}
	}
	// 连不上：指向一个刚关闭的地址 → network
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	apiCheck = srv.URL
	srv.Close()
	if _, out := validate("x"); out != valNetwork {
		t.Fatalf("closed server → outcome %v, want network", out)
	}
}

// scan 归因：默认校验器下，服务器 5xx → ReasonServer（不误报成过期）。
func TestScanReasonServer(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(503)
	}))
	defer srv.Close()
	old := apiCheck
	apiCheck = srv.URL
	defer func() { apiCheck = old }()
	m := &Manager{Sources: []Source{fakeSrc{[]string{mk(map[string]any{"exp": 9999999999})}}}} // Validate=nil → 走默认校验
	if _, _, r := m.Current(); r != ReasonServer {
		t.Fatalf("503 → reason %q, want server", r)
	}
}

func TestPayloadExp(t *testing.T) {
	if payloadExp(mk(map[string]any{"exp": 12345})) != 12345 {
		t.Fatal("exp parse")
	}
	if payloadExp("garbage") != 0 {
		t.Fatal("garbage should be 0")
	}
}

type fakeSrc struct{ toks []string }

func (f fakeSrc) Candidates() []string { return f.toks }

func TestCandidatesDedupeSort(t *testing.T) {
	a := mk(map[string]any{"exp": 200})
	b := mk(map[string]any{"exp": 100})
	m := &Manager{Sources: []Source{fakeSrc{[]string{b, a, a, ""}}}}
	got := m.candidates()
	if len(got) != 2 || got[0] != a || got[1] != b {
		t.Fatalf("candidates dedupe/sort got %v", got)
	}
}

func TestCurrentInjectedValidate(t *testing.T) {
	a := mk(map[string]any{"exp": 200})
	b := mk(map[string]any{"exp": 100})
	var tried []string
	m := &Manager{
		Sources: []Source{fakeSrc{[]string{b, a}}},
		Validate: func(tok string) (string, bool) {
			tried = append(tried, tok)
			if tok == b {
				return "Bob", true
			}
			return "", false
		},
	}
	tk, nick, _ := m.Current()
	if tk != b || nick != "Bob" {
		t.Fatalf("Current got %q %q", tk, nick)
	}
	if len(tried) < 2 || tried[0] != a { // exp 高的 a 先被校验
		t.Fatalf("validate order %v", tried)
	}
}

func TestCurrentNone(t *testing.T) {
	m := &Manager{
		Sources:  []Source{fakeSrc{[]string{mk(map[string]any{"exp": 1})}}},
		Validate: func(string) (string, bool) { return "", false },
	}
	if tk, _, _ := m.Current(); tk != "" {
		t.Fatal("no valid token should give empty")
	}
}

// 缓存：exp 在未来的有效令牌，多次 Current 只校验一次（不重复扫盘/联网）。
func TestCurrentCaches(t *testing.T) {
	tok := mkFuture()
	var n int32
	m := &Manager{
		Sources:  []Source{fakeSrc{[]string{tok}}},
		Validate: func(string) (string, bool) { atomic.AddInt32(&n, 1); return "Ann", true },
	}
	for i := 0; i < 5; i++ {
		if tk, nick, _ := m.Current(); tk != tok || nick != "Ann" {
			t.Fatalf("call %d got %q %q", i, tk, nick)
		}
	}
	if got := atomic.LoadInt32(&n); got != 1 {
		t.Fatalf("expected validate called once (cached), got %d", got)
	}
}

// 并发合并：多个 goroutine 同时 Current，只触发一次扫描（singleflight）。
func TestCurrentCoalesces(t *testing.T) {
	tok := mkFuture()
	var n int32
	m := &Manager{
		Sources: []Source{fakeSrc{[]string{tok}}},
		Validate: func(string) (string, bool) {
			atomic.AddInt32(&n, 1)
			time.Sleep(30 * time.Millisecond) // 拉长窗口让并发调用搭车
			return "Ann", true
		},
	}
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); m.Current() }()
	}
	wg.Wait()
	if got := atomic.LoadInt32(&n); got != 1 {
		t.Fatalf("concurrent Current should coalesce to 1 scan, got %d", got)
	}
}

// Refresh 不被普通 Current 的扫描抑制：Current 后立刻 Refresh 应真正重扫（处理刚收到的 401）。
func TestRefreshNotSuppressedByCurrent(t *testing.T) {
	tok := mkFuture()
	var n int32
	m := &Manager{
		Sources:  []Source{fakeSrc{[]string{tok}}},
		Validate: func(string) (string, bool) { atomic.AddInt32(&n, 1); return "Ann", true },
	}
	m.Current() // n=1，记录的是普通扫描，不应抑制随后的强刷
	m.Refresh() // 应重新扫描 → n=2
	if got := atomic.LoadInt32(&n); got != 2 {
		t.Fatalf("Refresh right after Current should rescan, got %d scans", got)
	}
}

// 强刷之间在 forceWindow 内互相抑制（合并 401 风暴）。
func TestRefreshCoalescesStorm(t *testing.T) {
	tok := mkFuture()
	var n int32
	m := &Manager{
		Sources:  []Source{fakeSrc{[]string{tok}}},
		Validate: func(string) (string, bool) { atomic.AddInt32(&n, 1); return "Ann", true },
	}
	m.Refresh() // 首个强刷：扫描（n=1，记录 lastForceScan）
	for i := 0; i < 5; i++ {
		m.Refresh() // forceWindow 内的后续强刷：复用，不再扫描
	}
	if got := atomic.LoadInt32(&n); got != 1 {
		t.Fatalf("consecutive Refresh within forceWindow should coalesce, got %d scans", got)
	}
}
