package event

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"huashanquery/internal/huashan"
	"huashanquery/internal/player"
)

func drawFixture(t *testing.T, seasonType string, gameCount, removed int, outside []float64) ([]SectRank, []drawFetchedPlayer) {
	t.Helper()
	ranks := make([]SectRank, 12)
	fetched := make([]drawFetchedPlayer, 12)
	for team := 0; team < 12; team++ {
		games := make([]player.Game, gameCount)
		sum := 0.0
		for game := 0; game < gameCount; game++ {
			point := float64(game + 2 + team%3)
			if game == removed && team == 2 {
				point = -1.5
			}
			games[game] = player.Game{
				GameID: 1000 + game, PlayDate: fmt.Sprintf("2026-07-%02d", game/3+1), Round: game%3 + 1,
				SectID: team + 1, PlayerID: 200 + team, SeasonID: 28, HasSeason: true,
				SeasonTypeID: map[string]int{"4": 4, "5": 5}[seasonType], SectRaw: fmt.Sprintf("门派%d", team+1), SectBase: fmt.Sprintf("门派%d", team+1), Point: point,
			}
			sum += point
		}
		bonus := 0.0
		if seasonType == "4" {
			if team < 4 {
				bonus = 5
			} else if team < 8 {
				bonus = 3
			}
		}
		ranks[team] = SectRank{SectID: team + 1, SectName: fmt.Sprintf("门派%d", team+1), TotalPoint: sum - games[removed].Point + bonus + outside[team]}
		fetched[team] = drawFetchedPlayer{id: 200 + team, games: games}
	}
	return ranks, fetched
}

func TestBuildDrawToolInfersPlayoffDrawBonusesAndOutsideAdjustment(t *testing.T) {
	outside := make([]float64, 12)
	outside[0] = -2
	ranks, fetched := drawFixture(t, "4", 15, 7, outside)
	got := buildDrawTool("28", "4", "SH", ranks, fetched)
	if !got.SimulationReady || !got.Complete || !got.OfficialDrawApplied || got.HistoricalRemovedGame != 1007 {
		t.Fatalf("draw state=%+v", got)
	}
	bonusCounts := map[float64]int{}
	for _, team := range got.Teams {
		bonusCounts[team.InitialBonus]++
	}
	if bonusCounts[5] != 4 || bonusCounts[3] != 4 || bonusCounts[0] != 4 {
		t.Fatalf("bonus counts=%v", bonusCounts)
	}
	if got.Teams[0].OutsideAdjustment != -2 || got.Teams[0].ConstantAdjustment != 3 {
		t.Fatalf("team adjustment=%+v", got.Teams[0])
	}
	// 被抽局里的负分属于该局最终分；反推常量时整局加回，不把 -1.5 当成赛外违规扣分。
	if got.Games[7].Scores[2] == nil || *got.Games[7].Scores[2] != -1.5 || got.Teams[2].OutsideAdjustment != 0 {
		t.Fatalf("removed negative score=%v team=%+v", got.Games[7].Scores[2], got.Teams[2])
	}
}

func TestBuildDrawToolInfersFinalDrawWithoutBonus(t *testing.T) {
	outside := make([]float64, 12)
	outside[5] = -1
	ranks, fetched := drawFixture(t, "5", 16, 11, outside)
	got := buildDrawTool("28", "5", "SH", ranks, fetched)
	if !got.SimulationReady || got.HistoricalRemovedGame != 1011 || got.ExpectedGames != 16 || got.CountedGames != 15 {
		t.Fatalf("draw=%+v", got)
	}
	for i, team := range got.Teams {
		if team.InitialBonus != 0 || team.OutsideAdjustment != outside[i] {
			t.Fatalf("team %d=%+v", i, team)
		}
	}
}

func TestBuildDrawToolKeepsScenarioWhenOneOfficialTotalIsMalformed(t *testing.T) {
	outside := make([]float64, 12)
	ranks, fetched := drawFixture(t, "5", 16, 11, outside)
	ranks[0].TotalPoint += 50
	got := buildDrawTool("28", "5", "SH", ranks, fetched)
	if !got.SimulationReady || got.HistoricalRemovedGame != 1011 {
		t.Fatalf("malformed total changed draw inference: %+v", got)
	}
	if len(got.Warnings) == 0 || !strings.Contains(strings.Join(got.Warnings, " "), "核对原始数据") {
		t.Fatalf("warnings=%v", got.Warnings)
	}
}

func TestBuildDrawToolAnchorsPartialEventAndAddsFutureGames(t *testing.T) {
	outside := make([]float64, 12)
	outside[9] = -1
	ranks, fetched := drawFixture(t, "4", 3, 1, outside)
	// Partial events have not drawn a game yet: restore official totals to sum + bonus + outside.
	for team := range ranks {
		ranks[team].TotalPoint += fetched[team].games[1].Point
	}
	got := buildDrawTool("28", "4", "SH", ranks, fetched)
	if !got.SimulationReady || got.Complete || got.CompletedGames != 3 || len(got.Games) != 15 || got.Games[3].Complete {
		t.Fatalf("partial=%+v", got)
	}
	if got.Teams[0].ConstantAdjustment != 5 || got.Teams[9].ConstantAdjustment != -1 {
		t.Fatalf("adjustments=%+v %+v", got.Teams[0], got.Teams[9])
	}
}

func TestBuildDrawToolWarnsAndStopsWhenOfficialRowsAreMissing(t *testing.T) {
	outside := make([]float64, 12)
	ranks, fetched := drawFixture(t, "5", 16, 11, outside)
	fetched[11].games = fetched[11].games[:15]
	got := buildDrawTool("28", "5", "SH", ranks, fetched)
	if got.SimulationReady {
		t.Fatal("simulation should stop when an official score is missing")
	}
	if len(got.Warnings) == 0 || !strings.Contains(strings.Join(got.Warnings, " "), "缺少 1 个门派局分") {
		t.Fatalf("warnings=%v", got.Warnings)
	}
}

func TestBuildDrawToolDeduplicatesPlayerGameRows(t *testing.T) {
	outside := make([]float64, 12)
	ranks, fetched := drawFixture(t, "4", 3, 1, outside)
	for team := range ranks {
		ranks[team].TotalPoint += fetched[team].games[1].Point
	}
	fetched[0].games = append(fetched[0].games, fetched[0].games[0])
	got := buildDrawTool("28", "4", "SH", ranks, fetched)
	if !got.SimulationReady || got.CompletedGames != 3 || got.Games[0].Scores[0] == nil || *got.Games[0].Scores[0] != fetched[0].games[0].Point {
		t.Fatalf("deduplicated draw=%+v", got)
	}
}

func TestLatestDrawScopeFallsBackToLatestSeasonWithFinals(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/system/dicts/suites/season":
			fmt.Fprint(w, `[{"value":"30","text":"S30"},{"value":"31","text":"S31"}]`)
		case "/system/dicts/suites/season.type":
			fmt.Fprint(w, `[{"value":"4","text":"季后赛"},{"value":"5","text":"总决赛"}]`)
		case "/stats/sect-stats":
			q := r.URL.Query()
			has := q.Get("season_type_id") == "" || (q.Get("season_id") == "30" && q.Get("season_type_id") == "5")
			if has {
				fmt.Fprint(w, `{"total_items":1,"items":[{}]}`)
			} else {
				fmt.Fprint(w, `{"total_items":0,"items":[]}`)
			}
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	c := huashan.New(fakeTP{tok: "GOOD"})
	c.Base = srv.URL
	season, seasonType, err := New(c, nil).latestDrawScope(context.Background(), "SH")
	if err != nil {
		t.Fatal(err)
	}
	if season != "30" || seasonType != "5" {
		t.Fatalf("latest draw scope = %s/%s, want 30/5", season, seasonType)
	}
}

type blockingDrawGames struct {
	release <-chan struct{}
	calls   atomic.Int32
}

func (g *blockingDrawGames) ZoneGames(context.Context, string, string) ([]player.Game, error) {
	return nil, nil
}

func (g *blockingDrawGames) EventGames(ctx context.Context, id, zone, season, seasonType string) ([]player.Game, error) {
	g.calls.Add(1)
	select {
	case <-g.release:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	playerID, _ := strconv.Atoi(id)
	team := playerID - 199
	return []player.Game{{
		GameID: 1000, PlayDate: "2026-08-01", Round: 1, SectID: team, PlayerID: playerID,
		SeasonID: 28, HasSeason: true, SeasonTypeID: 5, SectRaw: fmt.Sprintf("门派%d", team), SectBase: fmt.Sprintf("门派%d", team), Point: float64(team),
	}}, nil
}

func TestEventDrawToolCoalescesBackgroundPrewarmAndPageQuery(t *testing.T) {
	release := make(chan struct{})
	games := &blockingDrawGames{release: release}
	s := New(nil, games)
	key := eventProbeKey(eventProbe{season: "28", seasonType: "5", zone: "SH"})
	ranks := make([]SectRank, 12)
	players := make([]eventPlayerAggregate, 12)
	for i := range ranks {
		ranks[i] = SectRank{SectID: i + 1, SectName: fmt.Sprintf("门派%d", i+1), TotalPoint: float64(i + 1)}
		players[i] = eventPlayerAggregate{PlayerID: 200 + i, TotalRound: 1}
	}
	s.rankings[key] = &EventRankings{Season: "28", SeasonType: "5", Zone: "SH", Items: ranks}
	s.metricPages[key+"|1"] = &EventRankMetricPage{Page: 1, TotalPages: 1, players: players}

	var first, second *DrawTool
	var firstErr, secondErr error
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		first, firstErr = s.EventDrawTool(context.Background(), "28", "5", "SH")
	}()
	deadline := time.Now().Add(time.Second)
	for games.calls.Load() < 12 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if games.calls.Load() != 12 {
		t.Fatalf("prewarm game calls = %d, want 12", games.calls.Load())
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		second, secondErr = s.EventDrawTool(context.Background(), "28", "5", "SH")
	}()
	close(release)
	wg.Wait()
	if firstErr != nil || secondErr != nil || first == nil || second == nil {
		t.Fatalf("draw results first=%v/%v second=%v/%v", first, firstErr, second, secondErr)
	}
	if games.calls.Load() != 12 {
		t.Fatalf("coalesced game calls = %d, want 12", games.calls.Load())
	}
}
