package server

// trait.go —— 「特性画像」自算 T2 端点：按选手+赛区逐场重建(player.ComputeGameFacts)→
// 按阵营聚合(analysis.Agg)→出各指标分子/分母/值。档位/同侪排名/联动由前端套 framework.json 完成。

import (
	"context"
	"strconv"

	"huashanquery/internal/analysis"
	"huashanquery/internal/player"
)

func traitProfile(ctx context.Context, svc *player.Service, id, zone string) (any, error) {
	if zone == "" {
		zone = "ALL"
	}
	raws, err := svc.ZoneGameRaws(ctx, id, zone)
	if err != nil {
		return nil, err
	}
	pid, _ := strconv.Atoi(id)
	aggs := map[string]*analysis.Agg{"good": {}, "wolf": {}}
	for _, raw := range raws {
		gf, ferr := player.ComputeGameFacts(raw)
		if ferr != nil {
			continue // 解析失败：与离线 builder 一致地跳过
		}
		for _, sf := range gf.Seats {
			if sf.PlayerID == pid && sf.Camp != "" {
				aggs[sf.Camp].Add(sf)
				break
			}
		}
	}
	return map[string]any{
		"zone":  zone,
		"games": map[string]int{"good": aggs["good"].Games, "wolf": aggs["wolf"].Games},
		"good":  aggs["good"].Metrics(),
		"wolf":  aggs["wolf"].Metrics(),
	}, nil
}
