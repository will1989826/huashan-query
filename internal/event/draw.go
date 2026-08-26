package event

// draw.go —— 季后赛/总决赛抽局模拟数据：汇总每局门派得分，并以官方门派总分反推不随抽局消失的调整。

import (
	"context"
	"fmt"
	"math"
	"net/http"
	"sort"
	"strconv"
	"sync"

	"huashanquery/internal/huashan"
	"huashanquery/internal/player"
)

const (
	drawTolerance    = 0.001
	drawFetchWorkers = 16
)

var drawFourMasks = chooseFourMasks(12)

type DrawTool struct {
	Season                string     `json:"season"`
	SeasonType            string     `json:"season_type"`
	Zone                  string     `json:"zone"`
	ExpectedGames         int        `json:"expected_games"`
	CountedGames          int        `json:"counted_games"`
	CompletedGames        int        `json:"completed_games"`
	Complete              bool       `json:"complete"`
	SimulationReady       bool       `json:"simulation_ready"`
	OfficialDrawApplied   bool       `json:"official_draw_applied"`
	HistoricalRemovedGame int        `json:"historical_removed_game,omitempty"`
	Teams                 []DrawTeam `json:"teams"`
	Games                 []DrawGame `json:"games"`
	Warnings              []string   `json:"warnings"`
}

type DrawTeam struct {
	SectID             int     `json:"sect_id"`
	SectName           string  `json:"sect_name"`
	OfficialTotal      float64 `json:"official_total"`
	InitialBonus       float64 `json:"initial_bonus"`
	OutsideAdjustment  float64 `json:"outside_adjustment"`
	ConstantAdjustment float64 `json:"constant_adjustment"`
}

type DrawGame struct {
	Index    int        `json:"index"`
	GameID   int        `json:"game_id,omitempty"`
	PlayDate string     `json:"play_date,omitempty"`
	Round    int        `json:"round,omitempty"`
	Complete bool       `json:"complete"`
	Scores   []*float64 `json:"scores"`
}

type drawFetchedPlayer struct {
	id    int
	games []player.Game
	err   error
}

type drawGameAggregate struct {
	id     int
	date   string
	round  int
	scores map[int]float64
}

// drawToolCall 合并后台预热与页面查询，确保同一赛事范围只拉取和计算一次。
type drawToolCall struct {
	done   chan struct{}
	result *DrawTool
	err    error
}

// EventDrawTool 返回抽局模拟所需的官方快照。对局积分直接使用逐场 total_point；官方总分只用来保留带入积分和赛外违规扣分。
func (s *Service) EventDrawTool(ctx context.Context, season, seasonType, zone string) (*DrawTool, error) {
	if !positiveNumber(season) {
		return nil, &huashan.APIError{Status: http.StatusBadRequest, Message: "请选择赛季"}
	}
	if seasonType != "4" && seasonType != "5" {
		return nil, &huashan.APIError{Status: http.StatusBadRequest, Message: "抽局模拟仅支持季后赛和总决赛"}
	}
	zone = zoneOrDefault(zone)
	if !validZone(zone) || zone == "ALL" {
		return nil, &huashan.APIError{Status: http.StatusBadRequest, Message: "请选择有效的赛区"}
	}
	cacheKey := season + "|" + seasonType + "|" + zone
	s.mu.Lock()
	if cached := s.drawTools[cacheKey]; cached != nil {
		s.mu.Unlock()
		return cached, nil
	}
	if call := s.drawCalls[cacheKey]; call != nil {
		s.mu.Unlock()
		select {
		case <-call.done:
			return call.result, call.err
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	call := &drawToolCall{done: make(chan struct{})}
	s.drawCalls[cacheKey] = call
	s.mu.Unlock()

	result, err := s.computeDrawTool(ctx, season, seasonType, zone)
	s.mu.Lock()
	if err == nil && result.SimulationReady {
		if cached := s.drawTools[cacheKey]; cached != nil {
			result = cached
		} else {
			s.drawTools[cacheKey] = result
		}
	}
	call.result, call.err = result, err
	delete(s.drawCalls, cacheKey)
	close(call.done)
	s.mu.Unlock()
	return result, err
}

func (s *Service) computeDrawTool(ctx context.Context, season, seasonType, zone string) (*DrawTool, error) {
	rankings, err := s.EventSectRankings(ctx, season, seasonType, zone)
	if err != nil {
		return nil, err
	}
	if len(rankings.Items) != 12 {
		return nil, &huashan.APIError{Status: http.StatusUnprocessableEntity, Message: "该赛事不是 12 支门派，无法进行抽局模拟"}
	}
	participants, err := s.drawParticipants(ctx, season, seasonType, zone)
	if err != nil {
		return nil, err
	}
	fetched := s.fetchDrawGames(ctx, participants, zone, season, seasonType)
	result := buildDrawTool(season, seasonType, zone, rankings.Items, fetched)
	return result, nil
}

// PrewarmLatestDraw 静默计算指定赛区最新可模拟的淘汰赛数据，供后续页面查询直接命中缓存。
// 没有可模拟赛季不是错误；预热失败只由调用方记录，不影响任何页面请求。
func (s *Service) PrewarmLatestDraw(ctx context.Context, zone string) (season, seasonType string, err error) {
	season, seasonType, err = s.latestDrawScope(ctx, zone)
	if err != nil || season == "" || seasonType == "" {
		return season, seasonType, err
	}
	_, err = s.EventDrawTool(ctx, season, seasonType, zone)
	return season, seasonType, err
}

func (s *Service) latestDrawScope(ctx context.Context, zone string) (string, string, error) {
	rangeResult, err := s.EventSeasonsForZone(ctx, zone)
	if err != nil {
		return "", "", err
	}
	seasons := append([]EventOption(nil), rangeResult.Seasons...)
	sort.SliceStable(seasons, func(i, j int) bool {
		a, _ := strconv.Atoi(seasons[i].Value)
		b, _ := strconv.Atoi(seasons[j].Value)
		return a > b
	})
	for _, season := range seasons {
		types, typeErr := s.EventSeasonTypesForScope(ctx, season.Value, rangeResult.Zone)
		if typeErr != nil {
			return "", "", typeErr
		}
		for _, wanted := range []string{"5", "4"} {
			if eventOptionExists(types, wanted) {
				return season.Value, wanted, nil
			}
		}
	}
	return "", "", nil
}

func (s *Service) drawParticipants(ctx context.Context, season, seasonType, zone string) ([]eventPlayerAggregate, error) {
	seen := make(map[int]bool)
	var all []eventPlayerAggregate
	for page := 1; page <= eventMaxPages; page++ {
		metricPage, err := s.EventSectRankMetricPage(ctx, season, seasonType, zone, page)
		if err != nil {
			return nil, err
		}
		for _, p := range metricPage.players {
			if p.PlayerID > 0 && p.TotalRound > 0 && !seen[p.PlayerID] {
				seen[p.PlayerID] = true
				all = append(all, p)
			}
		}
		if metricPage.TotalPages > 0 {
			if page >= metricPage.TotalPages {
				break
			}
		} else if !metricPage.HasMore {
			break
		}
		if page == eventMaxPages {
			return nil, &huashan.APIError{Status: http.StatusBadGateway, Message: "参赛选手数据过多，无法完整读取"}
		}
	}
	return all, nil
}

func (s *Service) fetchDrawGames(ctx context.Context, participants []eventPlayerAggregate, zone, season, seasonType string) []drawFetchedPlayer {
	results := make([]drawFetchedPlayer, len(participants))
	sem := make(chan struct{}, min(drawFetchWorkers, max(1, len(participants))))
	var wg sync.WaitGroup
	for i, participant := range participants {
		wg.Add(1)
		go func(i, id int) {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
			case <-ctx.Done():
				results[i] = drawFetchedPlayer{id: id, err: ctx.Err()}
				return
			}
			defer func() { <-sem }()
			games, err := s.games.EventGames(ctx, strconv.Itoa(id), zone, season, seasonType)
			results[i] = drawFetchedPlayer{id: id, games: games, err: err}
		}(i, participant.PlayerID)
	}
	wg.Wait()
	return results
}

func buildDrawTool(season, seasonType, zone string, ranks []SectRank, fetched []drawFetchedPlayer) *DrawTool {
	expected := 16
	if seasonType == "4" {
		expected = 15
	}
	result := &DrawTool{
		Season: season, SeasonType: seasonType, Zone: zone, ExpectedGames: expected, CountedGames: expected - 1,
		SimulationReady: true, Teams: make([]DrawTeam, len(ranks)), Warnings: []string{},
	}
	teamIndex := make(map[int]int, len(ranks))
	baseIndex := make(map[string]int, len(ranks))
	duplicateBase := make(map[string]bool)
	for i, rank := range ranks {
		result.Teams[i] = DrawTeam{SectID: rank.SectID, SectName: rank.SectName, OfficialTotal: rank.TotalPoint}
		teamIndex[rank.SectID] = i
		base := player.BaseName(rank.SectName)
		if _, exists := baseIndex[base]; exists {
			duplicateBase[base] = true
		} else {
			baseIndex[base] = i
		}
	}

	seasonID, _ := strconv.Atoi(season)
	seasonTypeID, _ := strconv.Atoi(seasonType)
	games := make(map[int]*drawGameAggregate)
	seenRows := make(map[string]bool)
	failedPlayers := 0
	conflicts := 0
	for _, fetchedPlayer := range fetched {
		if fetchedPlayer.err != nil {
			failedPlayers++
			continue
		}
		for _, game := range fetchedPlayer.games {
			if !game.HasSeason || game.SeasonID != seasonID || game.SeasonTypeID != seasonTypeID || game.GameID <= 0 {
				continue
			}
			idx, ok := teamIndex[game.SectID]
			if !ok && !duplicateBase[game.SectBase] {
				idx, ok = baseIndex[game.SectBase]
			}
			if !ok {
				continue
			}
			playerID := game.PlayerID
			if playerID <= 0 {
				playerID = fetchedPlayer.id
			}
			rowKey := fmt.Sprintf("%d|%d", game.GameID, playerID)
			if seenRows[rowKey] {
				continue
			}
			seenRows[rowKey] = true
			agg := games[game.GameID]
			if agg == nil {
				agg = &drawGameAggregate{id: game.GameID, date: game.PlayDate, round: game.Round, scores: make(map[int]float64)}
				games[game.GameID] = agg
			}
			if old, exists := agg.scores[idx]; exists {
				if math.Abs(old-game.Point) > drawTolerance {
					conflicts++
				}
				continue
			}
			agg.scores[idx] = game.Point
		}
	}
	if failedPlayers > 0 {
		result.Warnings = append(result.Warnings, fmt.Sprintf("%d 名选手的逐场数据读取失败，部分局分可能缺失。", failedPlayers))
	}
	if conflicts > 0 {
		result.Warnings = append(result.Warnings, "发现同一门派同一局的重复分数，已保留首条官方记录。")
	}

	ordered := make([]*drawGameAggregate, 0, len(games))
	for _, game := range games {
		ordered = append(ordered, game)
	}
	sort.Slice(ordered, func(i, j int) bool {
		if ordered[i].date != ordered[j].date {
			return ordered[i].date < ordered[j].date
		}
		if ordered[i].round != ordered[j].round {
			return ordered[i].round < ordered[j].round
		}
		return ordered[i].id < ordered[j].id
	})
	for i, game := range ordered {
		item := DrawGame{Index: i + 1, GameID: game.id, PlayDate: game.date, Round: game.round, Complete: true, Scores: make([]*float64, len(ranks))}
		for teamIdx, point := range game.scores {
			value := player.Round2(point)
			item.Scores[teamIdx] = &value
		}
		result.Games = append(result.Games, item)
	}
	result.CompletedGames = len(result.Games)
	result.Complete = result.CompletedGames == expected
	if result.CompletedGames > expected {
		result.SimulationReady = false
		result.Warnings = append(result.Warnings, fmt.Sprintf("读取到 %d 局，超过该赛制应有的 %d 局。", result.CompletedGames, expected))
	}
	for len(result.Games) < expected {
		result.Games = append(result.Games, DrawGame{Index: len(result.Games) + 1, Scores: make([]*float64, len(ranks))})
	}

	missing := 0
	for i := 0; i < result.CompletedGames && i < expected; i++ {
		for _, score := range result.Games[i].Scores {
			if score == nil {
				missing++
			}
		}
	}
	if missing > 0 {
		result.SimulationReady = false
		result.Warnings = append(result.Warnings, fmt.Sprintf("官方逐场数据缺少 %d 个门派局分，暂时无法准确模拟。", missing))
	}
	if !result.SimulationReady {
		return result
	}

	sums := make([]float64, len(ranks))
	for i := 0; i < result.CompletedGames; i++ {
		for teamIdx, score := range result.Games[i].Scores {
			if score != nil {
				sums[teamIdx] += *score
			}
		}
	}
	if result.Complete {
		removed, bonuses, outside, unique := inferHistoricalDraw(result.Teams, result.Games[:expected], sums, seasonType)
		if removed < 0 || !unique {
			result.SimulationReady = false
			result.Warnings = append(result.Warnings, "无法从官方总分唯一确认已抽掉的比赛，暂时无法准确模拟。")
			return result
		}
		result.OfficialDrawApplied = true
		result.HistoricalRemovedGame = result.Games[removed].GameID
		for i := range result.Teams {
			result.Teams[i].InitialBonus = bonuses[i]
			result.Teams[i].OutsideAdjustment = player.Round2(outside[i])
			result.Teams[i].ConstantAdjustment = player.Round2(bonuses[i] + outside[i])
		}
	} else {
		residual := make([]float64, len(ranks))
		for i := range ranks {
			residual[i] = result.Teams[i].OfficialTotal - sums[i]
		}
		bonuses, outside, _ := fitDrawAdjustments(residual, seasonType)
		for i := range result.Teams {
			result.Teams[i].InitialBonus = bonuses[i]
			result.Teams[i].OutsideAdjustment = player.Round2(outside[i])
			result.Teams[i].ConstantAdjustment = player.Round2(residual[i])
		}
	}
	for _, team := range result.Teams {
		if team.OutsideAdjustment > drawTolerance {
			result.Warnings = append(result.Warnings, "部分官方总分无法由对局积分、带入积分和赛外违规扣分解释，请核对原始数据。")
			break
		}
	}
	return result
}

type drawFit struct {
	invalid           int
	positiveMagnitude float64
	zeroCount         int
	negativeMagnitude float64
	squaredMagnitude  float64
}

func scoreOutside(outside []float64) drawFit {
	var fit drawFit
	for _, value := range outside {
		if value > drawTolerance {
			fit.invalid++
			fit.positiveMagnitude += value
		}
		if math.Abs(value) <= drawTolerance {
			fit.zeroCount++
		}
		if value < -drawTolerance {
			fit.negativeMagnitude -= value
		}
		fit.squaredMagnitude += value * value
	}
	return fit
}

func betterDrawFit(a, b drawFit) int {
	if a.invalid != b.invalid {
		if a.invalid < b.invalid {
			return -1
		}
		return 1
	}
	if a.zeroCount != b.zeroCount {
		if a.zeroCount > b.zeroCount {
			return -1
		}
		return 1
	}
	if math.Abs(a.positiveMagnitude-b.positiveMagnitude) > drawTolerance {
		if a.positiveMagnitude < b.positiveMagnitude {
			return -1
		}
		return 1
	}
	if math.Abs(a.negativeMagnitude-b.negativeMagnitude) > drawTolerance {
		if a.negativeMagnitude < b.negativeMagnitude {
			return -1
		}
		return 1
	}
	if math.Abs(a.squaredMagnitude-b.squaredMagnitude) > drawTolerance {
		if a.squaredMagnitude < b.squaredMagnitude {
			return -1
		}
		return 1
	}
	return 0
}

func inferHistoricalDraw(teams []DrawTeam, games []DrawGame, sums []float64, seasonType string) (int, []float64, []float64, bool) {
	best := -1
	var bestBonus, bestOutside []float64
	var bestFit drawFit
	unique := true
	for gameIdx, game := range games {
		residual := make([]float64, len(teams))
		for teamIdx := range teams {
			residual[teamIdx] = teams[teamIdx].OfficialTotal - sums[teamIdx] + *game.Scores[teamIdx]
		}
		bonus, outside, fit := fitDrawAdjustments(residual, seasonType)
		cmp := -1
		if best >= 0 {
			cmp = betterDrawFit(fit, bestFit)
		}
		if best < 0 || cmp < 0 {
			best, bestBonus, bestOutside, bestFit, unique = gameIdx, bonus, outside, fit, true
		} else if cmp == 0 {
			unique = false
		}
	}
	return best, bestBonus, bestOutside, unique
}

func fitDrawAdjustments(residual []float64, seasonType string) ([]float64, []float64, drawFit) {
	if seasonType != "4" || len(residual) != 12 {
		bonus := make([]float64, len(residual))
		outside := append([]float64(nil), residual...)
		return bonus, outside, scoreOutside(outside)
	}
	bestFiveMask, bestThreeMask := 0, 0
	var bestFit drawFit
	hasBest := false
	for _, fiveMask := range drawFourMasks {
		for _, threeMask := range drawFourMasks {
			if fiveMask&threeMask != 0 {
				continue
			}
			var fit drawFit
			for i := range residual {
				bonus := 0.0
				if fiveMask&(1<<i) != 0 {
					bonus = 5
				} else if threeMask&(1<<i) != 0 {
					bonus = 3
				}
				value := residual[i] - bonus
				if value > drawTolerance {
					fit.invalid++
					fit.positiveMagnitude += value
				}
				if math.Abs(value) <= drawTolerance {
					fit.zeroCount++
				}
				if value < -drawTolerance {
					fit.negativeMagnitude -= value
				}
				fit.squaredMagnitude += value * value
			}
			if !hasBest || betterDrawFit(fit, bestFit) < 0 {
				bestFiveMask, bestThreeMask, bestFit, hasBest = fiveMask, threeMask, fit, true
			}
		}
	}
	bestBonus := make([]float64, 12)
	bestOutside := make([]float64, 12)
	for i := range residual {
		if bestFiveMask&(1<<i) != 0 {
			bestBonus[i] = 5
		} else if bestThreeMask&(1<<i) != 0 {
			bestBonus[i] = 3
		}
		bestOutside[i] = residual[i] - bestBonus[i]
	}
	return bestBonus, bestOutside, bestFit
}

func chooseFourMasks(n int) []int {
	var masks []int
	for mask := 0; mask < 1<<n; mask++ {
		if bitsSet(mask) == 4 {
			masks = append(masks, mask)
		}
	}
	return masks
}

func bitsSet(value int) int {
	count := 0
	for value > 0 {
		value &= value - 1
		count++
	}
	return count
}
