// Package token 是令牌业务层：聚合多个来源(Source)的候选令牌，联网校验，给出当前有效令牌。
// 通过 Source 接口解耦——将来新增令牌来源(手动粘贴、其他端等)只需实现 Source，无需改动本包。
package token

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"huashanquery/internal/logx"
)

var apiCheck = "https://v2.huashan.tv/api/user/profile" // var 便于测试指向 httptest；生产不改

// 缓存策略：校验通过的令牌缓存到其到期时刻（提前 expMargin 失效以便平滑续期）；
// exp 不可解析时退化为 fallbackTTL，仍能避免频繁重复扫盘/联网。
// 强制刷新(Refresh)在 forceWindow 内若刚扫过则直接复用，抑制 401 风暴下的并发重复扫描。
const (
	expMargin   = 60 * time.Second
	fallbackTTL = 5 * time.Minute
	forceWindow = 2 * time.Second // 前端 ui.js 的 DETECT_INTERVAL 必须大于它，否则持续检测会命中缓存空转
)

// Source 是令牌候选来源。返回未校验的候选串（如微信本地存储）。
type Source interface {
	Candidates() []string
}

// Reason 是“为什么没有有效令牌”的精确原因，随取令牌一起返回，供页面给出针对性提示。
type Reason string

const (
	ReasonOK      Reason = ""         // 有有效令牌
	ReasonNoToken Reason = "no_token" // 没扫到任何候选：微信未登录/非电脑版/没开过战力页/文件太旧
	ReasonInvalid Reason = "invalid"  // 手动输入为空或不是可用的 Bearer 令牌格式
	ReasonExpired Reason = "expired"  // 有候选但被明确拒绝(401/403)：令牌过期/失效，回微信重开战力页刷新
	ReasonServer  Reason = "server"   // 官方服务器异常：429/5xx/维护页/200 但响应结构非法——不是用户的锅，稍后重试
	ReasonNetwork Reason = "network"  // 校验时联网失败：断网、DNS、防火墙或响应体读取中断
)

// Manager 聚合多个来源，负责去重、按到期时间排序、联网校验，并缓存/合并并发扫描。
type Manager struct {
	Sources  []Source
	Validate func(tok string) (nick string, ok bool) // nil=默认联网校验；测试可注入

	mu            sync.Mutex
	manualTok     string // 用户手动输入的令牌；仅保存在当前进程内存中
	cachedTok     string
	cachedNik     string
	cachedReason  Reason      // 上次扫描得到的原因（tok 非空时为 ReasonOK）
	cachedExp     time.Time   // 缓存令牌的失效时刻（已含 margin）
	lastForceScan time.Time   // 上次“强制刷新”完成的时刻（仅强刷之间互相抑制，不受普通 Current 影响）
	inflight      *scanResult // 非 nil 表示有扫描进行中，后来者搭车复用
}

// scanResult 承载一次进行中的扫描，供并发调用者搭车（singleflight）。
type scanResult struct {
	done   chan struct{}
	tok    string
	nick   string
	reason Reason
}

func (m *Manager) candidates() []string {
	seen := map[string]bool{}
	var toks []string
	if m.manualTok != "" {
		seen[m.manualTok] = true
		toks = append(toks, m.manualTok)
	}
	for _, s := range m.Sources {
		for _, t := range s.Candidates() {
			if t != "" && !seen[t] {
				seen[t] = true
				toks = append(toks, t)
			}
		}
	}
	sort.SliceStable(toks, func(i, j int) bool { return payloadExp(toks[i]) > payloadExp(toks[j]) })
	return toks
}

// SetManual 校验并采用用户手动输入的令牌。令牌只保存在当前进程内存中；校验失败不会替换现有会话。
// raw 可以是纯令牌，也可以带常见的 "Bearer " 前缀。
func (m *Manager) SetManual(raw string) (token, nick string, reason Reason) {
	tok := strings.TrimSpace(raw)
	if strings.EqualFold(tok, "Bearer") {
		return "", "", ReasonInvalid
	}
	if len(tok) >= 7 && strings.EqualFold(tok[:7], "Bearer ") {
		tok = strings.TrimSpace(tok[7:])
	}
	if tok == "" || len(tok) > 32*1024 || strings.ContainsAny(tok, " \t\r\n") {
		return "", "", ReasonInvalid
	}

	if m.Validate != nil {
		var ok bool
		nick, ok = m.Validate(tok)
		if !ok {
			return "", "", ReasonExpired
		}
	} else {
		var out valOutcome
		nick, out = validate(tok)
		switch out {
		case valOK:
		case valNetwork:
			return "", "", ReasonNetwork
		case valServer:
			return "", "", ReasonServer
		default:
			return "", "", ReasonExpired
		}
	}

	// 不与正在进行的自动扫描争写缓存；等它结束后原子替换成刚校验通过的手动会话。
	for {
		m.mu.Lock()
		if m.inflight == nil {
			m.manualTok = tok
			m.cachedTok, m.cachedNik, m.cachedReason = tok, nick, ReasonOK
			if exp := payloadExp(tok); exp > 0 {
				m.cachedExp = time.Unix(exp, 0).Add(-expMargin)
			} else {
				m.cachedExp = time.Now().Add(fallbackTTL)
			}
			m.lastForceScan = time.Time{}
			m.mu.Unlock()
			return tok, nick, ReasonOK
		}
		sr := m.inflight
		m.mu.Unlock()
		<-sr.done
	}
}

// Current 返回当前有效令牌、账号昵称与原因；命中未过期缓存时直接返回，不重复扫盘/联网。
func (m *Manager) Current() (token, nick string, reason Reason) { return m.get(false) }

// Refresh 强制重新扫描并校验（页面收到 401 或点“重新检测”时调用）。
func (m *Manager) Refresh() (token, nick string, reason Reason) { return m.get(true) }

// get 是 Current/Refresh 的公共实现：缓存命中即返回；否则合并并发扫描，只让一个协程真正扫描。
func (m *Manager) get(force bool) (token, nick string, reason Reason) {
	now := time.Now()
	m.mu.Lock()
	fresh := m.cachedTok != "" && now.Before(m.cachedExp)
	// 强刷仅被“最近一次强刷”抑制（合并 401 风暴），不被普通 Current 的扫描时间抑制——
	// 否则页面刚启动 Current 扫过，业务接口立刻 401 时，Refresh 会把同一枚坏令牌原样返回。
	recentForce := force && !m.lastForceScan.IsZero() && now.Sub(m.lastForceScan) < forceWindow
	if (!force && fresh) || recentForce {
		t, n, r := m.cachedTok, m.cachedNik, m.cachedReason
		m.mu.Unlock()
		return t, n, r
	}
	if m.inflight != nil { // 已有扫描进行中：搭车等待其结果
		sr := m.inflight
		m.mu.Unlock()
		<-sr.done
		return sr.tok, sr.nick, sr.reason
	}
	sr := &scanResult{done: make(chan struct{})}
	m.inflight = sr
	m.mu.Unlock()

	// 扫描+校验在锁外进行（可能耗时数秒），避免阻塞缓存命中的读者。
	sr.tok, sr.nick, sr.reason = m.scan()

	m.mu.Lock()
	m.cachedTok, m.cachedNik, m.cachedReason = sr.tok, sr.nick, sr.reason
	if force {
		m.lastForceScan = time.Now()
	}
	if sr.tok != "" {
		if exp := payloadExp(sr.tok); exp > 0 {
			m.cachedExp = time.Unix(exp, 0).Add(-expMargin)
		} else {
			m.cachedExp = time.Now().Add(fallbackTTL)
		}
	} else {
		m.cachedExp = time.Time{} // 未找到：不缓存有效期（强刷风暴由 lastForceScan 抑制）
	}
	m.inflight = nil
	m.mu.Unlock()
	close(sr.done)
	return sr.tok, sr.nick, sr.reason
}

// scan 聚合来源候选、按到期排序、逐个联网校验，返回首个有效令牌；失败时给出精确原因。
// 多候选全失败时按“最能说明问题”的优先级归因：网络 > 服务器异常 > 过期。
func (m *Manager) scan() (token, nick string, reason Reason) {
	cands := m.candidates()
	var sawNet, sawServer bool
	for _, t := range cands {
		if m.Validate != nil { // 测试注入：只区分 通过/不通过（网络/服务器细分仅默认校验器能判断）→ 不通过归入默认(过期)
			if n, ok := m.Validate(t); ok {
				return t, n, ReasonOK
			}
			continue
		}
		n, out := validate(t)
		switch out {
		case valOK:
			return t, n, ReasonOK
		case valNetwork:
			sawNet = true
		case valServer:
			sawServer = true
		}
	}
	switch {
	case len(cands) == 0:
		logx.Errorf("no candidate token found (not logged in WeChat on this PC / WeChat dir not matched / files skipped as too old)")
		return "", "", ReasonNoToken
	case sawNet:
		logx.Errorf("found %d candidate token(s) but validation could not reach the server (offline / DNS / firewall / truncated response)", len(cands))
		return "", "", ReasonNetwork
	case sawServer:
		logx.Errorf("found %d candidate token(s) but the server returned an error (429/5xx/maintenance/invalid body)", len(cands))
		return "", "", ReasonServer
	default:
		logx.Errorf("found %d candidate token(s) but all were rejected (401/403 — likely expired; reopen the huashan page in WeChat)", len(cands))
		return "", "", ReasonExpired
	}
}

// Exp 返回 JWT 载荷里的到期时刻(unix 秒)，无法解析时返回 0。
// 供服务端向页面暴露“令牌有效至”用——只下发到期时间，不下发令牌本身。
func Exp(tok string) int64 { return payloadExp(tok) }

func payloadExp(tok string) int64 {
	parts := strings.Split(tok, ".")
	if len(parts) < 2 {
		return 0
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(parts[1], "="))
	if err != nil {
		return 0
	}
	var pl struct {
		Exp int64 `json:"exp"`
	}
	json.Unmarshal(raw, &pl)
	return pl.Exp
}

// valOutcome 是单枚令牌一次校验的结果分类，供 scan 精确归因。
type valOutcome int

const (
	valOK      valOutcome = iota // 200 且响应结构合法
	valExpired                   // 401/403：令牌被明确拒绝
	valServer                    // 429/5xx/其它非 200/200 但结构非法：服务器侧问题
	valNetwork                   // 传输失败或响应体读取中断：连不上/被截断
)

// validate 联网校验一枚令牌并分类结果，把“令牌过期(401/403)”“服务器异常(429/5xx/维护)”“连不上(网络)”区分开，
// 好让页面给出精确、不误导的提示。
func validate(tok string) (nick string, out valOutcome) {
	req, _ := http.NewRequest("GET", apiCheck, nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	resp, err := (&http.Client{Timeout: 15 * time.Second}).Do(req)
	if err != nil {
		logx.Errorf("validate request failed: %v", err)
		return "", valNetwork
	}
	defer resp.Body.Close()
	switch {
	case resp.StatusCode == 200:
		body, err := io.ReadAll(resp.Body)
		if err != nil { // 200 但读取中断（网络截断）：当网络问题，别当过期
			logx.Errorf("validate read body failed: %v", err)
			return "", valNetwork
		}
		var d struct {
			PlayerID float64 `json:"player_id"`
			Nickname string  `json:"nickname"`
		}
		if json.Unmarshal(body, &d) == nil && d.PlayerID != 0 {
			return d.Nickname, valOK
		}
		return "", valServer // 200 但结构非法（如维护页/异常响应）：服务器侧问题，非“过期”
	case resp.StatusCode == 401 || resp.StatusCode == 403:
		return "", valExpired // 明确拒绝：令牌过期/失效
	default:
		return "", valServer // 429/5xx/其它：服务器暂时异常
	}
}
