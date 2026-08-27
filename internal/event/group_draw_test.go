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
)

func TestGroupDrawRankingUsesStableTieBreakers(t *testing.T) {
	teams := []GroupDrawTeam{
		{SectID: 1, SectName: "Echo", TotalPoint: 10, MVP: 1, SVP: 1, BGX: 1},
		{SectID: 2, SectName: "Delta", TotalPoint: 10, MVP: 2},
		{SectID: 3, SectName: "Charlie", TotalPoint: 10, MVP: 1, SVP: 2},
		{SectID: 4, SectName: "Bravo", TotalPoint: 10, MVP: 1, SVP: 1, BGX: 0},
		{SectID: 5, SectName: "Alpha", TotalPoint: 10, MVP: 1, SVP: 1, BGX: 1},
	}
	rankGroupDrawTeams(teams)
	want := []int{2, 3, 4, 1, 5}
	for i, id := range want {
		if teams[i].SectID != id || teams[i].Rank != i+1 {
			t.Fatalf("ranked[%d]=%+v want sect %d rank %d", i, teams[i], id, i+1)
		}
	}
}

func TestEventGroupDrawDoesNotFetchPlayerStatsForTies(t *testing.T) {
	var playerStatsHits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/stats/sect-stats":
			var items []string
			for i := 1; i <= 25; i++ {
				items = append(items, fmt.Sprintf(`{"sect_id":%d,"sect_name":"Team %02d","total_point":100}`, i, i))
			}
			fmt.Fprintf(w, `{"total_items":25,"items":[%s]}`, strings.Join(items, ","))
		case "/stats/players/games":
			playerStatsHits.Add(1)
			fmt.Fprint(w, `[]`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	c := huashan.New(fakeTP{tok: "GOOD"})
	c.Base = srv.URL
	got, err := New(c, player.New(c, 10)).EventGroupDraw(context.Background(), "30", "3", "SH")
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Teams) != 25 || got.Teams[0].SectID != 1 || got.Teams[24].SectID != 25 {
		t.Fatalf("teams=%+v", got.Teams)
	}
	if playerStatsHits.Load() != 0 {
		t.Fatalf("player stats hits=%d want 0", playerStatsHits.Load())
	}
}
