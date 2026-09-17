package main

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"
	"time"

	"huashanquery/internal/player"
)

func TestDefaultPlayerIDs(t *testing.T) {
	got, err := parseIDs(defaultIDsCSV)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"6964", "3444", "1209", "9137", "734", "109", "73", "7781", "7598", "8528", "6078", "7668"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("IDs=%v want %v", got, want)
	}
}

func TestParseIDsAcceptsHashesWhitespaceAndDeduplicates(t *testing.T) {
	got, err := parseIDs("#109, 73\n#109；00734")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"109", "73", "734"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("IDs=%v want %v", got, want)
	}
	if _, err := parseIDs("#0,nope"); err == nil {
		t.Fatal("invalid IDs were accepted")
	}
}

func TestParseConfigRejectsReplaySelectionForTierOne(t *testing.T) {
	_, err := parseConfig([]string{"-tier", "1", "-replay-since", "2026-01-01"}, time.Unix(0, 0))
	if err == nil {
		t.Fatal("tier 1 accepted replay selection flags")
	}
}

func TestSelectReplayCandidatesFiltersLimitsAndDeduplicates(t *testing.T) {
	row := func(gameID int, date string) json.RawMessage {
		b, _ := json.Marshal(map[string]any{"game_id": gameID, "play_date": date})
		return b
	}
	records := []playerRecord{
		{ID: "1", Detail: &player.DetailView{Games: []json.RawMessage{row(10, "2026-09-03"), row(9, "2026-09-02"), row(8, "2025-01-01")}}},
		{ID: "2", Detail: &player.DetailView{Games: []json.RawMessage{row(11, "2026-09-04"), row(10, "2026-09-03")}}},
	}
	got, coverage := selectReplayCandidates(records, "2026-01-01", 2)
	want := []replayCandidate{{GameID: 11, Date: "2026-09-04"}, {GameID: 10, Date: "2026-09-03"}, {GameID: 9, Date: "2026-09-02"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("candidates=%v want %v", got, want)
	}
	if coverage.EligiblePlayerGameRows != 4 || coverage.SelectedPlayerGameRows != 4 || coverage.UniqueSelectedGames != 3 || coverage.FullCareerSelection {
		t.Fatalf("coverage=%+v", coverage)
	}
}

type fakeDataService struct {
	details map[string]*player.DetailView
	errors  map[string]error
}

func (f fakeDataService) Detail(_ context.Context, query player.Query) (*player.DetailView, error) {
	return f.details[query.ID], f.errors[query.ID]
}

func (fakeDataService) Game(_ context.Context, _ string) ([]byte, error) { return nil, nil }

func TestFetchPlayersPreservesRequestedOrder(t *testing.T) {
	service := fakeDataService{details: map[string]*player.DetailView{
		"2": {Player: player.PlayerInfo{ID: "2", Name: "two"}},
		"1": {Player: player.PlayerInfo{ID: "1", Name: "one"}},
	}}
	cfg := config{IDs: []string{"2", "1"}, Zone: "ALL", Workers: 2, RequestTimeout: time.Second}
	got := fetchPlayers(context.Background(), service, cfg)
	if got[0].ID != "2" || got[0].Detail.Player.Name != "two" || got[1].ID != "1" || got[1].Detail.Player.Name != "one" {
		t.Fatalf("records=%+v", got)
	}
}

func TestCollectDatasetMarksInvalidReplayRowsIncomplete(t *testing.T) {
	service := fakeDataService{details: map[string]*player.DetailView{
		"1": {Player: player.PlayerInfo{ID: "1"}, Games: []json.RawMessage{json.RawMessage(`{"play_date":"2026-09-01"}`)}, GamesTotalKnown: true},
	}}
	cfg := config{IDs: []string{"1"}, Zone: "ALL", Tier: 2, Workers: 1, RequestTimeout: time.Second}
	got := collectDataset(context.Background(), service, cfg, time.Unix(0, 0))
	if got.Complete || got.ReplayCoverage == nil || got.ReplayCoverage.InvalidGameRows != 1 {
		t.Fatalf("dataset=%+v coverage=%+v", got, got.ReplayCoverage)
	}
}
