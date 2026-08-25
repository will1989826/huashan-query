package event

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"huashanquery/internal/huashan"
	"huashanquery/internal/player"
	"huashanquery/internal/token"
)

// fakeTP 实现 huashan.TokenProvider；带鉴权的官方接口要求 "Bearer GOOD"。
type fakeTP struct{ tok string }

func (f fakeTP) Current() (string, string, token.Reason) { return f.tok, "n", token.ReasonOK }
func (f fakeTP) Refresh() (string, string, token.Reason) { return f.tok, "n", token.ReasonOK }

func TestEventsCatalogNormalizesAndCaches(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		switch r.URL.Path {
		case "/system/dicts/suites/season":
			fmt.Fprint(w, `[{"value":"30","text":"S30","ordering":1},{"value":"29","text":"S29","deleted":true}]`)
		case "/system/dicts/suites/season.type":
			fmt.Fprint(w, `[{"value":"4","text":"季后赛"}]`)
		case "/settings/editions":
			fmt.Fprint(w, `[{"value":18,"label":"侦探怪盗守卫","ordering":3}]`)
		case "/settings/rpts":
			fmt.Fprint(w, `[{"value":2,"label":"狼","camp":2}]`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	c := huashan.New(fakeTP{tok: "GOOD"})
	c.Base = srv.URL
	s := New(c, player.New(c, 10))

	got, err := s.EventsCatalog(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Seasons) != 1 || got.Seasons[0].Value != "30" || got.Seasons[0].Label != "S30" {
		t.Fatalf("seasons=%+v", got.Seasons)
	}
	if len(got.SeasonTypes) != 1 || got.SeasonTypes[0].Label != "季后赛" ||
		len(got.Editions) != 0 || len(got.Roles) != 0 || len(got.Zones) < 10 {
		t.Fatalf("catalog=%+v", got)
	}
	if got.Zones[0].Value != "SH" || eventOptionExists(got.Zones, "ALL") {
		t.Fatalf("zones=%+v", got.Zones)
	}
	if _, err := s.EventsCatalog(context.Background()); err != nil {
		t.Fatal(err)
	}
	if hits.Load() != 2 {
		t.Fatalf("catalog cache hits=%d want 2", hits.Load())
	}
}

func TestEventTeamIncludesHistoricalMembersWithoutLeakingRosterFields(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/werewolves/sects/13":
			fmt.Fprint(w, `{"id":13,"name":"鱼乐会","chief":{"name":"掌门甲"},"createTime":"2021-01-01"}`)
		case "/settings/players":
			if r.URL.Query().Get("sect_id") != "13" {
				t.Fatalf("sect_id=%q", r.URL.Query().Get("sect_id"))
			}
			fmt.Fprint(w, `[{"value":109,"label":"Will","mobile":"should-not-pass"}]`)
		case "/stats/sect-stats":
			fmt.Fprint(w, `{"total_items":2,"items":[{"sect_id":13,"sect_name":"鱼乐会","total_point":9},{"sect_id":99,"sect_name":"现门派","total_point":8}]}`)
		case "/stats/players/games":
			fmt.Fprint(w, `{"total_items":2,"items":[{"player_id":109,"player_name":"旧名字","total_round":2,"sects":[{"id":13},{"id":99}]},{"player_id":777,"player_name":"已离队成员","total_round":1,"sects":[{"id":13},{"id":99}]}]}`)
		case "/stats/players/games/109/details":
			if r.URL.Query().Get("zone_id") != "SD" {
				t.Fatalf("zone_id=%q", r.URL.Query().Get("zone_id"))
			}
			fmt.Fprint(w, `{"total_items":3,"items":[{"season_id":6,"season_type_id":3,"sect_name":"鱼乐会（鲁）","total_point":6,"win":1,"mvp":1},{"season_id":6,"season_type_id":3,"sect_name":"鱼乐会（鲁）","total_point":-1,"win":0,"svp":1,"bgx":1},{"season_id":6,"season_type_id":4,"sect_name":"鱼乐会（鲁）","total_point":99,"win":1}]}`)
		case "/stats/players/games/777/details":
			fmt.Fprint(w, `{"total_items":1,"items":[{"season_id":6,"season_type_id":3,"sect_name":"鱼乐会（鲁）","total_point":4,"win":1}]}`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	c := huashan.New(fakeTP{tok: "GOOD"})
	c.Base = srv.URL
	got, err := New(c, player.New(c, 10)).EventTeam(context.Background(), "13", "6", "3", "SD")
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != 13 || got.Name != "鱼乐会" || got.Chief != "掌门甲" || len(got.Members) != 2 || got.Members[0].Label != "Will" || got.Members[0].Matches != 2 {
		t.Fatalf("team=%+v", got)
	}
	member := got.Members[0]
	if member.TotalPoint != 5 || member.Avg != 2.5 || member.Win != 50 || member.MVP != 1 || member.SVP != 1 || member.BGX != 1 {
		t.Fatalf("member aggregates=%+v", member)
	}
	if got.Members[1].Value != "777" || got.Members[1].Label != "已离队成员" || got.Members[1].Matches != 1 {
		t.Fatalf("historical member=%+v", got.Members[1])
	}
	if strings.Contains(fmt.Sprintf("%+v", got), "should-not-pass") {
		t.Fatal("team response leaked an unapproved player field")
	}
}

func TestEventTeamDegradesWhenOptionalMetadataIsUnavailable(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/werewolves/sects/13", "/settings/players":
			http.Error(w, "temporary failure", http.StatusServiceUnavailable)
		case "/stats/sect-stats":
			fmt.Fprint(w, `{"total_items":1,"items":[{"sect_id":13,"sect_name":"历史门派","total_point":4}]}`)
		case "/stats/players/games":
			fmt.Fprint(w, `{"total_items":1,"items":[{"player_id":777,"player_name":"历史成员","total_round":1,"sects":[{"id":13}]}]}`)
		case "/stats/players/games/777/details":
			fmt.Fprint(w, `{"total_items":1,"items":[{"season_id":6,"season_type_id":3,"sect_name":"历史门派","total_point":4,"win":1}]}`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	c := huashan.New(fakeTP{tok: "GOOD"})
	c.Base = srv.URL
	got, err := New(c, player.New(c, 10)).EventTeam(context.Background(), "13", "6", "3", "SD")
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != 13 || got.Name != "历史门派" || len(got.Members) != 1 || got.Members[0].Label != "历史成员" || got.Members[0].TotalPoint != 4 {
		t.Fatalf("degraded team=%+v", got)
	}
}

func TestEventAvailabilityFiltersRealCombinationsAndCaches(t *testing.T) {
	var probes atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/system/dicts/suites/season":
			fmt.Fprint(w, `[{"value":"30","text":"S30"},{"value":"29","text":"S29"}]`)
		case "/system/dicts/suites/season.type":
			fmt.Fprint(w, `[{"value":"3","text":"常规赛"},{"value":"4","text":"季后赛"}]`)
		case "/settings/editions", "/settings/rpts":
			fmt.Fprint(w, `[]`)
		case "/stats/sect-stats":
			probes.Add(1)
			q := r.URL.Query()
			has := q.Get("season_id") == "29" &&
				(q.Get("zone_id") == "" || q.Get("zone_id") == "SD") &&
				(q.Get("season_type_id") == "" || q.Get("season_type_id") == "4")
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
	s := New(c, player.New(c, 10))
	rangeResult, err := s.EventSeasonsForZone(context.Background(), "SD")
	if err != nil {
		t.Fatal(err)
	}
	if rangeResult.Zone != "SD" || len(rangeResult.Seasons) != 1 || rangeResult.Seasons[0].Value != "29" {
		t.Fatalf("season range=%+v", rangeResult)
	}
	rangeProbes := probes.Load()
	if _, err := s.EventSeasonsForZone(context.Background(), "SD"); err != nil {
		t.Fatal(err)
	}
	if probes.Load() != rangeProbes {
		t.Fatalf("season range cache added %d probes", probes.Load()-rangeProbes)
	}

	got, err := s.EventAvailability(context.Background(), "29", "SD")
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Seasons) != 1 || got.Seasons[0].Value != "29" || len(got.SeasonTypes) != 1 || got.SeasonTypes[0].Value != "4" {
		t.Fatalf("availability=%+v", got)
	}
	if len(got.Zones) != 1 || got.Zones[0].Value != "SD" {
		t.Fatalf("zones=%+v", got.Zones)
	}
	first := probes.Load()
	if _, err := s.EventAvailability(context.Background(), "29", "SD"); err != nil {
		t.Fatal(err)
	}
	if probes.Load() != first {
		t.Fatalf("availability cache added %d probes", probes.Load()-first)
	}
}

func TestEventSectRankingsFiltersSortsAndPaginates(t *testing.T) {
	var pages atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/stats/sect-stats" {
			http.NotFound(w, r)
			return
		}
		if r.URL.Query().Get("season_id") != "29" || r.URL.Query().Get("season_type_id") != "4" || r.URL.Query().Get("zone_id") != "SD" {
			t.Fatalf("query=%s", r.URL.RawQuery)
		}
		page := r.URL.Query().Get("page")
		pages.Add(1)
		if page == "1" {
			items := strings.TrimSuffix(strings.Repeat(`{"sect_id":1,"sect_name":"乙队","total_point":1,"mvp":0,"svp":0,"bgx":0},`, eventPageSize), ",")
			fmt.Fprintf(w, `{"total_items":501,"items":[%s]}`, items)
			return
		}
		fmt.Fprint(w, `{"total_items":501,"items":[{"sect_id":2,"sect_name":"甲队","total_point":99.5,"mvp":2,"svp":1,"bgx":0}]}`)
	}))
	defer srv.Close()
	c := huashan.New(fakeTP{tok: "GOOD"})
	c.Base = srv.URL
	got, err := New(c, player.New(c, 10)).EventSectRankings(context.Background(), "29", "4", "SD")
	if err != nil {
		t.Fatal(err)
	}
	if pages.Load() != 2 || len(got.Items) != 501 || got.Items[0].SectName != "甲队" || got.Items[0].Rank != 1 || got.Items[0].TotalPoint != 99.5 {
		t.Fatalf("pages=%d rankings=%+v", pages.Load(), got.Items[:1])
	}
}

// 归属歧义（榜上命中 ≥2 个历史门派）的选手，按其本赛季本赛区最新一场定位真实门派后计入，不再整体丢弃。
func TestEventSectRankMetricsResolvesAmbiguousMembershipViaLatestGame(t *testing.T) {
	var detailCalls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/stats/sect-stats":
			fmt.Fprint(w, `{"total_items":3,"items":[{"sect_id":1,"sect_name":"甲队","total_point":10},{"sect_id":2,"sect_name":"乙队","total_point":20},{"sect_id":3,"sect_name":"丙队","total_point":6}]}`)
		case "/stats/players/games":
			// 101 榜上命中甲、乙两队（歧义）；102 只命中丙队（唯一）。
			fmt.Fprint(w, `{"total_items":2,"items":[{"player_id":101,"total_round":3,"sects":[{"id":1},{"id":2}]},{"player_id":102,"total_round":3,"sects":[{"id":3}]}]}`)
		case "/stats/players/games/101/details":
			detailCalls.Add(1)
			if r.URL.Query().Get("size") != "1" || r.URL.Query().Get("season_id") != "29" || r.URL.Query().Get("zone_id") != "SD" {
				t.Fatalf("scoped latest-game query=%s", r.URL.RawQuery)
			}
			// 最新一场带赛区后缀，回连时按基名归并到“甲队”。
			fmt.Fprint(w, `{"total_items":3,"items":[{"season_id":29,"sect_name":"甲队（鲁）"}]}`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	c := huashan.New(fakeTP{tok: "GOOD"})
	c.Base = srv.URL
	svc := New(c, player.New(c, 10))
	m, err := svc.EventSectRankMetrics(context.Background(), "29", "3", "SD")
	if err != nil {
		t.Fatal(err)
	}
	if !m.MetricsAvailable || m.MetricsIncomplete {
		t.Fatalf("metrics=%+v", m)
	}
	byID := map[int]EventSectMetric{}
	for _, it := range m.Items {
		byID[it.SectID] = it
	}
	// 101 归到甲队 → 甲队 3 轮=1 天 avg=10；乙队无人=不出现；丙队 3 轮=1 天 avg=6。
	if s1 := byID[1]; s1.Days != 1 || s1.Avg != 10 {
		t.Fatalf("sect1=%+v", s1)
	}
	if _, ok := byID[2]; ok {
		t.Fatalf("sect2 should have no rounds: %+v", byID[2])
	}
	if s3 := byID[3]; s3.Days != 1 || s3.Avg != 6 {
		t.Fatalf("sect3=%+v", s3)
	}
	// 归属结果按 季|赛区|选手 缓存：再算一次不应重复补查逐场。
	if _, err := svc.EventSectRankMetrics(context.Background(), "29", "3", "SD"); err != nil {
		t.Fatal(err)
	}
	if detailCalls.Load() != 1 {
		t.Fatalf("ambiguous latest-game lookups=%d want 1 (cached)", detailCalls.Load())
	}
}

// 歧义选手补查失败（非 401）时不计入该选手，并标记 incomplete；其余门派照常计算，门派总分不受影响。
func TestEventSectRankMetricsMarksIncompleteWhenAmbiguousLookupFails(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/stats/sect-stats":
			fmt.Fprint(w, `{"total_items":2,"items":[{"sect_id":1,"sect_name":"甲队","total_point":10},{"sect_id":2,"sect_name":"乙队","total_point":20}]}`)
		case "/stats/players/games":
			fmt.Fprint(w, `{"total_items":1,"items":[{"player_id":101,"total_round":3,"sects":[{"id":1},{"id":2}]}]}`)
		case "/stats/players/games/101/details":
			http.Error(w, "temporary failure", http.StatusServiceUnavailable)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	c := huashan.New(fakeTP{tok: "GOOD"})
	c.Base = srv.URL
	m, err := New(c, player.New(c, 10)).EventSectRankMetrics(context.Background(), "29", "3", "SD")
	if err != nil {
		t.Fatal(err)
	}
	if m.MetricsAvailable || !m.MetricsIncomplete || len(m.Items) != 0 {
		t.Fatalf("metrics=%+v", m)
	}
}

func TestEnrichFromRoundsCountsPartialRoundBlockAsPlayedDay(t *testing.T) {
	ranks := []SectRank{{SectID: 1, TotalPoint: 9}}
	if available := enrichFromRounds(ranks, []int{4}, "day"); !available || ranks[0].Days != 2 || ranks[0].Avg != 4.5 {
		t.Fatalf("available=%v ranks=%+v", available, ranks)
	}
}

func TestEnrichFromRoundsUsesGameAverageOutsideRegularSeason(t *testing.T) {
	ranks := []SectRank{{SectID: 1, TotalPoint: 9}}
	if available := enrichFromRounds(ranks, []int{2}, "game"); !available || ranks[0].Games != 2 || ranks[0].Days != 0 || ranks[0].Avg != 4.5 {
		t.Fatalf("available=%v ranks=%+v", available, ranks)
	}
}

func TestEventMetricModeFollowsSeasonFormat(t *testing.T) {
	for seasonType, want := range map[string]string{"2": "day", "3": "day", "4": "game", "5": "game", "": "game"} {
		if got := eventMetricMode(seasonType); got != want {
			t.Errorf("eventMetricMode(%q)=%q want %q", seasonType, got, want)
		}
	}
}

func TestEventSectRankMetricPageLoadsAndCachesOneUpstreamPage(t *testing.T) {
	var playerCalls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/stats/sect-stats":
			fmt.Fprint(w, `{"total_items":1,"items":[{"sect_id":1,"sect_name":"甲队","total_point":9}]}`)
		case "/stats/players/games":
			playerCalls.Add(1)
			if r.URL.Query().Get("size") != "500" {
				t.Fatalf("size=%q", r.URL.Query().Get("size"))
			}
			if r.URL.Query().Get("page") == "1" {
				fmt.Fprint(w, `{"total_items":501,"items":[{"player_id":101,"total_round":3,"sects":[{"id":1}]}]}`)
			} else {
				fmt.Fprint(w, `{"total_items":501,"items":[{"player_id":102,"total_round":2,"sects":[{"id":1}]}]}`)
			}
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	c := huashan.New(fakeTP{tok: "GOOD"})
	c.Base = srv.URL
	svc := New(c, player.New(c, 10))
	first, err := svc.EventSectRankMetricPage(context.Background(), "29", "3", "SD", 1)
	if err != nil {
		t.Fatal(err)
	}
	second, err := svc.EventSectRankMetricPage(context.Background(), "29", "3", "SD", 2)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.EventSectRankMetricPage(context.Background(), "29", "3", "SD", 1); err != nil {
		t.Fatal(err)
	}
	if first.TotalPages != 2 || second.TotalPages != 2 || !first.HasMore || second.HasMore || len(first.Items) != 1 || first.Items[0].Rounds != 3 || second.Items[0].Rounds != 2 || playerCalls.Load() != 2 {
		t.Fatalf("first=%+v second=%+v calls=%d", first, second, playerCalls.Load())
	}
}

func TestEventRankingsRejectAllZones(t *testing.T) {
	c := huashan.New(fakeTP{tok: "GOOD"})
	s := New(c, player.New(c, 10))
	if _, err := s.EventSectRankings(context.Background(), "29", "3", "ALL"); err == nil {
		t.Fatal("ALL zone accepted")
	}
}

// EventSectRankMetrics 应在服务端聚合所有选手轮次分页，并按赛制换算（常规赛 3 局=1 天）。
func TestEventSectRankMetricsAggregatesAllPages(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/stats/sect-stats":
			fmt.Fprint(w, `{"total_items":2,"items":[{"sect_id":1,"sect_name":"甲队","total_point":12},{"sect_id":2,"sect_name":"乙队","total_point":6}]}`)
		case "/stats/players/games":
			if r.URL.Query().Get("page") == "1" {
				fmt.Fprint(w, `{"total_items":501,"items":[{"player_id":101,"player_name":"甲选手","total_round":3,"total_point":9,"average_point":3,"mvp_qty":2,"svp_qty":1,"bgx_qty":0,"sects":[{"id":1}]},{"player_id":103,"player_name":"丙选手","total_round":4,"total_point":8,"average_point":2,"mvp_qty":0,"svp_qty":0,"bgx_qty":1,"sects":[{"id":2}]}]}`)
			} else {
				fmt.Fprint(w, `{"total_items":501,"items":[{"player_id":102,"player_name":"乙选手","total_round":3,"total_point":6,"average_point":2,"mvp_qty":0,"svp_qty":2,"bgx_qty":0,"sects":[{"id":1}]}]}`)
			}
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	c := huashan.New(fakeTP{tok: "GOOD"})
	c.Base = srv.URL
	m, err := New(c, player.New(c, 10)).EventSectRankMetrics(context.Background(), "29", "3", "SD")
	if err != nil {
		t.Fatal(err)
	}
	if m.MetricMode != "day" || !m.MetricsAvailable || len(m.Items) != 2 {
		t.Fatalf("metrics=%+v", m)
	}
	if !m.PlayersAvailable || len(m.Players) != 3 {
		t.Fatalf("players=%+v", m.Players)
	}
	byID := map[int]EventSectMetric{}
	for _, it := range m.Items {
		byID[it.SectID] = it
	}
	// 甲队 3+3=6 轮 → ceil(6/3)=2 天，avg=12/2=6；乙队 4 轮 → ceil(4/3)=2 天，avg=6/2=3。
	if s1 := byID[1]; s1.Days != 2 || s1.Games != 0 || s1.Avg != 6 {
		t.Fatalf("sect1=%+v", s1)
	}
	if s2 := byID[2]; s2.Days != 2 || s2.Avg != 3 {
		t.Fatalf("sect2=%+v", s2)
	}
	if p := m.Players[0]; p.Rank != 1 || p.PlayerID != 101 || p.Games != 3 || p.Days != 1 || p.TotalPoint != 9 || p.Avg != 9 || p.MVP != 2 || p.SVP != 1 || p.BGX != 0 {
		t.Fatalf("first player=%+v", p)
	}
	if p := m.Players[1]; p.Rank != 2 || p.PlayerID != 103 || p.Days != 2 || p.Avg != 4 || p.BGX != 1 {
		t.Fatalf("second player=%+v", p)
	}
}

// 全部比赛类型（空 type）混合赛制、无统一天数/场次口径：不计算派生指标，也不去拉选手汇总。
func TestEventSectRankMetricsSkipsAllTypes(t *testing.T) {
	var playerCalls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/stats/sect-stats":
			fmt.Fprint(w, `{"total_items":1,"items":[{"sect_id":1,"sect_name":"甲队","total_point":12}]}`)
		case "/stats/players/games":
			playerCalls.Add(1)
			fmt.Fprint(w, `[]`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	c := huashan.New(fakeTP{tok: "GOOD"})
	c.Base = srv.URL
	m, err := New(c, player.New(c, 10)).EventSectRankMetrics(context.Background(), "29", "", "SD")
	if err != nil {
		t.Fatal(err)
	}
	if m.MetricsAvailable || len(m.Items) != 0 {
		t.Fatalf("all-types metrics should be unavailable: %+v", m)
	}
	if playerCalls.Load() != 0 {
		t.Fatalf("all-types should not fetch player aggregates, calls=%d", playerCalls.Load())
	}
}

// 刷新比赛类型只探测本赛区本赛季的各比赛类型，不连带探测其它赛区/赛季。
func TestEventSeasonTypesForScopeProbesOnlyTypes(t *testing.T) {
	var typeProbes, otherProbes atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/system/dicts/suites/season":
			fmt.Fprint(w, `[{"value":"29","text":"S29"},{"value":"30","text":"S30"}]`)
		case "/system/dicts/suites/season.type":
			fmt.Fprint(w, `[{"value":"3","text":"常规赛"},{"value":"4","text":"季后赛"}]`)
		case "/stats/sect-stats":
			q := r.URL.Query()
			if q.Get("season_type_id") != "" && q.Get("season_id") == "29" && q.Get("zone_id") == "SD" {
				typeProbes.Add(1)
				if q.Get("season_type_id") == "4" {
					fmt.Fprint(w, `{"total_items":1,"items":[{}]}`)
					return
				}
			} else {
				otherProbes.Add(1)
			}
			fmt.Fprint(w, `{"total_items":0,"items":[]}`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	c := huashan.New(fakeTP{tok: "GOOD"})
	c.Base = srv.URL
	types, err := New(c, player.New(c, 10)).EventSeasonTypesForScope(context.Background(), "29", "SD")
	if err != nil {
		t.Fatal(err)
	}
	if len(types) != 1 || types[0].Value != "4" {
		t.Fatalf("types=%+v", types)
	}
	if typeProbes.Load() != 2 || otherProbes.Load() != 0 {
		t.Fatalf("expected 2 type-only probes, got type=%d other=%d", typeProbes.Load(), otherProbes.Load())
	}
}

func TestEventInputsRejectInvalidIDs(t *testing.T) {
	c := huashan.New(fakeTP{tok: "GOOD"})
	s := New(c, player.New(c, 10))
	if _, err := s.EventTeam(context.Background(), "../13", "6", "3", "SD"); err == nil {
		t.Fatal("invalid team id accepted")
	}
	if _, err := s.EventSectRankings(context.Background(), "", "4", "ALL"); err == nil {
		t.Fatal("empty season accepted")
	}
	if _, err := s.EventAvailability(context.Background(), "29", "unknown"); err == nil {
		t.Fatal("unknown zone accepted")
	}
}
