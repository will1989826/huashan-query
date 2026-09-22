package server

// trait.go —— 「特性画像」自算 T2 端点：按选手+赛区逐场重建(player.ComputeGameFacts)→
// 按阵营·范围(career/最近N/自然年)聚合(analysis.Agg)→出各指标分子/分母/值。
// 范围切分复刻 builder：range 以「同阵营内按 play_date 降序」定 recent N；年份按各局年份分桶。
// 档位/同侪排名/小样本收缩/联动由前端套 framework.json 完成。

import (
	"context"
	"sort"
	"strconv"

	"huashanquery/internal/analysis"
	"huashanquery/internal/player"
)

var recentSizes = []int{20, 50, 100}

func traitProfile(ctx context.Context, svc *player.Service, id, zone string) (any, error) {
	if zone == "" {
		zone = "ALL"
	}
	games, raws, err := svc.ZoneGamesFull(ctx, id, zone)
	if err != nil {
		return nil, err
	}
	pid, _ := strconv.Atoi(id)

	// 逐场重建，取本人座位事实，按阵营分组（保留 play_date/game_id 供排序分范围）。
	type row struct {
		date string
		gid  int
		sf   *player.SeatFacts
	}
	byCamp := map[string][]row{"good": nil, "wolf": nil}
	for i, raw := range raws {
		gf, ferr := player.ComputeGameFacts(raw)
		if ferr != nil {
			continue
		}
		for _, sf := range gf.Seats {
			if sf.PlayerID == pid && sf.Camp != "" {
				byCamp[sf.Camp] = append(byCamp[sf.Camp], row{games[i].PlayDate, games[i].GameID, sf})
				break
			}
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
		// 同阵营内按 play_date 降序、game_id 降序（与 builder rebuildPeriods 排序一致）。
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
