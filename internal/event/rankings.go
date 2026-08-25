package event

// rankings.go —— 门派排名与派生指标：门派总分排名分页拉全并排序、按需分页读取选手轮次、
// 按赛制换算参赛量(天/局)与均分。换算与门派归属是领域逻辑，集中于此，页面只按 sect_id 关联展示。

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"sort"
	"strconv"

	"huashanquery/internal/huashan"
	"huashanquery/internal/player"
)

const (
	eventPageSize = 500
	// eventMetricPageSize 用大页拉选手汇总：官方 /stats/players/games 返回裸数组、无 total_items，
	// 分页只能靠“短页即末页”判断；单赛区选手多为数百人，500/页通常一次拉完，把翻页从 ~4 次降到 1 次。
	eventMetricPageSize = 500
	eventMaxPages       = 20
)

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
// 不在前端累加或套用换算规则（换算规则是领域逻辑，归本层）。
type EventRankMetrics struct {
	MetricMode        string              `json:"metric_mode"`
	MetricsAvailable  bool                `json:"metrics_available"`
	PlayersAvailable  bool                `json:"players_available"`
	MetricsIncomplete bool                `json:"metrics_incomplete,omitempty"`
	Items             []EventSectMetric   `json:"items"`
	Players           []EventPlayerMetric `json:"players"`
}

// EventSectMetric 是单支门派的参赛量与均分；按赛制只填 Days 或 Games 之一。
type EventSectMetric struct {
	SectID int     `json:"sect_id"`
	Days   int     `json:"days,omitempty"`
	Games  int     `json:"games,omitempty"`
	Avg    float64 `json:"avg,omitempty"`
}

// EventPlayerMetric 是所选赛事范围内的一名参赛选手。Games 始终保留实际场次；
// day 模式另填 Days，Avg 随赛制表示日均分或场均分。
type EventPlayerMetric struct {
	Rank       int     `json:"rank"`
	PlayerID   int     `json:"player_id"`
	PlayerName string  `json:"player_name"`
	Games      int     `json:"games"`
	Days       int     `json:"days,omitempty"`
	TotalPoint float64 `json:"total_point"`
	Avg        float64 `json:"avg"`
	MVP        int     `json:"mvp"`
	SVP        int     `json:"svp"`
	BGX        int     `json:"bgx"`
}

// EventSectRankings 返回指定赛区、赛季和比赛类型下的门派排名。
func (s *Service) EventSectRankings(ctx context.Context, season, seasonType, zone string) (*EventRankings, error) {
	if !positiveNumber(season) {
		return nil, &huashan.APIError{Status: http.StatusBadRequest, Message: "请选择赛季"}
	}
	if seasonType != "" && !positiveNumber(seasonType) {
		return nil, &huashan.APIError{Status: http.StatusBadRequest, Message: "请选择有效的比赛类型"}
	}
	zone = zoneOrDefault(zone)
	if !validZone(zone) {
		return nil, &huashan.APIError{Status: http.StatusBadRequest, Message: "请选择有效的赛区"}
	}
	cacheKey := eventProbeKey(eventProbe{season: season, seasonType: seasonType, zone: zone})
	s.mu.Lock()
	if cached := s.rankings[cacheKey]; cached != nil {
		result := cloneEventRankings(cached)
		s.mu.Unlock()
		return result, nil
	}
	s.mu.Unlock()
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
				SectID: int(item.SectID.v), SectName: item.SectName, TotalPoint: player.Round2(item.TotalPoint.v),
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
	s.mu.Lock()
	if cached := s.rankings[cacheKey]; cached != nil {
		result = cloneEventRankings(cached)
	} else {
		s.rankings[cacheKey] = cloneEventRankings(result)
	}
	s.mu.Unlock()
	return result, nil
}

// EventSectRankMetricPage 每次只读取一页选手轮次，避免大赛事在单个请求内拉完整份选手汇总。
func (s *Service) EventSectRankMetricPage(ctx context.Context, season, seasonType, zone string, page int) (*EventRankMetricPage, error) {
	zone = zoneOrDefault(zone)
	if !validZone(zone) {
		return nil, &huashan.APIError{Status: http.StatusBadRequest, Message: "请选择有效的赛区"}
	}
	if page <= 0 || page > eventMaxPages {
		return nil, &huashan.APIError{Status: http.StatusBadRequest, Message: "请选择有效的数据页"}
	}
	cacheKey := eventProbeKey(eventProbe{season: season, seasonType: seasonType, zone: zone}) + "|" + strconv.Itoa(page)
	s.mu.Lock()
	if cached := s.metricPages[cacheKey]; cached != nil {
		result := cloneEventRankMetricPage(cached)
		s.mu.Unlock()
		return result, nil
	}
	s.mu.Unlock()
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
	s.mu.Lock()
	if cached := s.metricPages[cacheKey]; cached != nil {
		result = cloneEventRankMetricPage(cached)
	} else {
		s.metricPages[cacheKey] = cloneEventRankMetricPage(result)
	}
	s.mu.Unlock()
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
// 由 resolveSectRounds 补查最新一场定位真实门派。换算与归属都是领域逻辑，集中在本层，页面不自行累加或换算。
func (s *Service) EventSectRankMetrics(ctx context.Context, season, seasonType, zone string) (*EventRankMetrics, error) {
	rankings, err := s.EventSectRankings(ctx, season, seasonType, zone)
	if err != nil {
		return nil, err
	}
	if seasonType == "" {
		// “全部比赛类型”把常规赛、季后赛等不同赛制混在一起，天数（3 局=1 天）与场次没有统一分母，
		// 强行相加/相除会得出错误的参赛量与均分——此范围下不计算派生指标，仅保留门派总分排名。
		return &EventRankMetrics{MetricMode: rankings.MetricMode, MetricsAvailable: false, Items: []EventSectMetric{}, Players: []EventPlayerMetric{}}, nil
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
	playerItems := eventPlayerMetrics(players, rankings.MetricMode)
	return &EventRankMetrics{
		MetricMode: rankings.MetricMode, MetricsAvailable: available, PlayersAvailable: len(playerItems) > 0,
		MetricsIncomplete: incomplete, Items: items, Players: playerItems,
	}, nil
}

func eventPlayerMetrics(players []eventPlayerAggregate, metricMode string) []EventPlayerMetric {
	items := make([]EventPlayerMetric, 0, len(players))
	for _, p := range players {
		if p.PlayerID <= 0 || p.TotalRound <= 0 {
			continue
		}
		games := p.TotalRound
		days := 0
		divisor := games
		if metricMode == "day" {
			days = (games + 2) / 3
			divisor = days
		}
		items = append(items, EventPlayerMetric{
			PlayerID: p.PlayerID, PlayerName: p.label(), Games: games, Days: days,
			TotalPoint: player.Round2(p.TotalPoint.v), Avg: player.Round2(p.TotalPoint.v / float64(divisor)),
			MVP: int(math.Round(p.MVP.v)), SVP: int(math.Round(p.SVP.v)), BGX: int(math.Round(p.BGX.v)),
		})
	}
	sort.SliceStable(items, func(i, j int) bool {
		if items[i].TotalPoint != items[j].TotalPoint {
			return items[i].TotalPoint > items[j].TotalPoint
		}
		if items[i].Games != items[j].Games {
			return items[i].Games > items[j].Games
		}
		return items[i].PlayerName < items[j].PlayerName
	})
	for i := range items {
		items[i].Rank = i + 1
	}
	return items
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
