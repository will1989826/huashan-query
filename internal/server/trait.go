package server

// trait.go —— 「特性画像」自算 T2 端点：按选手+赛区逐场重建(player.ComputeGameFacts)→
// 按阵营·范围(career/最近N/自然年)聚合(analysis.Agg)→出各指标分子/分母/值。
// 逐场需拉「单场完整详情(form2)」——用 svc.Game(gid)(按 gid 缓存)，不能用逐场列表汇总行(无 form2)。
// 范围切分复刻 builder：range 以「同阵营内按 play_date 降序」定 recent N；年份按各局年份分桶。
// 档位/同侪排名/小样本收缩/联动由前端套 framework.json 完成。

import (
	"context"
	"fmt"
	"sort"
	"strconv"
	"sync"

	"huashanquery/internal/analysis"
	"huashanquery/internal/logx"
	"huashanquery/internal/player"
)

var recentSizes = []int{20, 50, 100}

const (
	traitFetchConcurrency = 6   // 并发拉单场详情（与 lineup 同量级，避免压垮官方接口）
	traitRecentMaxGames   = 100 // 最近范围的上限；当年和去年仍纳入对应自然年的全部对局
)

func traitProfile(ctx context.Context, svc *player.Service, id, zone string) (any, error) {
	if zone == "" {
		zone = "ALL"
	}
	games, err := svc.ZoneGames(ctx, id, zone) // 逐场列表（含 game_id/play_date），仅拿索引
	if err != nil {
		return nil, err
	}
	// ZoneGames exposes the cached index slice. Keep its order aligned with the
	// cached raw rows used by player.Detail; trait sorting must stay request-local.
	games = append([]player.Game(nil), games...)
	// Sort a request-local copy so the cached index keeps its raw-row alignment.
	sort.SliceStable(games, func(i, j int) bool {
		if games[i].PlayDate != games[j].PlayDate {
			return games[i].PlayDate > games[j].PlayDate
		}
		return games[i].GameID > games[j].GameID
	})
	// Recent scopes use at most 100 games, while the two displayed calendar-year
	// scopes must include every game in those years to match their DB thresholds.
	years := map[string]bool{}
	for _, g := range games {
		if len(g.PlayDate) >= 4 && len(years) < 2 {
			years[g.PlayDate[:4]] = true
		}
	}
	selected := make([]player.Game, 0, min(len(games), traitRecentMaxGames))
	for i, g := range games {
		if i < traitRecentMaxGames || (len(g.PlayDate) >= 4 && years[g.PlayDate[:4]]) {
			selected = append(selected, g)
		}
	}
	games = selected
	pid, _ := strconv.Atoi(id)

	// 并发拉每场完整详情(form2)并逐场重建，取本人座位事实。
	type row struct {
		date string
		gid  int
		sf   *player.SeatFacts
	}
	rows := make([]*row, len(games))
	failures := make([]error, len(games))
	sem := make(chan struct{}, traitFetchConcurrency)
	var wg sync.WaitGroup
	for i := range games {
		wg.Add(1)
		sem <- struct{}{}
		go func(i int) {
			defer wg.Done()
			defer func() { <-sem }()
			g := games[i]
			raw, gerr := svc.Game(ctx, strconv.Itoa(g.GameID))
			if gerr != nil {
				failures[i] = fmt.Errorf("fetch game %d: %w", g.GameID, gerr)
				return
			}
			gf, ferr := player.ComputeGameFacts(raw)
			if ferr != nil {
				failures[i] = fmt.Errorf("rebuild game %d: %w", g.GameID, ferr)
				return
			}
			var matched *player.SeatFacts
			for _, sf := range gf.Seats {
				if sf.PlayerID != pid || sf.Camp == "" {
					continue
				}
				if matched != nil {
					failures[i] = fmt.Errorf("rebuild game %d: player %d appears more than once", g.GameID, pid)
					return // Corrupt roster: do not choose a nondeterministic seat.
				}
				matched = sf
			}
			if matched == nil {
				failures[i] = fmt.Errorf("rebuild game %d: player %d has no valid seat", g.GameID, pid)
				return
			}
			rows[i] = &row{g.PlayDate, g.GameID, matched}
		}(i)
	}
	wg.Wait()
	failed := 0
	var firstFailure error
	for _, failure := range failures {
		if failure == nil {
			continue
		}
		failed++
		if firstFailure == nil {
			firstFailure = failure
		}
	}
	if len(games) > 0 && failed == len(games) {
		logx.Errorf("trait profile for player %d failed for all %d selected games; first failure: %v", pid, len(games), firstFailure)
		return nil, fmt.Errorf("rebuild trait profile: all %d selected games failed; first failure: %w", len(games), firstFailure)
	}
	if failed > 0 {
		logx.Errorf("trait profile for player %d rebuilt %d/%d games; first failure: %v", pid, len(games)-failed, len(games), firstFailure)
	}

	byCamp := map[string][]*row{"good": nil, "wolf": nil}
	for _, r := range rows {
		if r != nil {
			byCamp[r.sf.Camp] = append(byCamp[r.sf.Camp], r)
		}
	}

	// scopeKey -> camp -> *Agg
	scopes := map[string]map[string]*analysis.Agg{}
	agg := func(scope, camp string) *analysis.Agg {
		if scopes[scope] == nil {
			scopes[scope] = map[string]*analysis.Agg{}
		}
		if scopes[scope][camp] == nil {
			scopes[scope][camp] = &analysis.Agg{}
		}
		return scopes[scope][camp]
	}
	for camp, list := range byCamp {
		sort.SliceStable(list, func(i, j int) bool {
			if list[i].date != list[j].date {
				return list[i].date > list[j].date
			}
			return list[i].gid > list[j].gid
		})
		for rank, x := range list {
			if len(x.date) >= 4 {
				agg("year|"+x.date[:4], camp).Add(x.sf)
			}
			for _, n := range recentSizes {
				if rank+1 <= n {
					agg("recent|"+strconv.Itoa(n), camp).Add(x.sf)
				}
			}
		}
	}

	out := map[string]map[string]map[string]analysis.Metric{}
	for scope, camps := range scopes {
		out[scope] = map[string]map[string]analysis.Metric{}
		for camp, a := range camps {
			out[scope][camp] = a.Metrics()
		}
	}
	return map[string]any{
		"zone": zone,
		"games": map[string]int{
			"good": len(byCamp["good"]), "wolf": len(byCamp["wolf"]),
			"selected": len(games), "rebuilt": len(games) - failed, "failed": failed,
		},
		"scopes": out,
	}, nil
}
