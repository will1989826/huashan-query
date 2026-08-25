package event

// metrics.go —— 参赛量与门派归属计算：选手轮次分页解析、门派局数归属（含歧义补查）、按赛制换算天/局与均分。
// 一局 12 人来自 12 个门派，某门派每局最多 1 名成员在场，故“该门派全体成员 total_round 之和”= 该门派参赛总局数。

import (
	"bytes"
	"context"
	"encoding/json"
	"math"
	"strconv"
	"sync"

	"huashanquery/internal/player"
)

type eventPlayerAggregate struct {
	PlayerID   int    `json:"player_id"`
	PlayerName string `json:"player_name"`
	Name       string `json:"name"`
	TotalRound int    `json:"total_round"`
	Sects      []struct {
		ID int `json:"id"`
	} `json:"sects"`
}

func (p eventPlayerAggregate) label() string {
	if p.PlayerName != "" {
		return p.PlayerName
	}
	return p.Name
}

func (s *Service) eventPlayerAggregatePage(ctx context.Context, season, seasonType, zone string, page int) ([]eventPlayerAggregate, int, bool, error) {
	body, err := s.api.EventPlayerStats(ctx, season, seasonType, zone, page, eventMetricPageSize)
	if err != nil {
		return nil, 0, false, err
	}
	var rows []eventPlayerAggregate
	var total *int
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) > 0 && trimmed[0] == '[' {
		if err := json.Unmarshal(trimmed, &rows); err != nil {
			return nil, 0, false, eventDecodeError(err)
		}
	} else {
		var envelope struct {
			Items      []eventPlayerAggregate `json:"items"`
			TotalItems *int                   `json:"total_items"`
		}
		if err := json.Unmarshal(body, &envelope); err != nil {
			return nil, 0, false, eventDecodeError(err)
		}
		rows, total = envelope.Items, envelope.TotalItems
	}
	hasMore := len(rows) >= eventMetricPageSize
	totalPages := 0
	if total != nil {
		hasMore = page*eventMetricPageSize < *total
		totalPages = int(math.Ceil(float64(*total) / eventMetricPageSize))
	}
	return rows, totalPages, hasMore, nil
}

func cloneEventPlayerAggregates(source []eventPlayerAggregate) []eventPlayerAggregate {
	clone := append([]eventPlayerAggregate(nil), source...)
	for i := range clone {
		clone[i].Sects = append(clone[i].Sects[:0:0], source[i].Sects...)
	}
	return clone
}

// enrichFromRounds 把各门派已归属好的局数换算成参赛量与均分（纯计算，不联网）。
// 常规版型（day 模式）：每 3 局记 1 个比赛日，向上取整——比赛日中途每打完一场官方即更新，不满 3 局也算“当天确实打了”。
// 其余版型（game 模式）：直接按局数。均分固定用门派权威总分 ÷（天数或局数）。
func enrichFromRounds(ranks []SectRank, rounds []int, metricMode string) (available bool) {
	for i := range ranks {
		if rounds[i] == 0 {
			continue
		}
		divisor := rounds[i]
		if metricMode == "day" {
			ranks[i].Days = (rounds[i] + 2) / 3
			divisor = ranks[i].Days
		} else {
			ranks[i].Games = rounds[i]
		}
		ranks[i].Avg = player.Round2(ranks[i].TotalPoint / float64(divisor))
		available = true
	}
	return available
}

// resolveSectRounds 统计各门派参赛局数。归属唯一（成员生涯门派里只有一个在本赛事榜上）的选手直接累加；
// 归属歧义（榜上命中 ≥2 个历史门派）的选手，按其本赛季本赛区最新一场定位真实门派后再计入。
// 补查失败或无法唯一定位时该选手不计入并标记 incomplete；401 视为致命、上抛。
func (s *Service) resolveSectRounds(ctx context.Context, ranks []SectRank, players []eventPlayerAggregate, season, zone string) (rounds []int, incomplete bool, err error) {
	rounds, ambiguous := eventSectRoundStats(ranks, players)
	if len(ambiguous) == 0 {
		return rounds, false, nil
	}

	type resolution struct {
		idx   int // 目标 rounds 下标；<0 表示无法唯一归属
		round int
		err   error
	}
	results := make([]resolution, len(ambiguous))
	sem := make(chan struct{}, min(8, len(ambiguous)))
	var wg sync.WaitGroup
	for i := range ambiguous {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			a := ambiguous[i]
			base, e := s.playerLatestSectBase(ctx, a.player.PlayerID, season, zone)
			if e != nil {
				results[i] = resolution{idx: -1, err: e}
				return
			}
			results[i] = resolution{idx: matchCandidateSect(ranks, a.candidates, base), round: a.player.TotalRound}
		}(i)
	}
	wg.Wait()

	for _, r := range results {
		if r.err != nil {
			if is401(r.err) {
				return nil, false, r.err
			}
			incomplete = true
			continue
		}
		if r.idx < 0 {
			incomplete = true
			continue
		}
		rounds[r.idx] += r.round
	}
	return rounds, incomplete, nil
}

// playerLatestSectBase 返回选手在指定赛区+赛季最新一场门派的基名（去赛区后缀），按 (season|zone|player) 缓存至进程退出。
// 缓存值很小（一个短字符串），且门派成绩页大量选手多不会被逐一点开，故不复用整份逐场战绩缓存，只存这枚归属结果。
func (s *Service) playerLatestSectBase(ctx context.Context, playerID int, season, zone string) (string, error) {
	key := season + "|" + zone + "|" + strconv.Itoa(playerID)
	s.mu.Lock()
	if v, ok := s.playerSect[key]; ok {
		s.mu.Unlock()
		return v, nil
	}
	s.mu.Unlock()

	name, err := s.api.PlayerLatestSect(ctx, strconv.Itoa(playerID), zone, season)
	if err != nil {
		return "", err
	}
	base := player.BaseName(name)
	s.mu.Lock()
	s.playerSect[key] = base
	s.mu.Unlock()
	return base, nil
}

// matchCandidateSect 在候选门派（选手榜上命中的历史门派下标）里找基名与最新一场门派一致的那个。
// 恰好命中 1 个才返回其下标；空基名或命中 0/多个（同基名撞车）返回 -1，交由上层标记不完整。
func matchCandidateSect(ranks []SectRank, candidates []int, base string) int {
	if base == "" {
		return -1
	}
	found := -1
	for _, idx := range candidates {
		if player.BaseName(ranks[idx].SectName) == base {
			if found >= 0 {
				return -1
			}
			found = idx
		}
	}
	return found
}

// ambiguousMember 是一名榜上命中 ≥2 个门派、需补查最新一场才能定位的选手。
type ambiguousMember struct {
	player     eventPlayerAggregate
	candidates []int // 命中的门派在 ranks 中的下标
}

// eventSectRoundStats 遍历选手，把归属唯一者的 total_round 直接累加到对应门派，返回各门派干净局数与待补查的歧义选手。
// 未命中任何榜上门派、或该作用域没出场（total_round=0）的选手直接跳过。
func eventSectRoundStats(ranks []SectRank, players []eventPlayerAggregate) ([]int, []ambiguousMember) {
	teamIndex := make(map[int]int, len(ranks))
	for i, rank := range ranks {
		teamIndex[rank.SectID] = i
	}
	rounds := make([]int, len(ranks))
	var ambiguous []ambiguousMember
	for _, pa := range players {
		if pa.TotalRound <= 0 {
			continue
		}
		matches := eventPlayerSectIndexes(teamIndex, pa)
		switch len(matches) {
		case 0:
		case 1:
			rounds[matches[0]] += pa.TotalRound
		default:
			ambiguous = append(ambiguous, ambiguousMember{player: pa, candidates: matches})
		}
	}
	return rounds, ambiguous
}

func eventPlayerMatchesSect(teamIndex map[int]int, targetIndex int, pa eventPlayerAggregate) bool {
	for _, index := range eventPlayerSectIndexes(teamIndex, pa) {
		if index == targetIndex {
			return true
		}
	}
	return false
}

func eventPlayerSectIndexes(teamIndex map[int]int, pa eventPlayerAggregate) []int {
	matches := make([]int, 0, len(pa.Sects))
	seen := make(map[int]bool, len(pa.Sects))
	for _, sect := range pa.Sects {
		if team, ok := teamIndex[sect.ID]; ok && !seen[team] {
			seen[team] = true
			matches = append(matches, team)
		}
	}
	return matches
}
