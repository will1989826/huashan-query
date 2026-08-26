// Package huashan 是官方接口(v2.huashan.tv)的服务端客户端：注入令牌、401 自动刷新重试、
// 分页拉全、错误信封归一。令牌只存在于本进程，永不下发浏览器——页面只经本地服务拿整理好的 JSON。
package huashan

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"sync"
	"time"

	"huashanquery/internal/logx"
	"huashanquery/internal/token"
)

// 逐场战绩分页：每页 100，最多 200 页(=2 万场)封顶，超出即标记截断；已知总数时用 gamesWorkers 个协程并发拉取余下分页。
const (
	gamesPerPage      = 100
	gamesMaxPage      = 200
	gamesWorkers      = 8
	gamesPageAttempts = 3 // 单页最多尝试次数（含首次）：瞬时错误(429/5xx/网络)退避后重试，抗重度选手多页下的偶发抖动

	// upstreamConc 是对官方接口的全局并发上限。PlayerGames 各自的 8 并发只是单次拉取内的，不跨请求限流；
	// 连续切换多个选手/赛区时，孤儿拉取虽会被引用计数取消，但取消到位有窗口，这里再兜一道全局闸，
	// 把同时打到官方的请求数封住，避免 N×8 突发触发 429 / 争抢带宽拖慢当前真正需要的请求。
	upstreamConc = 16
)

// gamesRetryBackoff 是各次重试前的等待（var 便于测试调零）；尝试数超出则复用最后一档。
var gamesRetryBackoff = []time.Duration{300 * time.Millisecond, 900 * time.Millisecond}

// TokenProvider 提供当前令牌、账号昵称、以及“没有有效令牌”的精确原因（token.Manager 即实现）。令牌串只在本包内部使用。
type TokenProvider interface {
	Current() (token, nick string, reason token.Reason)
	Refresh() (token, nick string, reason token.Reason)
}

// manualTokenProvider 是可选能力；生产环境的 token.Manager 实现它，测试桩无需强制实现。
type manualTokenProvider interface {
	SetManual(raw string) (token, nick string, reason token.Reason)
}

// Client 调用官方接口。Base/HTTP 导出以便测试指向 httptest 服务；生产用 New 的默认值。
// sem 是全局上游并发闸（nil=不限流，测试字面构造走此分支）。
type Client struct {
	TP   TokenProvider
	HTTP *http.Client
	Base string
	sem  chan struct{}
}

// New 构造指向线上官方接口的客户端。
func New(tp TokenProvider) *Client {
	return &Client{TP: tp, HTTP: &http.Client{Timeout: 30 * time.Second}, Base: "https://v2.huashan.tv/api", sem: make(chan struct{}, upstreamConc)}
}

// APIError 把官方错误归一成“建议的 HTTP 状态 + 人话消息”，由服务端原样回给页面。
type APIError struct {
	Status  int
	Message string
}

func (e *APIError) Error() string { return e.Message }

// Session 返回账号昵称、令牌到期时刻(unix 秒)、以及没有有效令牌时的精确原因——
// 只给页面看有效期与原因，不下发令牌本身。force=true 时强制重扫（页面 401 或点“重新检测”）。
func (c *Client) Session(force bool) (nick string, expUnix int64, reason string) {
	var tok string
	var r token.Reason
	if force {
		tok, nick, r = c.TP.Refresh()
	} else {
		tok, nick, r = c.TP.Current()
	}
	return nick, token.Exp(tok), string(r)
}

// CurrentToken 返回当前有效令牌，供本机页面在用户明确点击“复制”后读取。
func (c *Client) CurrentToken() string {
	tok, _, reason := c.TP.Current()
	if reason != token.ReasonOK {
		return ""
	}
	return tok
}

// SetManualToken 校验并采用手动令牌；令牌由 provider 保存在进程内存中。
func (c *Client) SetManualToken(raw string) (nick string, expUnix int64, reason string) {
	p, ok := c.TP.(manualTokenProvider)
	if !ok {
		return "", 0, string(token.ReasonInvalid)
	}
	tok, nick, r := p.SetManual(raw)
	return nick, token.Exp(tok), string(r)
}

// SearchPlayers 按名字搜选手（免鉴权）。返回官方原始 JSON（数组或 {items}）。
func (c *Client) SearchPlayers(ctx context.Context, name string) ([]byte, error) {
	return c.get(ctx, "/stats/club-players?page=1&size=30&player_name="+url.QueryEscape(name), false)
}

// PlayerStats 取选手聚合统计。zone 恒传(含 ALL，官方接受)，leagueTier 固定 1，season 非空才带。
func (c *Client) PlayerStats(ctx context.Context, id, zone, season string) ([]byte, error) {
	if zone == "" {
		zone = "ALL"
	}
	path := fmt.Sprintf("/stats/games/players/%s?zone_id=%s&leagueTier=1", url.PathEscape(id), url.QueryEscape(zone))
	if season != "" {
		path += "&season_id=" + url.QueryEscape(season)
	}
	return c.get(ctx, path, true)
}

// Game 取单场牌局详情（投票/技能/刀验）。
func (c *Client) Game(ctx context.Context, gid string) ([]byte, error) {
	return c.get(ctx, "/werewolves/games/"+url.PathEscape(gid), true)
}

// PlayerLatestSect 取选手在指定赛区+赛季的最新一场所属门派名（size=1，逐场按日期倒序）。
// 用于赛事门派归属歧义时定位选手本赛季真实门派：选手每赛季只为一个门派出战，任一场的门派名即可，取最新一场最稳。
// 该作用域无出场记录时返回空串（调用方据此跳过）。
func (c *Client) PlayerLatestSect(ctx context.Context, id, zone, season string) (string, error) {
	path := fmt.Sprintf("/stats/players/games/%s/details?page=1&size=1", url.PathEscape(id))
	if zone != "ALL" && zone != "" {
		path += "&zone_id=" + url.QueryEscape(zone)
	}
	if season != "" {
		path += "&season_id=" + url.QueryEscape(season)
	}
	body, err := c.get(ctx, path, true)
	if err != nil {
		return "", err
	}
	var d struct {
		Items []struct {
			SectName string `json:"sect_name"`
		} `json:"items"`
	}
	if err := json.Unmarshal(body, &d); err != nil {
		return "", &APIError{Status: http.StatusBadGateway, Message: "战绩数据解析失败：" + err.Error()}
	}
	if len(d.Items) == 0 {
		return "", nil
	}
	return d.Items[0].SectName, nil
}

// PlayerEventGames 只读取一名选手在指定赛事中的逐场。季后赛/总决赛每名选手最多 16 局，
// 一页即可取全；total_items 大于返回条数时由上层判定筛选未生效并回退到完整逐场缓存。
func (c *Client) PlayerEventGames(ctx context.Context, id, zone, season, seasonType string) ([]json.RawMessage, int, error) {
	var items []json.RawMessage
	var total int
	var err error
	for attempt := 0; attempt < gamesPageAttempts; attempt++ {
		if attempt > 0 {
			d := gamesRetryBackoff[min(attempt-1, len(gamesRetryBackoff)-1)]
			select {
			case <-ctx.Done():
				return nil, 0, ctx.Err()
			case <-time.After(d):
			}
		}
		items, total, err = c.playerEventGamesOnce(ctx, id, zone, season, seasonType)
		if err == nil || !transient(err) {
			return items, total, err
		}
	}
	return items, total, err
}

func (c *Client) playerEventGamesOnce(ctx context.Context, id, zone, season, seasonType string) ([]json.RawMessage, int, error) {
	q := url.Values{}
	q.Set("page", "1")
	q.Set("size", strconv.Itoa(gamesPerPage))
	if zone != "ALL" && zone != "" {
		q.Set("zone_id", zone)
	}
	if season != "" {
		q.Set("season_id", season)
	}
	if seasonType != "" {
		q.Set("season_type_id", seasonType)
	}
	path := fmt.Sprintf("/stats/players/games/%s/details?%s", url.PathEscape(id), q.Encode())
	body, err := c.get(ctx, path, true)
	if err != nil {
		return nil, 0, err
	}
	var d struct {
		Items      []json.RawMessage `json:"items"`
		TotalItems *int              `json:"total_items"`
	}
	if err := json.Unmarshal(body, &d); err != nil {
		return nil, 0, &APIError{Status: http.StatusBadGateway, Message: "战绩数据解析失败：" + err.Error()}
	}
	total := len(d.Items)
	if d.TotalItems != nil {
		total = *d.TotalItems
	}
	return d.Items, total, nil
}

// EventSeasons 返回官方赛季字典。
func (c *Client) EventSeasons(ctx context.Context) ([]byte, error) {
	return c.get(ctx, "/system/dicts/suites/season", true)
}

// EventSeasonTypes 返回官方比赛类型字典（常规赛、季后赛等）。
func (c *Client) EventSeasonTypes(ctx context.Context) ([]byte, error) {
	return c.get(ctx, "/system/dicts/suites/season.type", true)
}

// Editions 返回版型字典。
func (c *Client) Editions(ctx context.Context) ([]byte, error) {
	return c.get(ctx, "/settings/editions", true)
}

// Roles 返回身份字典。
func (c *Client) Roles(ctx context.Context) ([]byte, error) {
	return c.get(ctx, "/settings/rpts", true)
}

// Team 返回单个门派的基础资料。
func (c *Client) Team(ctx context.Context, id string) ([]byte, error) {
	return c.get(ctx, "/werewolves/sects/"+url.PathEscape(id), true)
}

// TeamMembers 返回门派当前可选成员。
func (c *Client) TeamMembers(ctx context.Context, id string) ([]byte, error) {
	return c.get(ctx, "/settings/players?sect_id="+url.QueryEscape(id), true)
}

// SectStats 返回指定赛事范围内的门派统计分页。
func (c *Client) SectStats(ctx context.Context, season, seasonType, zone string, page, size int) ([]byte, error) {
	q := url.Values{}
	q.Set("page", fmt.Sprint(page))
	q.Set("size", fmt.Sprint(size))
	q.Set("season_id", season)
	if seasonType != "" {
		q.Set("season_type_id", seasonType)
	}
	addZoneID(q, zone)
	return c.get(ctx, "/stats/sect-stats?"+q.Encode(), true)
}

// EventPlayerStats 返回指定赛事范围内的选手汇总分页；赛事排名只读取门派关系与轮次来折算比赛日。
func (c *Client) EventPlayerStats(ctx context.Context, season, seasonType, zone string, page, size int) ([]byte, error) {
	q := url.Values{}
	q.Set("page", fmt.Sprint(page))
	q.Set("size", fmt.Sprint(size))
	q.Set("season_id", season)
	if seasonType != "" {
		q.Set("season_type_id", seasonType)
	}
	addZoneID(q, zone)
	return c.get(ctx, "/stats/players/games?"+q.Encode(), true)
}

// addZoneID 仅在赛区为具体赛区时附带 zone_id；ALL 或空表示不限赛区，不带该参数（官方据此返回全赛区数据）。
func addZoneID(q url.Values, zone string) {
	if zone != "" && zone != "ALL" {
		q.Set("zone_id", zone)
	}
}

// PlayerGames 分页拉全某赛区逐场战绩，返回原始条目切片与是否截断/不完整。
// = GamesFirstPage（拉第 1 页拿总数）+ GamesRest（拉其余页）。拆成两半是为了让”头部阶段的首屏预览”与
// “完整阶段的全量索引”复用同一份第 1 页（见 player 层的 gp1 缓存），每页只拉一次、不重复。
func (c *Client) PlayerGames(ctx context.Context, id, zone string) (items []json.RawMessage, trunc bool, err error) {
	first, total, err := c.GamesFirstPage(ctx, id, zone)
	if err != nil {
		return nil, false, err
	}
	return c.GamesRest(ctx, id, zone, first, total)
}

// GamesFirstPage 拉第 1 页并返回总数(total_items)；总数缺失时 total=-1（未知，交 GamesRest 顺序拉取）。
// 带瞬时错误退避重试。zone=ALL 时不带 zone_id。
func (c *Client) GamesFirstPage(ctx context.Context, id, zone string) (items []json.RawMessage, total int, err error) {
	return c.gamesPageRetry(ctx, id, zone, 1)
}

// GamesRest 给定已取到的第 1 页(first)与总数(total)，拉其余页并拼装成完整切片。
// 抗超时：单页瞬时错误(429/5xx/网络)退避重试；重试仍失败则跳过该页并标记 trunc(不完整)，绝不让某一页
// 拖垮整份拉取——重度选手(如刘二龙)宁可少几场并给出”可能不完整”提示，也不整页失败。仅 401 视为致命、中止全部。
// 已知总数时：即便各页都成功，只要拼接条数 != total（偏少=短/空/缺页；偏多=分页漂移/上游异常）也标记 trunc——不把无法保证无重复无遗漏的数据当完整。
func (c *Client) GamesRest(ctx context.Context, id, zone string, first []json.RawMessage, total int) (items []json.RawMessage, trunc bool, err error) {
	if total < 0 { // 未知总数：顺序拉取，短页/空页即末页
		if len(first) == 0 {
			return []json.RawMessage{}, false, nil
		}
		return c.gamesSequential(ctx, id, zone, first)
	}

	pages := (total + gamesPerPage - 1) / gamesPerPage
	if pages > gamesMaxPage {
		pages, trunc = gamesMaxPage, true // 超安全上限：截断
	}
	if pages <= 1 {
		items = first
	} else {
		// 并发拉取第 2..pages 页；每页写入独立下标，无共享写冲突。401 中止全部；其它瞬时错误重试仍失败则容忍缺页。
		results := make([][]json.RawMessage, pages+1)
		results[1] = first
		fetchCtx, cancel := context.WithCancel(ctx)
		defer cancel()
		sem := make(chan struct{}, gamesWorkers)
		var wg sync.WaitGroup
		var mu sync.Mutex
		var fatal error  // 401 等致命错误：中止全部
		partial := false // 某页重试后仍失败：跳过该页、标记不完整，但不放弃其余
		for p := 2; p <= pages; p++ {
			wg.Add(1)
			go func(page int) {
				defer wg.Done()
				sem <- struct{}{}
				defer func() { <-sem }()
				if fetchCtx.Err() != nil {
					return
				}
				pg, _, e := c.gamesPageRetry(fetchCtx, id, zone, page)
				if e != nil {
					mu.Lock()
					if isAuth(e) {
						if fatal == nil {
							fatal = e
							cancel()
						}
					} else {
						partial = true // 瞬时错误重试后仍失败：容忍缺页
					}
					mu.Unlock()
					return
				}
				results[page] = pg
			}(p)
		}
		wg.Wait()
		if fatal != nil {
			return nil, false, fatal
		}
		for p := 1; p <= pages; p++ {
			items = append(items, results[p]...)
		}
		trunc = trunc || partial
	}
	if len(items) != total { // 拼接条数与 total 不符（短/空/缺页导致偏少，或分页漂移/上游异常导致偏多）：无法保证无重复无遗漏
		trunc = true
	}
	return items, trunc, nil
}

// gamesSequential 未知总数时从第 2 页起顺序拉取（第 1 页已由调用方取到）。
func (c *Client) gamesSequential(ctx context.Context, id, zone string, first []json.RawMessage) ([]json.RawMessage, bool, error) {
	all := append([]json.RawMessage{}, first...)
	for page := 2; ; page++ {
		items, _, err := c.gamesPageRetry(ctx, id, zone, page)
		if err != nil {
			return nil, false, err
		}
		all = append(all, items...)
		if len(items) == 0 { // 空页：无进展
			break
		}
		if len(items) < gamesPerPage { // 短页：末页
			break
		}
		if page >= gamesMaxPage { // 安全上限：截断
			return all, true, nil
		}
	}
	return all, false, nil
}

// gamesPageRetry 拉取单页，遇瞬时错误(429/5xx/网络)按 gamesRetryBackoff 退避重试；致命错误(如 401)或成功即返回。
// 退避期间尊重 ctx 取消。
func (c *Client) gamesPageRetry(ctx context.Context, id, zone string, page int) (items []json.RawMessage, total int, err error) {
	for attempt := 0; attempt < gamesPageAttempts; attempt++ {
		if attempt > 0 {
			d := gamesRetryBackoff[min(attempt-1, len(gamesRetryBackoff)-1)]
			select {
			case <-ctx.Done():
				return nil, 0, ctx.Err()
			case <-time.After(d):
			}
		}
		items, total, err = c.gamesPage(ctx, id, zone, page)
		if err == nil || !transient(err) {
			return items, total, err
		}
	}
	return items, total, err
}

// transient 判定错误是否可重试：429 或 5xx（含本包把网络/读取失败归一的 502）。401/403/404 等不重试。
func transient(err error) bool {
	ae, ok := err.(*APIError)
	return ok && (ae.Status == http.StatusTooManyRequests || ae.Status >= 500)
}

// isAuth 判定是否 401（令牌失效）：这是唯一在并发拉取里“致命、需中止全部”的错误。
func isAuth(err error) bool {
	ae, ok := err.(*APIError)
	return ok && ae.Status == http.StatusUnauthorized
}

// gamesPage 拉取单页逐场战绩，返回该页条目与总数(total_items)。总数缺失时 total=-1。
func (c *Client) gamesPage(ctx context.Context, id, zone string, page int) (items []json.RawMessage, total int, err error) {
	path := fmt.Sprintf("/stats/players/games/%s/details?page=%d&size=%d", url.PathEscape(id), page, gamesPerPage)
	if zone != "ALL" && zone != "" {
		path += "&zone_id=" + url.QueryEscape(zone)
	}
	body, err := c.get(ctx, path, true)
	if err != nil {
		return nil, 0, err
	}
	var d struct {
		Items      []json.RawMessage `json:"items"`
		TotalItems *int              `json:"total_items"`
	}
	if err := json.Unmarshal(body, &d); err != nil {
		return nil, 0, &APIError{Status: http.StatusBadGateway, Message: "战绩数据解析失败：" + err.Error()}
	}
	if d.TotalItems == nil {
		return d.Items, -1, nil
	}
	return d.Items, *d.TotalItems, nil
}

// get 请求官方接口；auth=true 注入 Bearer，遇 401 强刷令牌一次并重试（对应重新登录/令牌被吊销）。
// 成功返回原始响应体；官方错误(非 200 或 body 含 error 字段)归一成 *APIError。
func (c *Client) get(ctx context.Context, path string, auth bool) ([]byte, error) {
	body, status, err := c.do(ctx, path, auth, false)
	if err != nil {
		return nil, err
	}
	if status == http.StatusUnauthorized && auth { // 令牌过期：强制重扫并重试一次
		body, status, err = c.do(ctx, path, auth, true)
		if err != nil {
			return nil, err
		}
	}
	if status == http.StatusUnauthorized {
		return nil, &APIError{Status: http.StatusUnauthorized, Message: "令牌已过期或无效：请在微信重开战力页后点刷新"}
	}
	if status != http.StatusOK {
		return nil, &APIError{Status: status, Message: errMessage(body, status)}
	}
	if msg, bad := envelopeError(body); bad { // HTTP 200 但 body 里带 error 字段
		return nil, &APIError{Status: http.StatusBadGateway, Message: msg}
	}
	return body, nil
}

// do 发一次请求。forceRefresh=true 时取强刷后的令牌。返回响应体、状态码、传输层错误。
func (c *Client) do(ctx context.Context, path string, auth, forceRefresh bool) ([]byte, int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.Base+path, nil)
	if err != nil {
		return nil, 0, &APIError{Status: http.StatusBadGateway, Message: err.Error()}
	}
	if auth {
		var tok string
		if forceRefresh {
			tok, _, _ = c.TP.Refresh()
		} else {
			tok, _, _ = c.TP.Current()
		}
		req.Header.Set("Authorization", "Bearer "+tok)
	}
	if c.sem != nil { // 全局上游并发闸：等待期间尊重 ctx 取消（切换选手/赛区时不空占额度）
		select {
		case c.sem <- struct{}{}:
			defer func() { <-c.sem }()
		case <-ctx.Done():
			return nil, 0, ctx.Err()
		}
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		if ctx.Err() != nil { // 页面切换/关闭导致的主动取消：不是错误，静默上抛
			return nil, 0, ctx.Err()
		}
		logx.Errorf("huashan request %s failed: %v", path, err)
		return nil, 0, &APIError{Status: http.StatusBadGateway, Message: "网络请求失败：" + err.Error()}
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	if err != nil { // 读取中断（如网络截断）：不能当成功，否则会把残缺 JSON 当数据缓存
		if ctx.Err() != nil {
			return nil, 0, ctx.Err()
		}
		logx.Errorf("huashan read body %s failed: %v", path, err)
		return nil, 0, &APIError{Status: http.StatusBadGateway, Message: "网络响应读取失败：" + err.Error()}
	}
	return b, resp.StatusCode, nil
}

// errMessage 从官方错误体里抽人话消息，抽不到就退回 "HTTP <status>"（与旧前端一致）。
func errMessage(body []byte, status int) string {
	if msg, ok := envelopeError(body); ok && msg != "" {
		return msg
	}
	return fmt.Sprintf("HTTP %d", status)
}

// envelopeError 解析 {error:{message|verbose_message}} 信封。bad=是否存在 error 字段。
func envelopeError(body []byte) (msg string, bad bool) {
	var d struct {
		Error *struct {
			Message        string `json:"message"`
			VerboseMessage string `json:"verbose_message"`
		} `json:"error"`
	}
	if json.Unmarshal(body, &d) != nil || d.Error == nil {
		return "", false
	}
	if d.Error.Message != "" {
		return d.Error.Message, true
	}
	return d.Error.VerboseMessage, true
}
