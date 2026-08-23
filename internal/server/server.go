// Package server 提供本地内存服务：把内嵌的 web/ 静态资源发给浏览器，并暴露一层本地 JSON API。
// 浏览器只负责渲染；筛选/聚合/分页等全部计算在 player 层完成，令牌与官方接口调用在下层完成，
// 令牌本身永不下发页面（/api/session 只回昵称与到期时间）。
package server

import (
	"context"
	"embed"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"mime"
	"net"
	"net/http"
	"sync"
	"time"

	"huashanquery/internal/logx"
	"huashanquery/internal/player"
)

//go:embed all:web
var webFS embed.FS

// 心跳看门狗参数。页面每 3 秒发一次心跳，但浏览器会节流甚至冻结后台标签页的定时器，
// 所以窗口放宽到几分钟；无论标签关闭、后台冻结还是系统休眠，超过窗口没收到心跳就退出。
// 用 var 而非 const，便于测试把时长调小；生产不改。
var (
	beatTimeout = 3 * time.Minute  // 连上后多久收不到心跳判定退出（容忍后台标签节流/短暂休眠）
	bootGrace   = 60 * time.Second // 首个心跳前的启动宽限（冷启动/杀软扫描可能较慢）
	watchTick   = 5 * time.Second  // 看门狗检查间隔
)

const (
	defaultTestQueries  = 20
	defaultTestDuration = 20 * time.Minute
)

// updateManifestURL 指向一份公开的更新清单 JSON：{"version":"0.3.0","url":"下载页/直链","notes":"本次更新说明"}。
// 页面「检查更新」经 /api/latest 由服务端代拉（绕过浏览器跨域），与当前版本比对。
// 留空则功能显示“暂未开放”。建议把清单放在国内可达的静态托管（如 Gitee raw）；下载链接(url)可另指向任意托管。
var updateManifestURL = "https://gitee.com/amazingly-sweet/huashan-query/raw/main/latest.json"

// Options 控制服务运行模式。正式版使用零值；测试版限制可查询次数和运行时间。
type Options struct {
	TestMode     bool
	TestQueries  int
	TestDuration time.Duration
	Version      string // 构建版本号，下发给页面展示（⚙ 菜单/关于）；空则页面不显示
}

func init() {
	// Windows 上 .js/.css 的 MIME 可能取自注册表且不正确（曾出现 text/plain），
	// 会导致 <script type="module"> 拒绝加载。显式覆盖，确保类型正确。
	mime.AddExtensionType(".js", "text/javascript; charset=utf-8")
	mime.AddExtensionType(".css", "text/css; charset=utf-8")
	mime.AddExtensionType(".html", "text/html; charset=utf-8")
}

// Run 在 127.0.0.1 随机端口(:0)起服务，返回其 URL、done 通道与关闭函数；页面与静态资源从内存(embed.FS)提供。
// done 在“页面心跳超时”或“页面点了退出(/api/quit)”时关闭——由 main 据此结束进程（不再依赖控制台窗口）。
func Run(svc *player.Service, options ...Options) (url string, done <-chan struct{}, closeFn func() error, err error) {
	var opt Options
	if len(options) > 0 {
		opt = options[0]
	}
	trial := newTestGate(opt)
	sub, err := fs.Sub(webFS, "web")
	if err != nil {
		logx.Errorf("sub web fs failed: %v", err)
		return "", nil, nil, err
	}
	files := http.FileServer(http.FS(sub))

	mux := http.NewServeMux()

	// 退出信号：心跳看门狗或 /api/quit 触发；只关一次。
	quit := make(chan struct{})
	var fireOnce sync.Once
	fire := func() { fireOnce.Do(func() { close(quit) }) }
	var expireOnce sync.Once
	expire := func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusGone)
		_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{
			"code": "test_expired", "message": "测试版本使用已结束，请重新打开程序。",
		}})
		expireOnce.Do(func() { time.AfterFunc(200*time.Millisecond, fire) })
	}
	allow := func(w http.ResponseWriter, r *http.Request, countQuery bool) bool {
		if trial == nil {
			return true
		}
		if trial.timeExpired() || (countQuery && !trial.consume(r.URL.Query().Get("view"))) {
			expire(w)
			return false
		}
		return true
	}

	// 心跳状态：最后一次心跳时刻 + 是否已收到过首个心跳。
	var beatMu sync.Mutex
	lastBeat := time.Now()
	firstSeen := false

	// /api/heartbeat：页面每 3 秒来敲一次；关标签页/断连后不再敲 → 看门狗超时退出。
	mux.HandleFunc("/api/heartbeat", func(w http.ResponseWriter, r *http.Request) {
		if !allow(w, r, false) {
			return
		}
		beatMu.Lock()
		lastBeat = time.Now()
		firstSeen = true
		beatMu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	})
	// /api/quit：页面点“退出程序”→ 立即结束（不必等待心跳超时）。
	mux.HandleFunc("/api/quit", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
		fire()
	})

	// /api/session：页面启动/刷新时取昵称、令牌到期时间、以及无令牌时的精确原因（?refresh=1 强制重扫）。不含令牌本身。
	mux.HandleFunc("/api/session", func(w http.ResponseWriter, r *http.Request) {
		defer logx.Recover("GET /api/session")
		if !allow(w, r, false) {
			return
		}
		nick, exp, reason := svc.Session(r.URL.Query().Get("refresh") == "1")
		writeJSON(w, map[string]any{"nick": nick, "exp": exp, "reason": reason, "test_mode": trial != nil, "version": opt.Version})
	})

	// 本地数据 API：浏览器传条件，player 层出整理好的可渲染 JSON。
	searchHandler := handle("GET /api/players/search", func(r *http.Request) (any, error) {
		return svc.Search(r.Context(), r.URL.Query().Get("name"))
	})
	mux.HandleFunc("/api/players/search", func(w http.ResponseWriter, r *http.Request) {
		if allow(w, r, false) {
			searchHandler(w, r)
		}
	})
	// 选手详情：作用域(赛区/赛季/门派)走查询参数；排序/快捷筛选/分页在页面本地做。数据按人数缓存，关掉重开即最新。
	detailHandler := handle("GET /api/players/detail", func(r *http.Request) (any, error) {
		q := r.URL.Query()
		only := q.Get("only")
		return svc.Detail(r.Context(), player.Query{
			ID: q.Get("id"), Zone: q.Get("zone"), Season: q.Get("season"), Sect: q.Get("sect"),
			Head: only == "head", FirstPage: only == "firstpage",
		})
	})
	mux.HandleFunc("/api/players/detail", func(w http.ResponseWriter, r *http.Request) {
		if allow(w, r, true) {
			detailHandler(w, r)
		}
	})
	// 单场牌局详情：原始 JSON 透传，前端做展示层排版。
	gameHandler := handle("GET /api/games", func(r *http.Request) (any, error) {
		return svc.Game(r.Context(), r.URL.Query().Get("id"))
	})
	mux.HandleFunc("/api/games", func(w http.ResponseWriter, r *http.Request) {
		if allow(w, r, false) {
			gameHandler(w, r)
		}
	})

	// /api/latest：服务端代拉更新清单（绕过浏览器跨域、不带任何令牌），返回 {configured,version,url,notes} 或错误。
	// 未配置 updateManifestURL 时回 {configured:false}，页面提示“暂未开放”。
	mux.HandleFunc("/api/latest", func(w http.ResponseWriter, r *http.Request) {
		defer logx.Recover("GET /api/latest")
		if !allow(w, r, false) {
			return
		}
		if updateManifestURL == "" {
			writeJSON(w, map[string]any{"configured": false})
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
		defer cancel()
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, updateManifestURL, nil)
		if err != nil {
			writeErr(w, err)
			return
		}
		req.Header.Set("User-Agent", "huashan-query")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			if r.Context().Err() != nil {
				return // 页面已取消
			}
			writeErr(w, fmt.Errorf("连接更新服务失败：%w", err))
			return
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			writeErr(w, fmt.Errorf("更新服务返回 %d", resp.StatusCode))
			return
		}
		var mf struct {
			Version string `json:"version"`
			URL     string `json:"url"`
			Notes   string `json:"notes"`
		}
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
		if json.Unmarshal(body, &mf) != nil || mf.Version == "" {
			writeErr(w, fmt.Errorf("更新清单格式异常"))
			return
		}
		writeJSON(w, map[string]any{"configured": true, "version": mf.Version, "url": mf.URL, "notes": mf.Notes})
	})

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		defer logx.Recover("GET " + r.URL.Path)
		w.Header().Set("Cache-Control", "no-store") // 每个版本都是新 exe，避免浏览器用旧缓存的 js/css
		files.ServeHTTP(w, r)
	})

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		logx.Errorf("listen on local port failed: %v", err)
		return "", nil, nil, err
	}
	srv := &http.Server{Handler: mux}
	go srv.Serve(ln)

	// 看门狗。快照配置到局部变量：协程只读局部快照，绝不读全局，避免与测试改写全局产生数据竞争。
	stop := make(chan struct{})
	bt, bg, wt := beatTimeout, bootGrace, watchTick
	go func() {
		start := time.Now()
		t := time.NewTicker(wt)
		defer t.Stop()
		for {
			select {
			case <-stop:
				return
			case now := <-t.C:
				beatMu.Lock()
				lb, fs := lastBeat, firstSeen
				beatMu.Unlock()
				if (!fs && now.Sub(start) > bg) || (fs && now.Sub(lb) > bt) {
					fire()
					return
				}
			}
		}
	}()

	var closeOnce sync.Once
	closeFn = func() error {
		closeOnce.Do(func() { close(stop) })
		return srv.Close()
	}
	return "http://" + ln.Addr().String() + "/", quit, closeFn, nil
}

type testGate struct {
	mu       sync.Mutex
	started  time.Time
	duration time.Duration
	limit    int
	used     int
	views    map[string]struct{}
}

func newTestGate(opt Options) *testGate {
	if !opt.TestMode {
		return nil
	}
	if opt.TestQueries <= 0 {
		opt.TestQueries = defaultTestQueries
	}
	if opt.TestDuration <= 0 {
		opt.TestDuration = defaultTestDuration
	}
	return &testGate{started: time.Now(), duration: opt.TestDuration, limit: opt.TestQueries, views: make(map[string]struct{})}
}

func (g *testGate) timeExpired() bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	return time.Since(g.started) >= g.duration
}

func (g *testGate) consume(view string) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	if time.Since(g.started) >= g.duration {
		return false
	}
	if view != "" {
		if _, ok := g.views[view]; ok {
			return true
		}
	}
	if g.used >= g.limit {
		return false
	}
	g.used++
	if view != "" {
		g.views[view] = struct{}{}
	}
	return true
}

// handle 把“取数据函数”包成 HTTP 处理器：[]byte 原样透传；其它值 JSON 编码；
// *huashan.APIError 按其状态回 {error:{message}}；上下文取消(页面切换/关闭)静默不写。
func handle(tag string, fn func(*http.Request) (any, error)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		defer logx.Recover(tag)
		v, err := fn(r)
		if err != nil {
			if r.Context().Err() != nil {
				return // 页面已取消请求：不必写响应
			}
			writeErr(w, err)
			return
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		if b, ok := v.([]byte); ok {
			w.Write(b)
			return
		}
		json.NewEncoder(w).Encode(v)
	}
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, err error) {
	status, msg := player.ErrorStatus(err)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"message": msg}})
}
