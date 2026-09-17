// player-data fetches reproducible T0/T1 player datasets and optional T2 replays.
// It reads the Huashan login token from local WeChat storage or an environment
// variable and never writes the token into the output dataset.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"huashanquery/internal/huashan"
	"huashanquery/internal/player"
	"huashanquery/internal/token"
	"huashanquery/internal/wechat"
)

const (
	defaultIDsCSV = "6964,3444,1209,9137,734,109,73,7781,7598,8528,6078,7668"
	tokenEnvName  = "HUASHAN_QUERY_TOKEN"
)

type config struct {
	IDs                []string
	Zone               string
	Season             string
	Tier               int
	Workers            int
	RequestTimeout     time.Duration
	MaxTokenAgeDays    int
	ReplaySince        string
	ReplayMaxPerPlayer int
	Output             string
}

type dataService interface {
	Detail(context.Context, player.Query) (*player.DetailView, error)
	Game(context.Context, string) ([]byte, error)
}

type dataset struct {
	SchemaVersion  int             `json:"schema_version"`
	FetchedAt      string          `json:"fetched_at"`
	DataTiers      []string        `json:"data_tiers"`
	Scope          datasetScope    `json:"scope"`
	RequestedIDs   []string        `json:"requested_ids"`
	Players        []playerRecord  `json:"players"`
	ReplayCoverage *replayCoverage `json:"replay_coverage,omitempty"`
	Replays        []replayRecord  `json:"replays,omitempty"`
	Complete       bool            `json:"complete"`
	Notes          []string        `json:"notes"`
}

type datasetScope struct {
	Zone   string `json:"zone"`
	Season string `json:"season,omitempty"`
}

type playerRecord struct {
	ID     string             `json:"id"`
	Detail *player.DetailView `json:"detail,omitempty"`
	Error  string             `json:"error,omitempty"`
}

type replayCoverage struct {
	Since                  string `json:"since,omitempty"`
	MaxPerPlayer           int    `json:"max_per_player"`
	EligiblePlayerGameRows int    `json:"eligible_player_game_rows"`
	SelectedPlayerGameRows int    `json:"selected_player_game_rows"`
	UniqueSelectedGames    int    `json:"unique_selected_games"`
	FetchedGames           int    `json:"fetched_games"`
	FailedGames            int    `json:"failed_games"`
	InvalidGameRows        int    `json:"invalid_game_rows"`
	FullCareerSelection    bool   `json:"full_career_selection"`
}

type replayRecord struct {
	GameID int             `json:"game_id"`
	Data   json.RawMessage `json:"data,omitempty"`
	Error  string          `json:"error,omitempty"`
}

type replayCandidate struct {
	GameID int
	Date   string
}

func main() {
	if err := run(os.Args[1:], time.Now()); err != nil {
		fmt.Fprintln(os.Stderr, "player-data failed:", err)
		os.Exit(1)
	}
}

func run(args []string, now time.Time) error {
	cfg, err := parseConfig(args, now)
	if err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}

	mgr := &token.Manager{Sources: localTokenSources(cfg.MaxTokenAgeDays)}
	authSource := "local_wechat"
	if raw := strings.TrimSpace(os.Getenv(tokenEnvName)); raw != "" {
		_, _, reason := mgr.SetManual(raw)
		if reason != token.ReasonOK {
			return fmt.Errorf("token from %s was rejected: %s", tokenEnvName, reason)
		}
		authSource = "environment"
	} else {
		_, _, reason := mgr.Current()
		if reason != token.ReasonOK {
			return fmt.Errorf("no valid local WeChat token: %s", reason)
		}
	}

	client := huashan.New(mgr)
	service := player.New(client, len(cfg.IDs)+2)
	data := collectDataset(context.Background(), service, cfg, now)
	data.Notes = append(data.Notes,
		"Authentication source: "+authSource+"; the token value is never serialized.",
		"Official summary and full game-detail endpoints may include different competition scopes; keep their round totals separate.",
	)

	if err := writeDataset(cfg.Output, data); err != nil {
		return err
	}
	if cfg.Output != "-" {
		absolute, _ := filepath.Abs(cfg.Output)
		fmt.Printf("Wrote %s (players=%d, tiers=%s, complete=%t)\n", absolute, len(data.Players), strings.Join(data.DataTiers, ","), data.Complete)
	}
	if !data.Complete {
		return errors.New("dataset was written but one or more requested fetches were incomplete")
	}
	return nil
}

func parseConfig(args []string, now time.Time) (config, error) {
	fs := flag.NewFlagSet("player-data", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	idsFlag := fs.String("ids", defaultIDsCSV, "comma/space separated player IDs; a leading # is allowed")
	zone := fs.String("zone", "ALL", "zone ID or ALL")
	season := fs.String("season", "", "optional season ID")
	tier := fs.Int("tier", 1, "data tier: 1 fetches summaries and all game rows; 2 also fetches selected replays")
	workers := fs.Int("workers", 4, "maximum concurrent upstream requests (1-16)")
	requestTimeout := fs.Duration("request-timeout", 4*time.Minute, "timeout for each player or replay request")
	maxTokenAgeDays := fs.Int("token-max-age-days", 3, "maximum age of local WeChat token files; 0 disables age filtering")
	replaySince := fs.String("replay-since", "", "for tier 2, include replays on or after YYYY-MM-DD")
	replayMax := fs.Int("replay-max-per-player", 0, "for tier 2, newest replay rows per player; 0 means all")
	out := fs.String("out", "", "output JSON path; default is analysis-output/players-<timestamp>.json; use - for stdout")
	if err := fs.Parse(args); err != nil {
		return config{}, err
	}
	ids, err := parseIDs(*idsFlag)
	if err != nil {
		return config{}, err
	}
	if *tier != 1 && *tier != 2 {
		return config{}, fmt.Errorf("tier must be 1 or 2, got %d", *tier)
	}
	if *workers < 1 || *workers > 16 {
		return config{}, fmt.Errorf("workers must be between 1 and 16, got %d", *workers)
	}
	if *requestTimeout <= 0 {
		return config{}, errors.New("request-timeout must be positive")
	}
	if *maxTokenAgeDays < 0 {
		return config{}, errors.New("token-max-age-days cannot be negative")
	}
	if *replayMax < 0 {
		return config{}, errors.New("replay-max-per-player cannot be negative")
	}
	if *tier == 1 && (*replaySince != "" || *replayMax != 0) {
		return config{}, errors.New("replay selection flags require tier 2")
	}
	if *replaySince != "" {
		if _, err := time.Parse("2006-01-02", *replaySince); err != nil {
			return config{}, fmt.Errorf("replay-since must use YYYY-MM-DD: %w", err)
		}
	}
	if strings.TrimSpace(*zone) == "" {
		return config{}, errors.New("zone cannot be empty")
	}
	output := *out
	if output == "" {
		output = filepath.Join("analysis-output", "players-"+now.Format("20060102-150405")+".json")
	}
	return config{
		IDs: ids, Zone: strings.TrimSpace(*zone), Season: strings.TrimSpace(*season), Tier: *tier,
		Workers: *workers, RequestTimeout: *requestTimeout, MaxTokenAgeDays: *maxTokenAgeDays,
		ReplaySince: *replaySince, ReplayMaxPerPlayer: *replayMax, Output: output,
	}, nil
}

func parseIDs(raw string) ([]string, error) {
	parts := strings.FieldsFunc(raw, func(r rune) bool {
		return r == ',' || r == ';' || r == '，' || r == '；' || r == '\n' || r == '\r' || r == '\t' || r == ' '
	})
	seen := make(map[string]bool, len(parts))
	ids := make([]string, 0, len(parts))
	for _, part := range parts {
		id := strings.TrimPrefix(strings.TrimSpace(part), "#")
		n, err := strconv.ParseUint(id, 10, 64)
		if err != nil || n == 0 {
			return nil, fmt.Errorf("invalid player ID %q", part)
		}
		id = strconv.FormatUint(n, 10)
		if !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	if len(ids) == 0 {
		return nil, errors.New("at least one player ID is required")
	}
	return ids, nil
}

func localTokenSources(maxAgeDays int) []token.Source {
	if runtime.GOOS != "windows" && runtime.GOOS != "darwin" {
		return nil
	}
	return []token.Source{&wechat.Store{MaxAgeDays: maxAgeDays}}
}

func collectDataset(ctx context.Context, service dataService, cfg config, now time.Time) dataset {
	data := dataset{
		SchemaVersion: 1,
		FetchedAt:     now.Format(time.RFC3339),
		DataTiers:     []string{"T0", "T1"},
		Scope:         datasetScope{Zone: cfg.Zone, Season: cfg.Season},
		RequestedIDs:  append([]string(nil), cfg.IDs...),
		Players:       fetchPlayers(ctx, service, cfg),
		Complete:      true,
	}
	for _, record := range data.Players {
		if record.Error != "" || record.Detail == nil || record.Detail.StatsError != "" || record.Detail.GamesError != "" || record.Detail.GamesTrunc || !record.Detail.GamesTotalKnown {
			data.Complete = false
		}
	}
	if cfg.Tier == 2 {
		data.DataTiers = append(data.DataTiers, "T2")
		candidates, coverage := selectReplayCandidates(data.Players, cfg.ReplaySince, cfg.ReplayMaxPerPlayer)
		if coverage.InvalidGameRows > 0 {
			data.Complete = false
		}
		data.Replays = fetchReplays(ctx, service, candidates, cfg.Workers, cfg.RequestTimeout)
		for _, replay := range data.Replays {
			if replay.Error != "" {
				coverage.FailedGames++
				data.Complete = false
			} else {
				coverage.FetchedGames++
			}
		}
		data.ReplayCoverage = &coverage
	}
	return data
}

func fetchPlayers(ctx context.Context, service dataService, cfg config) []playerRecord {
	records := make([]playerRecord, len(cfg.IDs))
	sem := make(chan struct{}, cfg.Workers)
	var wg sync.WaitGroup
	for i, id := range cfg.IDs {
		wg.Add(1)
		go func(index int, playerID string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			requestCtx, cancel := context.WithTimeout(ctx, cfg.RequestTimeout)
			defer cancel()
			detail, err := service.Detail(requestCtx, player.Query{ID: playerID, Zone: cfg.Zone, Season: cfg.Season})
			records[index] = playerRecord{ID: playerID, Detail: detail}
			if err != nil {
				records[index].Error = err.Error()
			}
		}(i, id)
	}
	wg.Wait()
	return records
}

func selectReplayCandidates(records []playerRecord, since string, maxPerPlayer int) ([]replayCandidate, replayCoverage) {
	coverage := replayCoverage{Since: since, MaxPerPlayer: maxPerPlayer, FullCareerSelection: since == "" && maxPerPlayer == 0}
	selected := make(map[int]replayCandidate)
	for _, record := range records {
		if record.Detail == nil {
			continue
		}
		rows := make([]replayCandidate, 0, len(record.Detail.Games))
		for _, raw := range record.Detail.Games {
			var wire struct {
				GameID   int    `json:"game_id"`
				PlayDate string `json:"play_date"`
			}
			if json.Unmarshal(raw, &wire) != nil || wire.GameID <= 0 || (since != "" && wire.PlayDate == "") {
				coverage.InvalidGameRows++
				continue
			}
			if since != "" && wire.PlayDate < since {
				continue
			}
			rows = append(rows, replayCandidate{GameID: wire.GameID, Date: wire.PlayDate})
		}
		coverage.EligiblePlayerGameRows += len(rows)
		sort.SliceStable(rows, func(i, j int) bool {
			if rows[i].Date != rows[j].Date {
				return rows[i].Date > rows[j].Date
			}
			return rows[i].GameID > rows[j].GameID
		})
		if maxPerPlayer > 0 && len(rows) > maxPerPlayer {
			rows = rows[:maxPerPlayer]
		}
		coverage.SelectedPlayerGameRows += len(rows)
		for _, row := range rows {
			if existing, ok := selected[row.GameID]; !ok || row.Date > existing.Date {
				selected[row.GameID] = row
			}
		}
	}
	candidates := make([]replayCandidate, 0, len(selected))
	for _, candidate := range selected {
		candidates = append(candidates, candidate)
	}
	sort.Slice(candidates, func(i, j int) bool {
		if candidates[i].Date != candidates[j].Date {
			return candidates[i].Date > candidates[j].Date
		}
		return candidates[i].GameID > candidates[j].GameID
	})
	coverage.UniqueSelectedGames = len(candidates)
	return candidates, coverage
}

func fetchReplays(ctx context.Context, service dataService, candidates []replayCandidate, workers int, timeout time.Duration) []replayRecord {
	records := make([]replayRecord, len(candidates))
	sem := make(chan struct{}, workers)
	var wg sync.WaitGroup
	for i, candidate := range candidates {
		wg.Add(1)
		go func(index int, gameID int) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			requestCtx, cancel := context.WithTimeout(ctx, timeout)
			defer cancel()
			raw, err := service.Game(requestCtx, strconv.Itoa(gameID))
			records[index] = replayRecord{GameID: gameID, Data: raw}
			if err != nil {
				records[index].Data = nil
				records[index].Error = err.Error()
			}
		}(i, candidate.GameID)
	}
	wg.Wait()
	return records
}

func writeDataset(path string, data dataset) error {
	b, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return fmt.Errorf("encode dataset: %w", err)
	}
	b = append(b, '\n')
	if path == "-" {
		_, err = os.Stdout.Write(b)
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("create output directory: %w", err)
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("create output file (choose a new path if it already exists): %w", err)
	}
	if _, err := f.Write(b); err != nil {
		_ = f.Close()
		_ = os.Remove(path)
		return fmt.Errorf("write output file: %w", err)
	}
	if err := f.Close(); err != nil {
		return fmt.Errorf("close output file: %w", err)
	}
	return nil
}
