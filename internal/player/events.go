package player

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"sort"
	"strconv"
	"sync"

	"huashanquery/internal/huashan"
	"huashanquery/internal/logx"
)

const (
	eventPageSize = 500
	// eventMetricPageSize 用大页拉选手汇总：官方 /stats/players/games 返回裸数组、无 total_items，
	// 分页只能靠“短页即末页”判断；单赛区选手多为数百人，500/页通常一次拉完，把翻页从 ~4 次降到 1 次。
	eventMetricPageSize = 500
	eventMaxPages       = 20
)

// EventOption 是赛事资料里的一个官方选项。Value 始终转成字符串，兼容官方字典混用数字和字符串。
type EventOption struct {
	Value    string `json:"value"`
	Label    string `json:"label"`
	Ordering int    `json:"ordering,omitempty"`
	Camp     int    `json:"camp,omitempty"`
}

// EventCatalog 汇总赛事筛选与牌局资料字典。
type EventCatalog struct {
	Seasons     []EventOption `json:"seasons"`
	SeasonTypes []EventOption `json:"season_types"`
	Zones       []EventOption `json:"zones"`
	Editions    []EventOption `json:"editions"`
	Roles       []EventOption `json:"roles"`
}

// EventAvailability 是当前赛季和赛区下，实际存在门派排名数据的可选范围。
type EventAvailability struct {
	Seasons     []EventOption `json:"seasons"`
	SeasonTypes []EventOption `json:"season_types"`
	Zones       []EventOption `json:"zones"`
}

// EventSeasonRange 是一个赛区实际存在排名数据的赛季范围。
type EventSeasonRange struct {
	Zone    string        `json:"zone"`
	Seasons []EventOption `json:"seasons"`
}

// SectRank 是指定赛事范围内的一支门派及其官方汇总。
type SectRank struct {
	Rank       int     `json:"rank"`
	SectID     int     `json:"sect_id"`
	SectName   string  `json:"sect_name"`
	TotalPoint float64 `json:"total_point"`
	Days       int     `json:"days,omitempty"`
	Games      int     `json:"games,omitempty"`
	Avg        float64 `json:"avg,omitempty"`
	MVP        int     `json:"mvp"`
	SVP        int     `json:"svp"`
	BGX        int     `json:"bgx"`
}

// EventRankings 是赛事范围与门派排名结果。
type EventRankings struct {
	Season           string     `json:"season"`
	SeasonType       string     `json:"season_type"`
	Zone             string     `json:"zone"`
	MetricMode       string     `json:"metric_mode"`
	Items            []SectRank `json:"items"`
	MetricsAvailable bool       `json:"metrics_available"`
	MetricsNote      string     `json:"metrics_note,omitempty"`
}

// EventRankMetricPage 是一页选手轮次对各门派的增量贡献；前端拉到末页后再统一计算均分。
type EventRankMetricPage struct {
	Page       int                    `json:"page"`
	TotalPages int                    `json:"total_pages,omitempty"`
	HasMore    bool                   `json:"has_more"`
	Items      []EventRankMetricRound `json:"items"`
	players    []eventPlayerAggregate
}

type EventRankMetricRound struct {
	SectID int `json:"sect_id"`
	Rounds int `json:"rounds"`
}

// EventRankMetrics 是一个赛事范围内各门派的参赛量与均分，按 sect_id 关联到排名。
// 由 Go 统一聚合所有选手轮次分页并按赛制换算（常规赛 3 局=1 天，其余按局数）——页面只做关联展示，
// 不在前端累加或套用换算规则（换算规则是领域逻辑，归 player 层）。
type EventRankMetrics struct {
	MetricMode        string            `json:"metric_mode"`
	MetricsAvailable  bool              `json:"metrics_available"`
	MetricsIncomplete bool              `json:"metrics_incomplete,omitempty"`
	Items             []EventSectMetric `json:"items"`
}

// EventSectMetric 是单支门派的参赛量与均分；按赛制只填 Days 或 Games 之一。
type EventSectMetric struct {
	SectID int     `json:"sect_id"`
	Days   int     `json:"days,omitempty"`
	Games  int     `json:"games,omitempty"`
	Avg    float64 `json:"avg,omitempty"`
}

// TeamView 只暴露队伍资料与成员名单，不透传选手手机号等无关隐私字段。
type TeamView struct {
	ID         int           `json:"id"`
	Name       string        `json:"name"`
	Chief      string        `json:"chief,omitempty"`
	CreatedAt  string        `json:"created_at,omitempty"`
	UpdatedAt  string        `json:"updated_at,omitempty"`
	Season     string        `json:"season"`
	SeasonType string        `json:"season_type"`
	Zone       string        `json:"zone"`
	Members    []EventMember `json:"members"`
	Incomplete bool          `json:"incomplete,omitempty"`
}

// EventMember 是在所选赛事范围内有该门派出场记录的成员。
type EventMember struct {
	Value      string  `json:"value"`
	Label      string  `json:"label"`
	Matches    int     `json:"matches"`
	TotalPoint float64 `json:"total_point"`
	Avg        float64 `json:"avg"`
	Win        int     `json:"win"`
	MVP        int     `json:"mvp"`
	SVP        int     `json:"svp"`
	BGX        int     `json:"bgx"`
}

var eventZones = []EventOption{
	{Value: "SH", Label: "上海赛区"}, {Value: "BJ", Label: "北京赛区"},
	{Value: "HSXM", Label: "厦门赛区"}, {Value: "HSGZ", Label: "广州赛区"},
	{Value: "HSHZ", Label: "杭州赛区"}, {Value: "SD", Label: "山东赛区"},
	{Value: "WH", Label: "武汉赛区"}, {Value: "CQ", Label: "重庆赛区"},
	{Value: "NJ", Label: "南京赛区"}, {Value: "HF", Label: "安徽赛区"},
	{Value: "CS", Label: "长沙赛区"}, {Value: "XA", Label: "西安赛区"},
	{Value: "NC", Label: "南昌赛区"}, {Value: "RANK", Label: "杭州 Rank"},
	{Value: "HSYXS", Label: "华山英雄赛"}, {Value: "HZYC", Label: "杭州羊村英雄赛"},
	{Value: "GZHSYXS", Label: "广州华山英雄赛"}, {Value: "HZHSYXS", Label: "杭州英雄赛"},
	{Value: "HSGRS", Label: "华山个人赛"}, {Value: "SDGRS", Label: "山东个人赛"},
}

// EventSeasonsForZone 用每季一条的小请求确定该赛区实际可选的赛季，并缓存探测结果。
func (s *Service) EventSeasonsForZone(ctx context.Context, zone string) (*EventSeasonRange, error) {
	catalog, err := s.EventsCatalog(ctx)
	if err != nil {
		return nil, err
	}
	if zone == "" {
		zone = "SH"
	}
	if !eventOptionExists(catalog.Zones, zone) {
		return nil, &huashan.APIError{Status: http.StatusBadRequest, Message: "请选择有效的赛区"}
	}
	probes := make(map[string]eventProbe, len(catalog.Seasons))
	for _, option := range catalog.Seasons {
		probe := eventProbe{season: option.Value, zone: zone}
		probes[eventProbeKey(probe)] = probe
	}
	available, err := s.resolveEventAvailability(ctx, probes)
	if err != nil {
		return nil, err
	}
	seasons := make([]EventOption, 0, len(catalog.Seasons))
	for _, option := range catalog.Seasons {
		if available[eventProbeKey(eventProbe{season: option.Value, zone: zone})] {
			seasons = append(seasons, option)
		}
	}
	return &EventSeasonRange{Zone: zone, Seasons: seasons}, nil
}

// EventSeasonTypesForScope 只探测指定赛区+赛季实际有数据的比赛类型，供筛选器的“比赛类型”下拉按需刷新。
// 与 EventAvailability 不同，这里不连带探测其它赛区/赛季——避免为了一个下拉多发约 20 个无关请求、
// 也避免任一无关赛区探测失败把整个比赛类型下拉一起拖垮。探测结果按组合缓存，复用 EventAvailability 的缓存池。
func (s *Service) EventSeasonTypesForScope(ctx context.Context, season, zone string) ([]EventOption, error) {
	catalog, err := s.EventsCatalog(ctx)
	if err != nil {
		return nil, err
	}
	if !eventOptionExists(catalog.Seasons, season) {
		return nil, &huashan.APIError{Status: http.StatusBadRequest, Message: "请选择有效的赛季"}
	}
	if zone == "" {
		zone = "SH"
	}
	if !eventOptionExists(catalog.Zones, zone) {
		return nil, &huashan.APIError{Status: http.StatusBadRequest, Message: "请选择有效的赛区"}
	}
	probes := make(map[string]eventProbe, len(catalog.SeasonTypes))
	for _, option := range catalog.SeasonTypes {
		probe := eventProbe{season: season, seasonType: option.Value, zone: zone}
		probes[eventProbeKey(probe)] = probe
	}
	available, err := s.resolveEventAvailability(ctx, probes)
	if err != nil {
		return nil, err
	}
	types := make([]EventOption, 0, len(catalog.SeasonTypes))
	for _, option := range catalog.SeasonTypes {
		if available[eventProbeKey(eventProbe{season: season, seasonType: option.Value, zone: zone})] {
			types = append(types, option)
		}
	}
	return types, nil
}

// EventsCatalog 只读取排名筛选立即需要的赛季和比赛类型；版型与身份留到需要牌局资料时再取。
func (s *Service) EventsCatalog(ctx context.Context) (*EventCatalog, error) {
	s.eventMu.Lock()
	if s.eventCatalog != nil {
		v := s.eventCatalog
		s.eventMu.Unlock()
		return v, nil
	}
	s.eventMu.Unlock()

	var bodies [2][]byte
	var errs [2]error
	fetches := []func(context.Context) ([]byte, error){s.api.EventSeasons, s.api.EventSeasonTypes}
	var wg sync.WaitGroup
	for i, fetch := range fetches {
		wg.Add(1)
		go func(i int, fetch func(context.Context) ([]byte, error)) {
			defer wg.Done()
			bodies[i], errs[i] = fetch(ctx)
		}(i, fetch)
	}
	wg.Wait()
	for _, err := range errs {
		if err != nil {
			return nil, err
		}
	}

	seasons, err := decodeEventOptions(bodies[0], "text")
	if err != nil {
		return nil, eventDecodeError(err)
	}
	types, err := decodeEventOptions(bodies[1], "text")
	if err != nil {
		return nil, eventDecodeError(err)
	}
	v := &EventCatalog{Seasons: seasons, SeasonTypes: types, Zones: eventZones, Editions: []EventOption{}, Roles: []EventOption{}}
	s.eventMu.Lock()
	if s.eventCatalog == nil {
		s.eventCatalog = v
	} else {
		v = s.eventCatalog
	}
	s.eventMu.Unlock()
	return v, nil
}

func decodeEventOptions(body []byte, labelKey string) ([]EventOption, error) {
	var rows []map[string]json.RawMessage
	if err := json.Unmarshal(body, &rows); err != nil {
		return nil, err
	}
	out := make([]EventOption, 0, len(rows))
	for _, row := range rows {
		var deleted bool
		_ = json.Unmarshal(row["deleted"], &deleted)
		if deleted {
			continue
		}
		label := rawString(row[labelKey])
		value := rawString(row["value"])
		if label == "" || value == "" {
			continue
		}
		var ordering, camp int
		_ = json.Unmarshal(row["ordering"], &ordering)
		_ = json.Unmarshal(row["camp"], &camp)
		out = append(out, EventOption{Value: value, Label: label, Ordering: ordering, Camp: camp})
	}
	return out, nil
}

func rawString(raw json.RawMessage) string {
	if len(raw) == 0 || string(raw) == "null" {
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

type eventProbe struct {
	season, seasonType, zone string
}

// EventAvailability 用小页请求核对真实数据范围；结果按组合缓存到程序退出，避免切换筛选时重复探测。
func (s *Service) EventAvailability(ctx context.Context, season, zone string) (*EventAvailability, error) {
	catalog, err := s.EventsCatalog(ctx)
	if err != nil {
		return nil, err
	}
	if !eventOptionExists(catalog.Seasons, season) {
		return nil, &huashan.APIError{Status: http.StatusBadRequest, Message: "请选择有效的赛季"}
	}
	if zone == "" {
		zone = "SH"
	}
	if !eventOptionExists(catalog.Zones, zone) {
		return nil, &huashan.APIError{Status: http.StatusBadRequest, Message: "请选择有效的赛区"}
	}

	probes := make(map[string]eventProbe)
	add := func(p eventProbe) { probes[eventProbeKey(p)] = p }
	for _, option := range catalog.Seasons {
		add(eventProbe{season: option.Value, zone: zone})
	}
	for _, option := range catalog.Zones {
		add(eventProbe{season: season, zone: option.Value})
	}
	for _, option := range catalog.SeasonTypes {
		add(eventProbe{season: season, seasonType: option.Value, zone: zone})
	}

	available, err := s.resolveEventAvailability(ctx, probes)
	if err != nil {
		return nil, err
	}

	filter := func(options []EventOption, probe func(EventOption) eventProbe) []EventOption {
		out := make([]EventOption, 0, len(options))
		for _, option := range options {
			if available[eventProbeKey(probe(option))] {
				out = append(out, option)
			}
		}
		return out
	}
	return &EventAvailability{
		Seasons: filter(catalog.Seasons, func(option EventOption) eventProbe {
			return eventProbe{season: option.Value, zone: zone}
		}),
		Zones: filter(catalog.Zones, func(option EventOption) eventProbe {
			return eventProbe{season: season, zone: option.Value}
		}),
		SeasonTypes: filter(catalog.SeasonTypes, func(option EventOption) eventProbe {
			return eventProbe{season: season, seasonType: option.Value, zone: zone}
		}),
	}, nil
}

func (s *Service) resolveEventAvailability(ctx context.Context, probes map[string]eventProbe) (map[string]bool, error) {
	available := make(map[string]bool, len(probes))
	missing := make([]eventProbe, 0, len(probes))
	s.eventMu.Lock()
	for key, probe := range probes {
		if value, ok := s.eventAvailability[key]; ok {
			available[key] = value
		} else {
			missing = append(missing, probe)
		}
	}
	s.eventMu.Unlock()

	if len(missing) > 0 {
		jobs := make(chan eventProbe, len(missing))
		type probeResult struct {
			probe eventProbe
			has   bool
			err   error
		}
		results := make(chan probeResult, len(missing))
		for _, probe := range missing {
			jobs <- probe
		}
		close(jobs)
		var workers sync.WaitGroup
		for range min(6, len(missing)) {
			workers.Add(1)
			go func() {
				defer workers.Done()
				for probe := range jobs {
					has, probeErr := s.probeEventAvailability(ctx, probe)
					results <- probeResult{probe: probe, has: has, err: probeErr}
				}
			}()
		}
		workers.Wait()
		close(results)
		var firstErr error
		for result := range results {
			if result.err != nil {
				if firstErr == nil {
					firstErr = result.err
				}
				continue
			}
			key := eventProbeKey(result.probe)
			available[key] = result.has
			s.eventMu.Lock()
			s.eventAvailability[key] = result.has
			s.eventMu.Unlock()
		}
		if firstErr != nil {
			return nil, firstErr
		}
	}
	return available, nil
}

func eventOptionExists(options []EventOption, value string) bool {
	for _, option := range options {
		if option.Value == value {
			return true
		}
	}
	return false
}

func eventProbeKey(probe eventProbe) string {
	return probe.season + "|" + probe.seasonType + "|" + probe.zone
}

func (s *Service) probeEventAvailability(ctx context.Context, probe eventProbe) (bool, error) {
	body, err := s.api.SectStats(ctx, probe.season, probe.seasonType, probe.zone, 1, 1)
	if err != nil {
		return false, err
	}
	var data struct {
		Items      []json.RawMessage `json:"items"`
		TotalItems *int              `json:"total_items"`
	}
	if err := json.Unmarshal(body, &data); err != nil {
		return false, eventDecodeError(err)
	}
	return len(data.Items) > 0 || (data.TotalItems != nil && *data.TotalItems > 0), nil
}

// EventTeam 返回门派资料，以及在指定赛区、赛季和比赛类型内有该门派出场记录的成员。
func (s *Service) EventTeam(ctx context.Context, id, season, seasonType, zone string) (*TeamView, error) {
	if !positiveNumber(id) {
		return nil, &huashan.APIError{Status: http.StatusBadRequest, Message: "请选择有效的门派"}
	}
	if !positiveNumber(season) {
		return nil, &huashan.APIError{Status: http.StatusBadRequest, Message: "请选择赛季"}
	}
	if seasonType != "" && !positiveNumber(seasonType) {
		return nil, &huashan.APIError{Status: http.StatusBadRequest, Message: "请选择有效的比赛类型"}
	}
	if zone == "" {
		zone = "SH"
	}
	if !eventOptionExists(eventZones, zone) {
		return nil, &huashan.APIError{Status: http.StatusBadRequest, Message: "请选择有效的赛区"}
	}
	teamID, _ := strconv.Atoi(id)
	var detailBody, membersBody []byte
	var detailErr, membersErr error
	var candidates map[string]string
	var rankSectName string
	var candidatesErr error
	var wg sync.WaitGroup
	wg.Add(3)
	go func() { defer wg.Done(); detailBody, detailErr = s.api.Team(ctx, id) }()
	go func() { defer wg.Done(); membersBody, membersErr = s.api.TeamMembers(ctx, id) }()
	go func() {
		defer wg.Done()
		candidates, rankSectName, candidatesErr = s.eventTeamCandidates(ctx, season, seasonType, zone, teamID)
	}()
	wg.Wait()
	if candidatesErr != nil {
		return nil, candidatesErr
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	team := &TeamView{
		ID: teamID, Name: rankSectName,
		Season: season, SeasonType: seasonType, Zone: zone, Members: []EventMember{},
	}
	if detailErr != nil {
		logx.Errorf("event team %d: optional team detail unavailable (%T)", teamID, detailErr)
	} else {
		var detail map[string]any
		if err := json.Unmarshal(detailBody, &detail); err != nil {
			logx.Errorf("event team %d: optional team detail contains invalid JSON: %v", teamID, err)
		} else {
			if name := stringValue(detail["name"]); name != "" {
				team.Name = name
			}
			team.Chief = chiefName(detail["chief"])
			team.CreatedAt = firstString(detail, "createTime", "create_time")
			team.UpdatedAt = firstString(detail, "updateTime", "update_time")
		}
	}

	var roster []EventOption
	if membersErr != nil {
		logx.Errorf("event team %d: optional current roster unavailable (%T)", teamID, membersErr)
	} else {
		var err error
		roster, err = decodeEventOptions(membersBody, "label")
		if err != nil {
			logx.Errorf("event team %d: optional current roster contains invalid JSON: %v", teamID, err)
			roster = nil
		}
	}

	// The settings endpoint only contains current members. Build the candidate
	// list from the scoped event aggregate so historical members who later left
	// or transferred are still included; use the current roster only to enrich
	// labels where possible.
	for _, member := range roster {
		if _, ok := candidates[member.Value]; ok && member.Label != "" {
			candidates[member.Value] = member.Label
		}
	}
	if len(candidates) == 0 {
		return team, nil
	}
	roster = make([]EventOption, 0, len(candidates))
	for value, label := range candidates {
		if label == "" {
			label = "#" + value
		}
		roster = append(roster, EventOption{Value: value, Label: label})
	}
	sort.Slice(roster, func(i, j int) bool { return roster[i].Value < roster[j].Value })

	// 出场统计按门派基名回连（逐场行只带门派名、无 sect_id）。接受两种来源的名字：门派资料名 team.Name
	// 与排名榜的门派名 rankSectName——二者偶有出入（如资料名带"俱乐部"后缀），只认其一会导致全员匹配 0 场、
	// 名单被静默清空。收成基名集合后按集合判断，任一命中即计入。
	wantSect := map[string]bool{}
	for _, n := range []string{baseName(team.Name), baseName(rankSectName)} {
		if n != "" {
			wantSect[n] = true
		}
	}

	seasonID, _ := strconv.Atoi(season)
	typeID, _ := strconv.Atoi(seasonType)
	jobs := make(chan EventOption)
	results := make(chan EventMember, len(roster))
	var incomplete bool
	var firstFetchErr error
	checked := 0
	var resultMu sync.Mutex
	workerCount := min(8, len(roster))
	var workers sync.WaitGroup
	for range workerCount {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for member := range jobs {
				p := s.store.player(member.Value)
				v, fetchErr := p.getSub(ctx, "games|"+zone, func(fctx context.Context) (any, error) {
					return s.fetchIndex(fctx, member.Value, zone)
				})
				if fetchErr != nil {
					resultMu.Lock()
					incomplete = true
					if firstFetchErr == nil {
						firstFetchErr = fetchErr
					}
					resultMu.Unlock()
					continue
				}
				resultMu.Lock()
				checked++
				resultMu.Unlock()
				s.store.enforceBudgetNow(p)
				var matches, wins, mvp, svp, bgx int
				var totalPoint float64
				for _, game := range v.(*gameIndex).games {
					if game.HasSeason && game.SeasonID == seasonID && game.SectBase != "" && wantSect[game.SectBase] &&
						(typeID == 0 || game.SeasonTypeID == typeID) {
						matches++
						totalPoint += game.Point
						if game.Win {
							wins++
						}
						if game.MVP {
							mvp++
						}
						if game.SVP {
							svp++
						}
						if game.BGX {
							bgx++
						}
					}
				}
				if matches > 0 {
					results <- EventMember{
						Value: member.Value, Label: member.Label, Matches: matches,
						TotalPoint: round2(totalPoint), Avg: round2(totalPoint / float64(matches)),
						Win: int(math.Round(float64(wins) / float64(matches) * 100)),
						MVP: mvp, SVP: svp, BGX: bgx,
					}
				}
			}
		}()
	}
	go func() {
		defer close(jobs)
		for _, member := range roster {
			select {
			case jobs <- member:
			case <-ctx.Done():
				return
			}
		}
	}()
	workers.Wait()
	close(results)
	if checked == 0 && firstFetchErr != nil {
		return nil, firstFetchErr
	}
	for member := range results {
		team.Members = append(team.Members, member)
	}
	team.Incomplete = incomplete
	// 有候选、逐场也读到了，却没人匹配上门派名——多半是门派名与逐场里的门派基名不一致（回连键失效）。
	// 记一条带上下文的日志，便于定位这类静默空名单（页面仍正常显示"暂无出场成员"）。
	if len(team.Members) == 0 && checked > 0 && len(roster) > 0 {
		keys := make([]string, 0, len(wantSect))
		for k := range wantSect {
			keys = append(keys, k)
		}
		logx.Errorf("event team %d (%q): %d candidate(s) but 0 games matched sect base names %v (per-game sect name likely differs)", teamID, team.Name, len(roster), keys)
	}
	sort.SliceStable(team.Members, func(i, j int) bool {
		if team.Members[i].TotalPoint != team.Members[j].TotalPoint {
			return team.Members[i].TotalPoint > team.Members[j].TotalPoint
		}
		if team.Members[i].Matches != team.Members[j].Matches {
			return team.Members[i].Matches > team.Members[j].Matches
		}
		return team.Members[i].Label < team.Members[j].Label
	})
	return team, nil
}

// eventTeamCandidates returns every scoped player whose membership list contains
// the selected sect. Per-game records later confirm the event-specific sect, so
// transferred historical participants remain discoverable without guessing from
// membership order.
func (s *Service) eventTeamCandidates(ctx context.Context, season, seasonType, zone string, teamID int) (map[string]string, string, error) {
	rankings, err := s.EventSectRankings(ctx, season, seasonType, zone)
	if err != nil {
		return nil, "", err
	}
	teamIndex := make(map[int]int, len(rankings.Items))
	for i, rank := range rankings.Items {
		teamIndex[rank.SectID] = i
	}
	targetIndex, exists := teamIndex[teamID]
	if !exists {
		return nil, "", &huashan.APIError{Status: http.StatusBadRequest, Message: "当前赛事中没有这个门派"}
	}
	sectName := rankings.Items[targetIndex].SectName

	candidates := make(map[string]string)
	for page := 1; page <= eventMaxPages; page++ {
		metricPage, pageErr := s.EventSectRankMetricPage(ctx, season, seasonType, zone, page)
		if pageErr != nil {
			return nil, "", pageErr
		}
		for _, player := range metricPage.players {
			if player.PlayerID <= 0 || !eventPlayerMatchesSect(teamIndex, targetIndex, player) {
				continue
			}
			id := strconv.Itoa(player.PlayerID)
			if label := player.label(); label != "" || candidates[id] == "" {
				candidates[id] = label
			}
		}
		if metricPage.TotalPages > eventMaxPages {
			return nil, "", &huashan.APIError{Status: http.StatusBadGateway, Message: "参赛成员数据过多，无法完整读取"}
		}
		if metricPage.TotalPages > 0 {
			if page >= metricPage.TotalPages {
				break
			}
		} else if !metricPage.HasMore {
			break
		}
		if page == eventMaxPages {
			return nil, "", &huashan.APIError{Status: http.StatusBadGateway, Message: "参赛成员数据过多，无法完整读取"}
		}
	}
	return candidates, sectName, nil
}

func eventPlayerMatchesSect(teamIndex map[int]int, targetIndex int, player eventPlayerAggregate) bool {
	for _, index := range eventPlayerSectIndexes(teamIndex, player) {
		if index == targetIndex {
			return true
		}
	}
	return false
}

func chiefName(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case map[string]any:
		for _, key := range []string{"name", "nickname", "label"} {
			if s := stringValue(x[key]); s != "" {
				return s
			}
		}
	}
	return ""
}

func firstString(m map[string]any, keys ...string) string {
	for _, key := range keys {
		if s := stringValue(m[key]); s != "" {
			return s
		}
	}
	return ""
}

func stringValue(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

// EventSectRankings 返回指定赛区、赛季和比赛类型下的门派排名。
func (s *Service) EventSectRankings(ctx context.Context, season, seasonType, zone string) (*EventRankings, error) {
	if !positiveNumber(season) {
		return nil, &huashan.APIError{Status: http.StatusBadRequest, Message: "请选择赛季"}
	}
	if seasonType != "" && !positiveNumber(seasonType) {
		return nil, &huashan.APIError{Status: http.StatusBadRequest, Message: "请选择有效的比赛类型"}
	}
	if zone == "" {
		zone = "SH"
	}
	if !eventOptionExists(eventZones, zone) {
		return nil, &huashan.APIError{Status: http.StatusBadRequest, Message: "请选择有效的赛区"}
	}
	cacheKey := eventProbeKey(eventProbe{season: season, seasonType: seasonType, zone: zone})
	s.eventMu.Lock()
	if cached := s.eventRankings[cacheKey]; cached != nil {
		result := cloneEventRankings(cached)
		s.eventMu.Unlock()
		return result, nil
	}
	s.eventMu.Unlock()
	var all []SectRank
	for page := 1; page <= eventMaxPages; page++ {
		body, err := s.api.SectStats(ctx, season, seasonType, zone, page, eventPageSize)
		if err != nil {
			return nil, err
		}
		var data struct {
			Items []struct {
				SectID     jsonNum `json:"sect_id"`
				SectName   string  `json:"sect_name"`
				TotalPoint jsonNum `json:"total_point"`
				MVP        jsonNum `json:"mvp"`
				SVP        jsonNum `json:"svp"`
				BGX        jsonNum `json:"bgx"`
			} `json:"items"`
			TotalItems *int `json:"total_items"`
		}
		if err := json.Unmarshal(body, &data); err != nil {
			return nil, eventDecodeError(err)
		}
		for _, item := range data.Items {
			all = append(all, SectRank{
				SectID: int(item.SectID.v), SectName: item.SectName, TotalPoint: round2(item.TotalPoint.v),
				MVP: int(math.Round(item.MVP.v)), SVP: int(math.Round(item.SVP.v)), BGX: int(math.Round(item.BGX.v)),
			})
		}
		if len(data.Items) < eventPageSize || (data.TotalItems != nil && len(all) >= *data.TotalItems) {
			break
		}
		if page == eventMaxPages {
			return nil, &huashan.APIError{Status: http.StatusBadGateway, Message: "门派排名数据过多，无法完整读取"}
		}
	}
	sort.SliceStable(all, func(i, j int) bool {
		if all[i].TotalPoint == all[j].TotalPoint {
			return all[i].SectName < all[j].SectName
		}
		return all[i].TotalPoint > all[j].TotalPoint
	})
	for i := range all {
		all[i].Rank = i + 1
	}
	result := &EventRankings{Season: season, SeasonType: seasonType, Zone: zone, MetricMode: eventMetricMode(seasonType), Items: all}
	result.MetricsNote = "参赛量和均分正在按需计算。"
	s.eventMu.Lock()
	if cached := s.eventRankings[cacheKey]; cached != nil {
		result = cloneEventRankings(cached)
	} else {
		s.eventRankings[cacheKey] = cloneEventRankings(result)
	}
	s.eventMu.Unlock()
	return result, nil
}

// EventSectRankMetricPage 每次只读取一页选手轮次，避免大赛事在单个请求内拉完整份选手汇总。
func (s *Service) EventSectRankMetricPage(ctx context.Context, season, seasonType, zone string, page int) (*EventRankMetricPage, error) {
	if zone == "" {
		zone = "SH"
	}
	if !eventOptionExists(eventZones, zone) {
		return nil, &huashan.APIError{Status: http.StatusBadRequest, Message: "请选择有效的赛区"}
	}
	if page <= 0 || page > eventMaxPages {
		return nil, &huashan.APIError{Status: http.StatusBadRequest, Message: "请选择有效的数据页"}
	}
	cacheKey := eventProbeKey(eventProbe{season: season, seasonType: seasonType, zone: zone}) + "|" + strconv.Itoa(page)
	s.eventMu.Lock()
	if cached := s.eventMetricPages[cacheKey]; cached != nil {
		result := cloneEventRankMetricPage(cached)
		s.eventMu.Unlock()
		return result, nil
	}
	s.eventMu.Unlock()
	rankings, err := s.EventSectRankings(ctx, season, seasonType, zone)
	if err != nil {
		return nil, err
	}
	players, totalPages, hasMore, err := s.eventPlayerAggregatePage(ctx, season, seasonType, zone, page)
	if err != nil {
		return nil, err
	}
	rounds, _ := eventSectRoundStats(rankings.Items, players)
	items := make([]EventRankMetricRound, 0, len(rounds))
	for i, count := range rounds {
		if count > 0 {
			items = append(items, EventRankMetricRound{SectID: rankings.Items[i].SectID, Rounds: count})
		}
	}
	result := &EventRankMetricPage{Page: page, TotalPages: totalPages, HasMore: hasMore, Items: items, players: players}
	s.eventMu.Lock()
	if cached := s.eventMetricPages[cacheKey]; cached != nil {
		result = cloneEventRankMetricPage(cached)
	} else {
		s.eventMetricPages[cacheKey] = cloneEventRankMetricPage(result)
	}
	s.eventMu.Unlock()
	return result, nil
}

func cloneEventRankMetricPage(source *EventRankMetricPage) *EventRankMetricPage {
	if source == nil {
		return nil
	}
	clone := *source
	clone.Items = append([]EventRankMetricRound(nil), source.Items...)
	clone.players = cloneEventPlayerAggregates(source.players)
	return &clone
}

// EventSectRankMetrics 聚合指定赛事范围内所有选手轮次分页，按门派归属统计局数，再套用赛制换算（day 模式 3 局=1 天、
// 向上取整，其余按局数），返回各门派的参赛量与均分。分页抓取复用 EventSectRankMetricPage 的缓存；归属歧义的选手
// 由 resolveSectRounds 补查最新一场定位真实门派。换算与归属都是领域逻辑，集中在 player 层，页面不自行累加或换算。
func (s *Service) EventSectRankMetrics(ctx context.Context, season, seasonType, zone string) (*EventRankMetrics, error) {
	rankings, err := s.EventSectRankings(ctx, season, seasonType, zone)
	if err != nil {
		return nil, err
	}
	if seasonType == "" {
		// “全部比赛类型”把常规赛、季后赛等不同赛制混在一起，天数（3 局=1 天）与场次没有统一分母，
		// 强行相加/相除会得出错误的参赛量与均分——此范围下不计算派生指标，仅保留门派总分排名。
		return &EventRankMetrics{MetricMode: rankings.MetricMode, MetricsAvailable: false, Items: []EventSectMetric{}}, nil
	}
	var players []eventPlayerAggregate
	for page := 1; page <= eventMaxPages; page++ {
		metricPage, pageErr := s.EventSectRankMetricPage(ctx, season, seasonType, zone, page)
		if pageErr != nil {
			return nil, pageErr
		}
		players = append(players, metricPage.players...)
		if metricPage.TotalPages > eventMaxPages {
			return nil, &huashan.APIError{Status: http.StatusBadGateway, Message: "参赛轮次数据过多，无法完整读取"}
		}
		if metricPage.TotalPages > 0 {
			if page >= metricPage.TotalPages {
				break
			}
		} else if !metricPage.HasMore {
			break
		}
		if page == eventMaxPages {
			return nil, &huashan.APIError{Status: http.StatusBadGateway, Message: "参赛轮次数据过多，无法完整读取"}
		}
	}
	ranks := append([]SectRank(nil), rankings.Items...) // 归属就地写 Days/Games/Avg，拷贝一份避免动到调用方的排名
	rounds, incomplete, err := s.resolveSectRounds(ctx, ranks, players, season, zone)
	if err != nil {
		return nil, err
	}
	available := enrichFromRounds(ranks, rounds, rankings.MetricMode)
	items := make([]EventSectMetric, 0, len(ranks))
	for _, r := range ranks {
		if r.Days == 0 && r.Games == 0 {
			continue
		}
		items = append(items, EventSectMetric{SectID: r.SectID, Days: r.Days, Games: r.Games, Avg: r.Avg})
	}
	return &EventRankMetrics{MetricMode: rankings.MetricMode, MetricsAvailable: available, MetricsIncomplete: incomplete, Items: items}, nil
}

func cloneEventPlayerAggregates(source []eventPlayerAggregate) []eventPlayerAggregate {
	clone := append([]eventPlayerAggregate(nil), source...)
	for i := range clone {
		clone[i].Sects = append(clone[i].Sects[:0:0], source[i].Sects...)
	}
	return clone
}

func eventMetricMode(seasonType string) string {
	if seasonType == "2" || seasonType == "3" {
		return "day"
	}
	return "game"
}

func cloneEventRankings(source *EventRankings) *EventRankings {
	if source == nil {
		return nil
	}
	clone := *source
	clone.Items = append([]SectRank(nil), source.Items...)
	return &clone
}

func positiveNumber(s string) bool {
	if s == "" {
		return false
	}
	n, err := strconv.Atoi(s)
	return err == nil && n > 0
}

func eventDecodeError(err error) error {
	return &huashan.APIError{Status: http.StatusBadGateway, Message: fmt.Sprintf("赛事数据解析失败：%v", err)}
}
