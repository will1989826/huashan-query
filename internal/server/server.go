// Package server 提供本地内存服务：把内嵌的 web/ 静态资源发给浏览器，并暴露一层本地 JSON API。
// 浏览器只负责渲染；筛选/聚合/分页等全部计算在 player 层完成，令牌与官方接口调用在下层完成，
// /api/session 不含令牌；只有用户明确点击复制时，受同源保护的 /api/token 才返回当前令牌。
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
	"runtime"
	"strconv"
	"sync"
	"time"

	"huashanquery/internal/event"
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

// Options 提供构建版本、更新地址和平台能力。
type Options struct {
	Version         string // 构建版本号，下发给页面展示（⚙ 菜单/关于）；空则页面不显示
	UpdateURL       string // “检查更新”清单地址（构建时注入，不写死在代码里）；空则 /api/latest 回 {configured:false}
	ManualTokenOnly bool   // 当前平台不支持自动读取令牌，页面直接显示手动登录引导
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
// svc 提供选手详情/单局数据；evt 提供赛事排名/门派成员（两者复用同一官方客户端与选手逐场缓存）。
func Run(svc *player.Service, evt *event.Service, options ...Options) (url string, done <-chan struct{}, closeFn func() error, err error) {
	var opt Options
	if len(options) > 0 {
		opt = options[0]
	}
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

	// 进入工具箱或切换赛区后，在后台预热最新抽局数据；同一赛区只启动一次，失败后允许后续请求重试。
	prewarmCtx, cancelPrewarm := context.WithCancel(context.Background())
	var prewarmMu sync.Mutex
	var prewarmWG sync.WaitGroup
	prewarmZones := make(map[string]bool)
	startDrawPrewarm := func(zone string) {
		if zone == "" {
			zone = event.DefaultZoneCode()
		}
		prewarmMu.Lock()
		if prewarmZones[zone] {
			prewarmMu.Unlock()
			return
		}
		prewarmZones[zone] = true
		prewarmWG.Add(1)
		prewarmMu.Unlock()
		go func(zone string) {
			defer prewarmWG.Done()
			ctx, cancel := context.WithTimeout(prewarmCtx, 3*time.Minute)
			defer cancel()
			season, seasonType, warmErr := evt.PrewarmLatestDraw(ctx, zone)
			if warmErr != nil {
				prewarmMu.Lock()
				delete(prewarmZones, zone)
				prewarmMu.Unlock()
				if prewarmCtx.Err() == nil {
					logx.Errorf("draw prewarm failed for zone %s: %v", zone, warmErr)
				}
				return
			}
			if season != "" && seasonType != "" {
				logx.Infof("draw prewarm completed for zone %s, season %s, type %s", zone, season, seasonType)
			}
		}(zone)
	}

	// 心跳状态：最后一次心跳时刻 + 是否已收到过首个心跳。
	var beatMu sync.Mutex
	lastBeat := time.Now()
	firstSeen := false

	// /api/heartbeat：页面每 3 秒来敲一次；关标签页/断连后不再敲 → 看门狗超时退出。
	mux.HandleFunc("/api/heartbeat", func(w http.ResponseWriter, r *http.Request) {
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
		nick, exp, reason := svc.Session(r.URL.Query().Get("refresh") == "1")
		writeJSON(w, map[string]any{
			"nick": nick, "exp": exp, "reason": reason,
			"version": opt.Version, "manual_token_only": opt.ManualTokenOnly,
		})
	})

	// /api/token：GET 在用户点击复制后返回当前令牌；PUT 接收并校验手动令牌。
	// 不开放 CORS，PUT 只接受 JSON，避免其它网页用表单跨站写入；所有响应禁止缓存。
	mux.HandleFunc("/api/token", func(w http.ResponseWriter, r *http.Request) {
		defer logx.Recover(r.Method + " /api/token")
		w.Header().Set("Cache-Control", "no-store")
		if !sameOriginTokenRequest(r) {
			writeTokenError(w, http.StatusForbidden, "forbidden", "只允许本程序页面访问登录令牌")
			return
		}
		switch r.Method {
		case http.MethodGet:
			tok := svc.CurrentToken()
			if tok == "" {
				writeTokenError(w, http.StatusUnauthorized, "no_token", "当前没有可复制的有效登录令牌")
				return
			}
			writeJSON(w, map[string]string{"token": tok})
		case http.MethodPut:
			mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
			if err != nil || mediaType != "application/json" {
				writeTokenError(w, http.StatusUnsupportedMediaType, "invalid", "手动令牌必须以 JSON 提交")
				return
			}
			r.Body = http.MaxBytesReader(w, r.Body, 40*1024)
			dec := json.NewDecoder(r.Body)
			dec.DisallowUnknownFields()
			var in struct {
				Token string `json:"token"`
			}
			if dec.Decode(&in) != nil || dec.Decode(&struct{}{}) != io.EOF {
				writeTokenError(w, http.StatusBadRequest, "invalid", "提交的令牌格式不正确")
				return
			}
			nick, exp, reason := svc.SetManualToken(in.Token)
			if reason != "" {
				status, message := manualTokenError(reason)
				writeTokenError(w, status, reason, message)
				return
			}
			writeJSON(w, map[string]any{"nick": nick, "exp": exp, "reason": ""})
		default:
			w.Header().Set("Allow", "GET, PUT")
			writeTokenError(w, http.StatusMethodNotAllowed, "method_not_allowed", "不支持此请求方式")
		}
	})

	// 本地数据 API：浏览器传条件，player 层出整理好的可渲染 JSON。
	searchHandler := handle("GET /api/players/search", func(r *http.Request) (any, error) {
		return svc.Search(r.Context(), r.URL.Query().Get("name"))
	})
	mux.HandleFunc("/api/players/search", searchHandler)
	// 选手详情：作用域(赛区/赛季/门派)走查询参数；排序/快捷筛选/分页在页面本地做。数据按人数缓存，关掉重开即最新。
	detailHandler := handle("GET /api/players/detail", func(r *http.Request) (any, error) {
		q := r.URL.Query()
		only := q.Get("only")
		return svc.Detail(r.Context(), player.Query{
			ID: q.Get("id"), Zone: q.Get("zone"), Season: q.Get("season"), Sect: q.Get("sect"),
			Head: only == "head", FirstPage: only == "firstpage",
		})
	})
	mux.HandleFunc("/api/players/detail", detailHandler)
	// 单场牌局详情：原始 JSON 透传，前端做展示层排版。
	gameHandler := handle("GET /api/games", func(r *http.Request) (any, error) {
		return svc.Game(r.Context(), r.URL.Query().Get("id"))
	})
	mux.HandleFunc("/api/games", gameHandler)

	// 赛事资料：官方赛季/比赛类型/版型/身份字典、门派排名与成员名单。
	mux.HandleFunc("/api/events/draw-prewarm", func(w http.ResponseWriter, r *http.Request) {
		defer logx.Recover(r.Method + " /api/events/draw-prewarm")
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			writeTokenError(w, http.StatusMethodNotAllowed, "method_not_allowed", "不支持此请求方式")
			return
		}
		startDrawPrewarm("")
		w.WriteHeader(http.StatusNoContent)
	})
	eventCatalogHandler := handle("GET /api/events/catalog", func(r *http.Request) (any, error) {
		return evt.EventsCatalog(r.Context())
	})
	mux.HandleFunc("/api/events/catalog", eventCatalogHandler)
	eventSeasonsHandler := handle("GET /api/events/seasons", func(r *http.Request) (any, error) {
		zone := r.URL.Query().Get("zone")
		result, rangeErr := evt.EventSeasonsForZone(r.Context(), zone)
		if rangeErr == nil {
			startDrawPrewarm(zone)
		}
		return result, rangeErr
	})
	mux.HandleFunc("/api/events/seasons", eventSeasonsHandler)
	eventAvailabilityHandler := handle("GET /api/events/availability", func(r *http.Request) (any, error) {
		q := r.URL.Query()
		return evt.EventAvailability(r.Context(), q.Get("season"), q.Get("zone"))
	})
	mux.HandleFunc("/api/events/availability", eventAvailabilityHandler)
	eventSeasonTypesHandler := handle("GET /api/events/season-types", func(r *http.Request) (any, error) {
		q := r.URL.Query()
		types, err := evt.EventSeasonTypesForScope(r.Context(), q.Get("season"), q.Get("zone"))
		if err != nil {
			return nil, err
		}
		return map[string]any{"season_types": types}, nil
	})
	mux.HandleFunc("/api/events/season-types", eventSeasonTypesHandler)
	eventRankingsHandler := handle("GET /api/events/rankings", func(r *http.Request) (any, error) {
		q := r.URL.Query()
		return evt.EventSectRankings(r.Context(), q.Get("season"), q.Get("type"), q.Get("zone"))
	})
	mux.HandleFunc("/api/events/rankings", eventRankingsHandler)
	eventRankMetricsHandler := handle("GET /api/events/rank-metrics", func(r *http.Request) (any, error) {
		q := r.URL.Query()
		page, _ := strconv.Atoi(q.Get("page"))
		if page == 0 {
			page = 1
		}
		return evt.EventSectRankMetricPage(r.Context(), q.Get("season"), q.Get("type"), q.Get("zone"), page)
	})
	mux.HandleFunc("/api/events/rank-metrics", eventRankMetricsHandler)
	eventMetricsHandler := handle("GET /api/events/metrics", func(r *http.Request) (any, error) {
		q := r.URL.Query()
		return evt.EventSectRankMetrics(r.Context(), q.Get("season"), q.Get("type"), q.Get("zone"))
	})
	mux.HandleFunc("/api/events/metrics", eventMetricsHandler)
	eventTeamHandler := handle("GET /api/events/team", func(r *http.Request) (any, error) {
		q := r.URL.Query()
		return evt.EventTeam(r.Context(), q.Get("id"), q.Get("season"), q.Get("type"), q.Get("zone"))
	})
	mux.HandleFunc("/api/events/team", eventTeamHandler)
	eventDrawToolHandler := handle("GET /api/events/draw-tool", func(r *http.Request) (any, error) {
		q := r.URL.Query()
		return evt.EventDrawTool(r.Context(), q.Get("season"), q.Get("type"), q.Get("zone"))
	})
	mux.HandleFunc("/api/events/draw-tool", eventDrawToolHandler)
	eventGroupDrawHandler := handle("GET /api/events/group-draw", func(r *http.Request) (any, error) {
		q := r.URL.Query()
		return evt.EventGroupDraw(r.Context(), q.Get("season"), q.Get("type"), q.Get("zone"))
	})
	mux.HandleFunc("/api/events/group-draw", eventGroupDrawHandler)

	// /api/latest：服务端代拉更新清单（绕过浏览器跨域、不带任何令牌），并按当前系统选择下载链接。
	// 未配置 opt.UpdateURL 时回 {configured:false}，页面提示“暂未开放”。
	mux.HandleFunc("/api/latest", func(w http.ResponseWriter, r *http.Request) {
		defer logx.Recover("GET /api/latest")
		if opt.UpdateURL == "" {
			writeJSON(w, map[string]any{"configured": false})
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
		defer cancel()
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, opt.UpdateURL, nil)
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
			Version   string            `json:"version"`
			URL       string            `json:"url"`
			Downloads map[string]string `json:"downloads"`
			Notes     string            `json:"notes"`
		}
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
		if json.Unmarshal(body, &mf) != nil || mf.Version == "" {
			writeErr(w, fmt.Errorf("更新清单格式异常"))
			return
		}
		writeJSON(w, map[string]any{
			"configured": true, "version": mf.Version,
			"url":       selectUpdateURL(mf.Downloads, mf.URL, runtime.GOOS, runtime.GOARCH),
			"downloads": mf.Downloads, "notes": mf.Notes,
		})
	})

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		defer logx.Recover("GET " + r.URL.Path)
		w.Header().Set("Cache-Control", "no-store") // 每个版本都是新 exe，避免浏览器用旧缓存的 js/css
		files.ServeHTTP(w, r)
	})

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		cancelPrewarm()
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
		closeOnce.Do(func() {
			cancelPrewarm()
			prewarmWG.Wait()
			close(stop)
		})
		return srv.Close()
	}
	return "http://" + ln.Addr().String() + "/", quit, closeFn, nil
}

func selectUpdateURL(downloads map[string]string, fallback, goos, goarch string) string {
	key := goos + "_" + goarch
	if goos == "darwin" {
		key = "mac_" + goarch
	}
	if url := downloads[key]; url != "" {
		return url
	}
	if goos == "windows" {
		return fallback
	}
	return ""
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

func sameOriginTokenRequest(r *http.Request) bool {
	if site := r.Header.Get("Sec-Fetch-Site"); site == "cross-site" {
		return false
	}
	if origin := r.Header.Get("Origin"); origin != "" && origin != "http://"+r.Host {
		return false
	}
	return true
}

func writeTokenError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"code": code, "message": message}})
}

func manualTokenError(reason string) (int, string) {
	switch reason {
	case "expired":
		return http.StatusUnauthorized, "这个登录令牌已过期或无效"
	case "network":
		return http.StatusBadGateway, "暂时连不上华山服务器，无法校验令牌"
	case "server":
		return http.StatusBadGateway, "华山服务器暂时异常，无法校验令牌"
	default:
		return http.StatusBadRequest, "请输入完整的登录令牌"
	}
}

func writeErr(w http.ResponseWriter, err error) {
	status, msg := player.ErrorStatus(err)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"message": msg}})
}
