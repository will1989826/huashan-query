package server

// trait.go —— 「特性画像」自算 T2 端点：按选手+赛区逐场重建(player.ComputeGameFacts)→
// 按阵营·范围(career/最近N/自然年)聚合(analysis.Agg)→出各指标分子/分母/值。
// 逐场需拉「单场完整详情(form2)」——用 svc.Game(gid)(按 gid 缓存)，不能用逐场列表汇总行(无 form2)。
// 范围切分复刻 builder：range 以「同阵营内按 play_date 降序」定 recent N；年份按各局年份分桶。
// 档位/同侪排名/小样本收缩/联动由前端套 framework.json 完成。

import (
	"context"
	"sort"
	"strconv"
	"sync"

	"huashanquery/internal/analysis"
	"huashanquery/internal/player"
)

var recentSizes = []int{20, 50, 100}

const traitFetchConcurrency = 6 // 并发拉单场详情（与 lineup 同量级，避免压垮官方接口）

func traitProfile(ctx context.Context, svc *player.Service, id, zone string) (any, error) {
	if zone == "" {
		zone = "ALL"
	}
	games, err := svc.ZoneGames(ctx, id, zone) // 逐场列表（含 game_id/play_date），仅拿索引
	if err != nil {
		return nil, err
	}
	pid, _ := strconv.Atoi(id)

	// 并发拉每场完整详情(form2)并逐场重建，取本人座位事实。
	type row struct {
		date string
		gid  int
		sf   *player.SeatFacts
	}
	rows := make([]*row, len(games))
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
				return
			}
			gf, ferr := player.ComputeGameFacts(raw)
			if ferr != nil {
				return
			}
			for _, sf := range gf.Seats {
				if sf.PlayerID == pid && sf.Camp != "" {
					rows[i] = &row{g.PlayDate, g.GameID, sf}
					return
				}
			}
		}(i)
	}
	wg.Wait()

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
			agg("career|all", camp).Add(x.sf)
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
		"zone":   zone,
		"games":  map[string]int{"good": len(byCamp["good"]), "wolf": len(byCamp["wolf"])},
		"scopes": out,
	}, nil
}
