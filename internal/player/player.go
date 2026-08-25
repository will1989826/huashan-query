// player.go —— player 包的服务层：编排“取数据(缓存/并发) → 计算 → 组装模型”。
// Detail 并发拉取 统计(stats) 与 逐场(games)，命中缓存则零网络；在内存里完成聚合/候选/按作用域筛选，
// 输出“数值化”的 DetailView（不含中文标签/格式化）。逐场表的排序、快捷筛选、分页由页面完成。
// 层次：server → player(本层) → huashan(传输) → token。
package player

import (
	"context"
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"sync"

	"huashanquery/internal/huashan"
)

// —— 模型（前端只渲染/格式化，不再做重计算）——
type Zone struct {
	Ordering string `json:"ordering"`
	Text     string `json:"text"`
}
type PlayerInfo struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Avatar string `json:"avatar"`
}

// Honor 原样给出赛区代码/赛季/名次码；赛区中文名与“冠军/第N名”文案由页面拼。
type Honor struct {
	ZoneID   string `json:"zone_id"`
	SeasonID int    `json:"season_id"`
	Code     string `json:"code"`
}

// Query 是一次详情请求的作用域（由 server 从查询参数解析）。排序/快捷筛选/分页不在此——它们是页面本地操作。
type Query struct {
	ID        string
	Zone      string // ALL 或赛区代码
	Season    string // "" 或赛季数字
	Sect      string // "" 或门派基础名
	Head      bool   // 只取 stats 出头部（秒出姓名/战力/统计方块），不碰逐场；逐场首屏与全量各自独立请求
	FirstPage bool   // 只取赛区第 1 页逐场做首屏预览（恒赛区级，忽略 season/sect），与 head/全量并行、互不阻塞
}

// DetailView 是选手详情页的数据模型：聚合为数值键值，逐场为“作用域内(赛季+门派已筛)的原始行”。
type DetailView struct {
	Player PlayerInfo `json:"player"`
	Zone   string     `json:"zone"`
	Season string     `json:"season"`
	Sect   string     `json:"sect"`

	Power  json.RawMessage `json:"power"` // 原样（数字/字符串/null），页面负责 “—” 兜底
	Joined []Zone          `json:"joined"`
	Honors []Honor         `json:"honors"`
	Teams  []string        `json:"teams"`

	Comprehensive []KV         `json:"comprehensive"` // 数值键值：无门派取自接口 summary，有门派用逐场现算
	Good          []KV         `json:"good"`          // 无门派=haoren；有门派=好人子集现算（页面隐藏 htsp_num）
	Wolf          []KV         `json:"wolf"`          // 无门派=langren；有门派=狼子集现算（页面隐藏 bgx_num）
	Roles         []RoleRow    `json:"roles"`         // 默认按场次降序；页面可再排序
	Editions      []EditionRow `json:"editions"`      // 版型表现，默认按场次降序

	SeasonCands []int    `json:"season_cands"`
	SectCands   []string `json:"sect_cands"`

	Games           []json.RawMessage `json:"games"` // 作用域内原始行（赛季+门派已筛）；gf/排序/分页在页面做
	GamesTrunc      bool              `json:"games_trunc"`
	GamesTotal      int               `json:"games_total"`       // 该作用域逐场总场数（首屏预览用于“共 N 场”提示）；未知时为已拉行数
	GamesTotalKnown bool              `json:"games_total_known"` // GamesTotal 是否为确定总数（官方给了 total_items）；false=仅已拉行数、真实更多

	StatsError string `json:"stats_error"`
	GamesError string `json:"games_error"`
}

// Service 是详情服务：持有官方客户端、选手级缓存与单局缓存。
type Service struct {
	api   *huashan.Client
	store *store
	games *gameStore
}

// New 构造服务。capacity=缓存选手数上限（LRU，无时间过期）。单局缓存用默认容量。
func New(api *huashan.Client, capacity int) *Service {
	return &Service{
		api: api, store: newStore(capacity), games: newGameStore(defaultGameCacheCap),
	}
}

// CachedPlayers 返回当前缓存的选手数（供状态展示/测试）。
func (s *Service) CachedPlayers() int { return s.store.len() }

// —— 透传给传输层（server 只依赖本层；这些不涉及计算/缓存）——

// Session 返回昵称与令牌到期时间（不含令牌本身）。
func (s *Service) Session(force bool) (nick string, exp int64, reason string) {
	return s.api.Session(force)
}

// CurrentToken 仅供本机页面在用户明确要求复制时读取。
func (s *Service) CurrentToken() string { return s.api.CurrentToken() }

// SetManualToken 校验并采用手动输入的令牌；令牌不会写入磁盘。
func (s *Service) SetManualToken(raw string) (nick string, exp int64, reason string) {
	return s.api.SetManualToken(raw)
}

// Search 按名字搜选手（原始 JSON 透传）。
func (s *Service) Search(ctx context.Context, name string) ([]byte, error) {
	return s.api.SearchPlayers(ctx, name)
}

// Game 取单场牌局详情：拉原始 JSON → 解析 form2 → 结算“客观事实”(analysis) 后一并返回。
// 结算只产出数字/key（花名册/放逐/死亡序列/存活），中文与配色由页面负责。
// 解析失败(老局/异常结构)时原样返回原始 JSON，页面回退到旧渲染，不报错。
// 已分析结果按 gid 缓存：重复打开（含悬停预取）零网络、零重算；缓存无时间过期，关掉重开即最新。
func (s *Service) Game(ctx context.Context, gid string) ([]byte, error) {
	return s.games.get(ctx, gid, func(fctx context.Context) ([]byte, error) {
		raw, err := s.api.Game(fctx, gid)
		if err != nil {
			return nil, err
		}
		return withAnalysis(raw), nil
	})
}

// Detail 取选手详情视图。命中缓存则零网络；缓存只随人数上限被顶替（无时间过期）。
// 三种粒度，各自独立、互不阻塞（前端并发发起、到一个渲染一个）：
//   - Head：只取 stats 出头部（姓名/战力/统计方块秒出，不碰逐场）；
//   - FirstPage：只取赛区第 1 页逐场做首屏预览（恒赛区级，忽略 season/sect）；
//   - 全量(默认)：拉全逐场 + 角色/候选/门派聚合（第 1 页复用 FirstPage 的 gp1 缓存，不重复拉）。
//
// 如此重度选手（逐场上万场）打开时头部不被逐场拖住，逐场首屏也能先于全量出现。
func (s *Service) Detail(ctx context.Context, q Query) (*DetailView, error) {
	if q.Zone == "" {
		q.Zone = "ALL"
	}
	if q.FirstPage { // 首屏预览：赛区级第 1 页，独立于 stats（不阻塞头部）；忽略赛季/门派——预览恒为赛区级“最近对局”
		fp, err := s.fetchFirstPage(ctx, q.ID, q.Zone)
		if err != nil {
			return nil, err
		}
		known := fp.total >= 0
		total := fp.total
		if !known { // 官方缺 total_items：用已拉到的行数兜底并标记“非确定总数”，前端据此显示“已显示前 N 场”而非谎报“共 N 场”
			total = len(fp.raw)
		}
		return &DetailView{Player: PlayerInfo{ID: q.ID}, Zone: q.Zone, Teams: []string{}, Games: fp.raw, GamesTotal: total, GamesTotalKnown: known}, nil
	}
	p := s.store.player(q.ID)

	var (
		sd                 *statsData
		idx                *gameIndex
		statsErr, gamesErr error
		wg                 sync.WaitGroup
	)
	wg.Add(1)
	go func() {
		defer wg.Done()
		v, e := p.getSub(ctx, "stats|"+q.Zone+"|"+q.Season, func(fctx context.Context) (any, error) {
			return s.fetchStats(fctx, q.ID, q.Zone, q.Season)
		})
		if e != nil {
			statsErr = e
		} else {
			sd = v.(*statsData)
		}
	}()
	if !q.Head { // 头部阶段只取 stats；完整阶段并发拉取全量逐场索引（第 1 页复用 gp1 缓存）
		wg.Add(1)
		go func() {
			defer wg.Done()
			v, e := p.getSub(ctx, "games|"+q.Zone, func(fctx context.Context) (any, error) {
				return s.fetchIndex(fctx, q.ID, q.Zone)
			})
			if e != nil {
				gamesErr = e
			} else {
				idx = v.(*gameIndex)
			}
		}()
	}
	wg.Wait()
	// 逐场是在 player() 之后才拉取写入缓存的：此刻按最新总量重查一次预算，避免并发拉取完成后持续超预算。
	s.store.enforceBudgetNow(p)

	if q.Head { // 头部阶段：只回 stats 头部；stats 失败才上抛（401 交前端弹横幅）
		if statsErr != nil {
			return nil, statsErr
		}
		return s.build(q, sd, nil, nil, nil), nil
	}
	if statsErr != nil && gamesErr != nil { // 全失败：上抛（401 优先，便于前端弹令牌横幅）
		if is401(statsErr) {
			return nil, statsErr
		}
		if is401(gamesErr) {
			return nil, gamesErr
		}
		return nil, statsErr
	}
	return s.build(q, sd, idx, statsErr, gamesErr), nil
}

func is401(err error) bool {
	ae, ok := err.(*huashan.APIError)
	return ok && ae.Status == 401
}

// ErrorStatus 把错误映射为“建议的 HTTP 状态 + 消息”，供 server 回给页面（server 只依赖本层）。
func ErrorStatus(err error) (int, string) {
	if ae, ok := err.(*huashan.APIError); ok && ae.Status != 0 {
		return ae.Status, ae.Message
	}
	return http.StatusBadGateway, err.Error()
}

// firstPage 是某赛区逐场的第 1 页（原始行 + 该作用域总场数）。头部阶段用它出首屏；完整阶段的 fetchIndex 复用它，
// 故第 1 页每赛区只真正拉一次。
type firstPage struct {
	raw   []json.RawMessage
	total int
}

// fetchFirstPage 取某赛区逐场第 1 页（经 gp1|zone 子键缓存，供头部阶段与完整阶段复用，不重复拉）。
// 拉到后即逐行解析校验：任一行非法(截断/字段异常)即返回错误、不入缓存——避免把残缺首页当有效数据长期缓存，
// 也保证头部阶段的首屏预览行都是可渲染的；瞬时损坏可经重试重新拉取。
func (s *Service) fetchFirstPage(ctx context.Context, id, zone string) (*firstPage, error) {
	p := s.store.player(id)
	v, err := p.getSub(ctx, "gp1|"+zone, func(fctx context.Context) (any, error) {
		items, total, e := s.api.GamesFirstPage(fctx, id, zone)
		if e != nil {
			return nil, e
		}
		for _, r := range items {
			if _, e := parseGame(r); e != nil {
				return nil, &huashan.APIError{Status: http.StatusBadGateway, Message: "战绩数据解析失败：" + e.Error()}
			}
		}
		return &firstPage{raw: items, total: total}, nil
	})
	if err != nil {
		return nil, err
	}
	return v.(*firstPage), nil
}

// fetchIndex 拉取并解析某赛区全部逐场战绩，建立内存索引（解析结果与原始 JSON 对齐）。
// 第 1 页复用 gp1|zone 缓存（头部阶段通常已拉过），其余页经 GamesRest 补齐——每页只拉一次。
// 任一场解析失败（非法/截断 JSON）即返回错误，绝不缓存残缺数据、也不让空场次参与聚合。
func (s *Service) fetchIndex(ctx context.Context, id, zone string) (any, error) {
	fp, err := s.fetchFirstPage(ctx, id, zone)
	if err != nil {
		return nil, err
	}
	items, trunc, err := s.api.GamesRest(ctx, id, zone, fp.raw, fp.total)
	if err != nil {
		return nil, err
	}
	gi := &gameIndex{raw: items, trunc: trunc, games: make([]Game, len(items))}
	for i, r := range items {
		g, err := parseGame(r)
		if err != nil {
			return nil, &huashan.APIError{Status: http.StatusBadGateway, Message: "战绩数据解析失败：" + err.Error()}
		}
		gi.games[i] = g
	}
	return gi, nil
}

// ZoneGames 返回选手在某赛区已解析的逐场（跨赛区用 zone=ALL）。供上层赛事聚合(event 包)复用选手详情
// 同一份 LRU/内存预算缓存：门派成员统计、归属补查等按选手+赛区读取时，已拉过的逐场零网络复用，
// 且与选手详情共享同一条内存预算线（拉取后即结算预算），不各自无界累积。
func (s *Service) ZoneGames(ctx context.Context, id, zone string) ([]Game, error) {
	p := s.store.player(id)
	v, err := p.getSub(ctx, "games|"+zone, func(fctx context.Context) (any, error) {
		return s.fetchIndex(fctx, id, zone)
	})
	if err != nil {
		return nil, err
	}
	s.store.enforceBudgetNow(p)
	return v.(*gameIndex).games, nil
}

// fetchStats 拉取并解析选手统计；解析成功才返回、才会被缓存——避免残缺 JSON 被当空数据长期缓存。
func (s *Service) fetchStats(ctx context.Context, id, zone, season string) (any, error) {
	body, err := s.api.PlayerStats(ctx, id, zone, season)
	if err != nil {
		return nil, err
	}
	var sd statsData
	if err := json.Unmarshal(body, &sd); err != nil {
		return nil, &huashan.APIError{Status: http.StatusBadGateway, Message: "统计数据解析失败：" + err.Error()}
	}
	return &sd, nil
}

// statsData 是从 stats 接口解出的选手级信息（跨赛区一致部分 + 各阵营统计原始 JSON）。
type statsData struct {
	Player struct {
		Name   string `json:"name"`
		Avatar string `json:"avatar"`
	} `json:"player"`
	Joined []Zone `json:"joined_zone_ids"`
	Honors []struct {
		ZoneID   string          `json:"zone_id"`
		SeasonID int             `json:"season_id"`
		Code     json.RawMessage `json:"code"`
	} `json:"honors"`
	Summary json.RawMessage `json:"summary"`
	Haoren  json.RawMessage `json:"haoren"`
	Langren json.RawMessage `json:"langren"`
	Power   json.RawMessage `json:"power"`
}

func (s *Service) build(q Query, sd *statsData, idx *gameIndex, statsErr, gamesErr error) *DetailView {
	if sd == nil { // 统计失败：用占位，避免各处判空
		sd = &statsData{}
	}
	var games []Game
	var raw []json.RawMessage
	trunc := false
	if idx != nil {
		games, raw, trunc = idx.games, idx.raw, idx.trunc
	}

	v := &DetailView{
		Player:     PlayerInfo{ID: q.ID, Name: sd.Player.Name, Avatar: sd.Player.Avatar},
		Zone:       q.Zone,
		Season:     q.Season,
		Sect:       q.Sect,
		Power:      sd.Power,
		Joined:     sd.Joined,
		Teams:      []string{},
		Games:      []json.RawMessage{},
		GamesTrunc: trunc,
	}
	if statsErr != nil {
		v.StatsError = statsErr.Error()
	}
	if gamesErr != nil {
		v.GamesError = gamesErr.Error()
	}

	// 荣誉：仅按赛区/赛季过滤，原样给出代码/名次码（中文名与文案在页面拼）
	for _, h := range sd.Honors {
		if (q.Zone == "ALL" || h.ZoneID == q.Zone) && (q.Season == "" || strconv.Itoa(h.SeasonID) == q.Season) {
			v.Honors = append(v.Honors, Honor{ZoneID: h.ZoneID, SeasonID: h.SeasonID, Code: unquote(h.Code)})
		}
	}

	// 作用域：按赛季 + 门派过滤出 dg（逐场表的 gf/排序/分页留给页面）
	dg := filterIdx(games, allIdx(len(games)), func(g Game) bool {
		return matchSeason(g, q.Season) && (q.Sect == "" || g.SectBase == q.Sect)
	})

	// 候选：赛季随门派联动、门派随赛季联动
	seasonSrc := allIdx(len(games))
	if q.Sect != "" {
		seasonSrc = filterIdx(games, seasonSrc, func(g Game) bool { return g.SectBase == q.Sect })
	}
	v.SeasonCands = seasonCandidates(games, seasonSrc, q.Season)
	sectSrc := allIdx(len(games))
	if q.Season != "" {
		sectSrc = filterIdx(games, sectSrc, func(g Game) bool { return matchSeason(g, q.Season) })
	}
	v.SectCands = sectCandidates(games, sectSrc, q.Sect)

	// 队伍名 chips（选门派时只留同名门派的各赛区变体，保留首见顺序）
	chipSrc := allIdx(len(games))
	if q.Sect != "" {
		chipSrc = filterIdx(games, chipSrc, func(g Game) bool { return g.SectBase == q.Sect })
	}
	if teams := uniqStr(mapStr(games, chipSrc, func(g Game) string { return g.SectRaw })); teams != nil {
		v.Teams = teams
	}

	// 聚合方块（数值键值）：有门派用逐场现算三档；无门派取接口富字段
	if q.Sect != "" {
		if gamesErr == nil {
			good := filterIdx(games, dg, func(g Game) bool { return g.Good })
			wolf := filterIdx(games, dg, func(g Game) bool { return !g.Good })
			v.Comprehensive = aggregate(games, dg).kv()
			v.Good = aggregate(games, good).kv()
			v.Wolf = aggregate(games, wolf).kv()
		}
	} else if statsErr == nil {
		v.Comprehensive = orderedKV(sd.Summary)
		v.Good = orderedKV(sd.Haoren)
		v.Wolf = orderedKV(sd.Langren)
	}

	// 角色表现（默认场次降序；页面可再排序）
	v.Roles = roleBreakdown(games, dg)
	v.Editions = editionBreakdown(games, dg)

	// 作用域内原始逐场行（页面做 gf/排序/分页）
	rows := make([]json.RawMessage, 0, len(dg))
	for _, i := range dg {
		rows = append(rows, raw[i])
	}
	if len(rows) > 0 {
		v.Games = rows
	}
	v.GamesTotal = len(dg)
	// 索引存在且未截断（无缺页、未触安全上限）时，GamesTotal 即作用域内确切总数；否则视为不确定。
	// 头部阶段(idx==nil，未拉逐场)也保持 false——不声称一个并未统计出的总数。
	v.GamesTotalKnown = idx != nil && !trunc
	return v
}

// —— 组装辅助 ——

func allIdx(n int) []int {
	idx := make([]int, n)
	for i := range idx {
		idx[i] = i
	}
	return idx
}

func filterIdx(games []Game, in []int, pred func(Game) bool) []int {
	out := make([]int, 0, len(in))
	for _, i := range in {
		if pred(games[i]) {
			out = append(out, i)
		}
	}
	return out
}

func mapStr(games []Game, in []int, f func(Game) string) []string {
	out := make([]string, 0, len(in))
	for _, i := range in {
		out = append(out, f(games[i]))
	}
	return out
}

func matchSeason(g Game, season string) bool {
	if season == "" {
		return true
	}
	return g.HasSeason && strconv.Itoa(g.SeasonID) == season
}

func seasonCandidates(games []Game, in []int, cur string) []int {
	seen := map[int]bool{}
	var out []int
	for _, i := range in {
		if g := games[i]; g.HasSeason && !seen[g.SeasonID] {
			seen[g.SeasonID] = true
			out = append(out, g.SeasonID)
		}
	}
	sort.Sort(sort.Reverse(sort.IntSlice(out))) // 赛季降序
	if cur != "" {
		if n, err := strconv.Atoi(cur); err == nil && !seen[n] {
			out = append([]int{n}, out...) // 保留当前选择
		}
	}
	return out
}

func sectCandidates(games []Game, in []int, cur string) []string {
	out := uniqStr(mapStr(games, in, func(g Game) string { return g.SectBase }))
	sort.Strings(out)
	if cur != "" {
		for _, s := range out {
			if s == cur {
				return out
			}
		}
		out = append([]string{cur}, out...)
	}
	return out
}

// unquote 把名次码原样取成字符串（数字或字符串都可）。
func unquote(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var n json.Number
	if json.Unmarshal(raw, &n) == nil {
		return n.String()
	}
	return ""
}
