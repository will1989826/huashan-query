// player-stats-crawl pulls the official player summary panels (summary/haoren/langren/power)
// for players already discovered in the local crawl database, and stores them back into MySQL.
//
// It is resumable and long-running:
//   - progress is recorded in player_stats_crawl_state
//   - finished snapshots live in player_stats
//   - when the token expires, the process can wait for a refreshed token file and continue
//
// The intended source of player IDs is the existing players table maintained by player-crawl.
// Scanning player IDs by incrementing integers is not the primary strategy because the upstream
// stats endpoint does not reliably return "not found" for missing IDs.
package main

import (
	"context"
	"database/sql"
	_ "embed"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	_ "github.com/go-sql-driver/mysql"

	"huashanquery/internal/huashan"
	"huashanquery/internal/token"
	"huashanquery/internal/wechat"
)

//go:embed schema.sql
var schemaSQL string

const tokenEnvName = "HUASHAN_QUERY_TOKEN"

type config struct {
	DSN               string
	Zone              string
	Season            string
	SeasonKey         int
	Token             string
	TokenFile         string
	Workers           int
	RequestInterval   time.Duration
	RequestTimeout    time.Duration
	TokenPollInterval time.Duration
	TokenMaxAgeDays   int
	IdlePollInterval  time.Duration
	BatchSize         int
	WaitToken         bool
	FollowPlayers     bool
	RetryErrors       bool
}

type crawler struct {
	cfg    config
	client *huashan.Client
	tokens interface {
		Refresh() (string, string, token.Reason)
	}
	db           *sql.DB
	runStartedAt time.Time
}

type statsSnapshot struct {
	Player struct {
		ID     int64  `json:"id"`
		Name   string `json:"name"`
		Avatar string `json:"avatar"`
	} `json:"player"`
	Joined  json.RawMessage `json:"joined_zone_ids"`
	Honors  json.RawMessage `json:"honors"`
	Summary json.RawMessage `json:"summary"`
	Haoren  json.RawMessage `json:"haoren"`
	Langren json.RawMessage `json:"langren"`
	Power   json.RawMessage `json:"power"`
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "player-stats-crawl failed:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	cfg, err := parseConfig(args)
	if err != nil {
		if err == flag.ErrHelp {
			return nil
		}
		return err
	}

	mgr := &token.Manager{Sources: tokenSources(cfg)}
	if _, _, reason := mgr.Current(); reason != token.ReasonOK {
		switch {
		case cfg.TokenFile != "":
			return fmt.Errorf("token from %s was rejected: %s", cfg.TokenFile, reason)
		case cfg.Token != "":
			return fmt.Errorf("token rejected: %s", reason)
		default:
			return fmt.Errorf("no valid token: %s", reason)
		}
	}

	client := huashan.New(mgr)
	client.MinInterval = cfg.RequestInterval

	db, err := sql.Open("mysql", cfg.DSN)
	if err != nil {
		return fmt.Errorf("open db: %w", err)
	}
	defer db.Close()
	db.SetMaxOpenConns(cfg.Workers + 2)
	db.SetConnMaxLifetime(time.Hour)

	pingCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := db.PingContext(pingCtx); err != nil {
		return fmt.Errorf("connect db: %w", err)
	}
	if err := ensureSchema(db); err != nil {
		return fmt.Errorf("apply schema: %w", err)
	}

	c := &crawler{
		cfg:          cfg,
		client:       client,
		tokens:       mgr,
		db:           db,
		runStartedAt: time.Now(),
	}
	return c.crawl(context.Background())
}

func parseConfig(args []string) (config, error) {
	fs := flag.NewFlagSet("player-stats-crawl", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	dsn := fs.String("dsn", "root@tcp(127.0.0.1:3306)/huashan?charset=utf8mb4&parseTime=true&loc=Local", "MySQL DSN")
	zone := fs.String("zone", "ALL", "scope zone ID or ALL")
	season := fs.String("season", "", "optional season ID")
	tokenFlag := fs.String("token", "", "Huashan login token (overrides "+tokenEnvName+")")
	tokenFile := fs.String("token-file", "", "path to a file containing the token")
	workers := fs.Int("workers", 2, "concurrent player stats fetches (1-16)")
	requestInterval := fs.Duration("request-interval", 2*time.Second, "minimum delay between upstream requests across the whole crawl")
	requestTimeout := fs.Duration("request-timeout", 45*time.Second, "timeout for one player stats request")
	tokenPollInterval := fs.Duration("token-poll-interval", 30*time.Second, "when the token expires, how often to poll for a fresh token")
	tokenMaxAgeDays := fs.Int("token-max-age-days", 3, "maximum age of local WeChat token files when scanning local fallbacks; 0 disables age filtering")
	idlePollInterval := fs.Duration("idle-poll-interval", time.Minute, "how often to poll for newly discovered players when caught up")
	batchSize := fs.Int("batch-size", 256, "number of pending players to claim per batch")
	waitToken := fs.Bool("wait-token", true, "pause and wait for a fresh token instead of failing immediately on 401")
	followPlayers := fs.Bool("follow-players", true, "keep polling the players table for newly discovered players instead of exiting when caught up")
	retryErrors := fs.Bool("retry-errors", false, "re-fetch players whose prior player_stats row is marked as error")
	if err := fs.Parse(args); err != nil {
		return config{}, err
	}

	if *workers < 1 || *workers > 16 {
		return config{}, fmt.Errorf("workers must be 1-16, got %d", *workers)
	}
	if *requestInterval < 0 {
		return config{}, errors.New("request-interval cannot be negative")
	}
	if *requestTimeout <= 0 {
		return config{}, errors.New("request-timeout must be positive")
	}
	if *tokenPollInterval <= 0 {
		return config{}, errors.New("token-poll-interval must be positive")
	}
	if *tokenMaxAgeDays < 0 {
		return config{}, errors.New("token-max-age-days cannot be negative")
	}
	if *idlePollInterval <= 0 {
		return config{}, errors.New("idle-poll-interval must be positive")
	}
	if *batchSize <= 0 {
		return config{}, errors.New("batch-size must be positive")
	}

	tok := strings.TrimSpace(*tokenFlag)
	if tok == "" {
		tok = strings.TrimSpace(os.Getenv(tokenEnvName))
	}
	if tok == "" && strings.TrimSpace(*tokenFile) == "" {
		return config{}, fmt.Errorf("no token source: set %s, -token, or -token-file", tokenEnvName)
	}

	seasonKey := 0
	if strings.TrimSpace(*season) != "" {
		n, err := strconv.Atoi(strings.TrimSpace(*season))
		if err != nil || n < 0 {
			return config{}, fmt.Errorf("invalid season %q", *season)
		}
		seasonKey = n
	}

	return config{
		DSN:               *dsn,
		Zone:              strings.TrimSpace(*zone),
		Season:            strings.TrimSpace(*season),
		SeasonKey:         seasonKey,
		Token:             tok,
		TokenFile:         strings.TrimSpace(*tokenFile),
		Workers:           *workers,
		RequestInterval:   *requestInterval,
		RequestTimeout:    *requestTimeout,
		TokenPollInterval: *tokenPollInterval,
		TokenMaxAgeDays:   *tokenMaxAgeDays,
		IdlePollInterval:  *idlePollInterval,
		BatchSize:         *batchSize,
		WaitToken:         *waitToken,
		FollowPlayers:     *followPlayers,
		RetryErrors:       *retryErrors,
	}, nil
}

func ensureSchema(db *sql.DB) error {
	var b strings.Builder
	for _, line := range strings.Split(schemaSQL, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "--") {
			continue
		}
		b.WriteString(line)
		b.WriteByte('\n')
	}
	for _, stmt := range strings.Split(b.String(), ";") {
		s := strings.TrimSpace(stmt)
		if s == "" {
			continue
		}
		if _, err := db.Exec(s); err != nil {
			return fmt.Errorf("exec %q: %w", firstLine(s), err)
		}
	}
	return nil
}

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
}

func (c *crawler) crawl(ctx context.Context) error {
	if err := c.updateState("starting", 0, "initializing official player stats crawl"); err != nil {
		return err
	}
	for {
		ids, err := c.pendingPlayers(c.cfg.BatchSize)
		if err != nil {
			return err
		}
		if len(ids) == 0 {
			if !c.cfg.FollowPlayers {
				_ = c.updateState("done", 0, "no more pending players in players table")
				fmt.Println("done: no more pending player stats rows")
				return nil
			}
			if err := c.updateState("waiting_players", 0, "waiting for player-crawl to discover more players"); err != nil {
				return err
			}
			fmt.Printf("player-stats-crawl caught up; polling again in %s\n", c.cfg.IdlePollInterval)
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(c.cfg.IdlePollInterval):
			}
			continue
		}

		sem := make(chan struct{}, c.cfg.Workers)
		var wg sync.WaitGroup
		for _, pid := range ids {
			wg.Add(1)
			go func(pid int64) {
				defer wg.Done()
				sem <- struct{}{}
				defer func() { <-sem }()
				if err := c.fetchAndStore(ctx, pid); err != nil {
					fmt.Printf("player %d stats: %v\n", pid, err)
				}
			}(pid)
		}
		wg.Wait()

		pending, _ := c.pendingCount()
		done, _ := c.doneCount()
		fmt.Printf("player stats progress: %d done, %d pending for zone=%s season=%s\n",
			done, pending, c.cfg.Zone, seasonLabel(c.cfg.Season))
	}
}

func (c *crawler) pendingPlayers(limit int) ([]int64, error) {
	base := `SELECT p.player_id
FROM players p
LEFT JOIN player_stats s
  ON s.player_id = p.player_id AND s.zone_id = ? AND s.season_id = ?`
	where := `WHERE s.player_id IS NULL OR s.fetched_at < ?`
	if c.cfg.RetryErrors {
		where = `WHERE s.player_id IS NULL OR s.fetched_at < ? OR s.fetch_status = 'error'`
	}
	rows, err := c.db.Query(
		base+"\n"+where+"\nORDER BY p.player_id LIMIT ?",
		c.cfg.Zone, c.cfg.SeasonKey, c.runStartedAt, limit,
	)
	if err != nil {
		return nil, fmt.Errorf("select pending players: %w", err)
	}
	defer rows.Close()

	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func (c *crawler) pendingCount() (int, error) {
	base := `SELECT COUNT(*)
FROM players p
LEFT JOIN player_stats s
  ON s.player_id = p.player_id AND s.zone_id = ? AND s.season_id = ?`
	where := `WHERE s.player_id IS NULL OR s.fetched_at < ?`
	if c.cfg.RetryErrors {
		where = `WHERE s.player_id IS NULL OR s.fetched_at < ? OR s.fetch_status = 'error'`
	}
	var n int
	err := c.db.QueryRow(base+"\n"+where, c.cfg.Zone, c.cfg.SeasonKey, c.runStartedAt).Scan(&n)
	return n, err
}

func (c *crawler) doneCount() (int, error) {
	var n int
	err := c.db.QueryRow(
		`SELECT COUNT(*) FROM player_stats WHERE zone_id = ? AND season_id = ? AND fetch_status = 'ok'`,
		c.cfg.Zone, c.cfg.SeasonKey,
	).Scan(&n)
	return n, err
}

func (c *crawler) fetchAndStore(ctx context.Context, pid int64) error {
	for {
		if err := c.updateState("fetching_player", pid, "loading official player summary"); err != nil {
			return err
		}

		reqCtx, cancel := context.WithTimeout(ctx, c.cfg.RequestTimeout)
		body, err := c.client.PlayerStats(reqCtx, strconv.FormatInt(pid, 10), c.cfg.Zone, c.cfg.Season)
		cancel()
		if err == nil {
			return c.storeSnapshot(pid, body)
		}
		if isAuth(err) && c.cfg.WaitToken {
			if err := c.waitForFreshToken(ctx, pid, err); err != nil {
				return err
			}
			continue
		}
		if err := c.storeFailure(pid, classifyStatus(err), err.Error()); err != nil {
			return err
		}
		return err
	}
}

func (c *crawler) storeSnapshot(pid int64, body []byte) error {
	var snap statsSnapshot
	if err := json.Unmarshal(body, &snap); err != nil {
		if storeErr := c.storeFailure(pid, "error", "parse stats response: "+err.Error()); storeErr != nil {
			return storeErr
		}
		return fmt.Errorf("parse stats response: %w", err)
	}

	now := time.Now()
	_, err := c.db.Exec(`INSERT INTO player_stats
		(player_id, zone_id, season_id, player_name, avatar_url, power_json, joined_zones_json,
		 honors_json, summary_json, haoren_json, langren_json, raw_json, fetch_status, fetch_error, fetched_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ok', NULL, ?)
		ON DUPLICATE KEY UPDATE
		 player_name=VALUES(player_name),
		 avatar_url=VALUES(avatar_url),
		 power_json=VALUES(power_json),
		 joined_zones_json=VALUES(joined_zones_json),
		 honors_json=VALUES(honors_json),
		 summary_json=VALUES(summary_json),
		 haoren_json=VALUES(haoren_json),
		 langren_json=VALUES(langren_json),
		 raw_json=VALUES(raw_json),
		 fetch_status='ok',
		 fetch_error=NULL,
		 fetched_at=VALUES(fetched_at)`,
		pid, c.cfg.Zone, c.cfg.SeasonKey, nullableString(snap.Player.Name), nullableString(snap.Player.Avatar),
		nullableJSON(snap.Power), nullableJSON(snap.Joined), nullableJSON(snap.Honors), nullableJSON(snap.Summary),
		nullableJSON(snap.Haoren), nullableJSON(snap.Langren), string(body), now)
	if err != nil {
		return fmt.Errorf("upsert player_stats for %d: %w", pid, err)
	}
	if snap.Player.Name != "" {
		if _, err := c.db.Exec(`UPDATE players SET player_name = COALESCE(?, player_name) WHERE player_id = ?`, snap.Player.Name, pid); err != nil {
			return fmt.Errorf("update players.player_name for %d: %w", pid, err)
		}
	}
	return nil
}

func (c *crawler) storeFailure(pid int64, status, message string) error {
	_, err := c.db.Exec(`INSERT INTO player_stats
		(player_id, zone_id, season_id, fetch_status, fetch_error, fetched_at)
		VALUES (?, ?, ?, ?, ?, ?)
		ON DUPLICATE KEY UPDATE
		 fetch_status=VALUES(fetch_status),
		 fetch_error=VALUES(fetch_error),
		 fetched_at=VALUES(fetched_at)`,
		pid, c.cfg.Zone, c.cfg.SeasonKey, status, clipNote(message), time.Now())
	if err != nil {
		return fmt.Errorf("record player_stats failure for %d: %w", pid, err)
	}
	return nil
}

func (c *crawler) waitForFreshToken(ctx context.Context, pid int64, cause error) error {
	if c.tokens == nil {
		return cause
	}
	source := "configured token source"
	if c.cfg.TokenFile != "" {
		source = c.cfg.TokenFile
	}
	fmt.Printf("player %d stats auth expired: %v\n", pid, cause)
	fmt.Printf("waiting for a fresh token from %s (poll interval %s)\n", source, c.cfg.TokenPollInterval)
	if err := c.updateState("waiting_token", pid, "waiting for a fresh token"); err != nil {
		return err
	}
	for {
		tok, nick, reason := c.tokens.Refresh()
		if reason == token.ReasonOK && tok != "" {
			if nick != "" {
				fmt.Printf("accepted refreshed token for %s, resuming player stats crawl\n", nick)
			} else {
				fmt.Println("accepted refreshed token, resuming player stats crawl")
			}
			return c.updateState("resuming", pid, "accepted refreshed token")
		}
		fmt.Printf("player stats token still unavailable (%s); current player %d remains pending\n", reason, pid)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(c.cfg.TokenPollInterval):
		}
	}
}

func (c *crawler) updateState(stage string, playerID int64, note string) error {
	_, err := c.db.Exec(`INSERT INTO player_stats_crawl_state
		(crawl_name, zone_id, season_id, stage, current_player_id, note, updated_at)
		VALUES ('player-stats-crawl', ?, ?, ?, NULLIF(?, 0), ?, ?)
		ON DUPLICATE KEY UPDATE
		 zone_id=VALUES(zone_id),
		 season_id=VALUES(season_id),
		 stage=VALUES(stage),
		 current_player_id=VALUES(current_player_id),
		 note=VALUES(note),
		 updated_at=VALUES(updated_at)`,
		c.cfg.Zone, c.cfg.SeasonKey, stage, playerID, clipNote(note), time.Now())
	if err != nil {
		return fmt.Errorf("update player_stats_crawl_state: %w", err)
	}
	return nil
}

func classifyStatus(err error) string {
	var apiErr *huashan.APIError
	if errors.As(err, &apiErr) {
		if apiErr.Status == 404 {
			return "not_found"
		}
	}
	return "error"
}

func isAuth(err error) bool {
	var apiErr *huashan.APIError
	return errors.As(err, &apiErr) && apiErr.Status == 401
}

func clipNote(s string) string {
	s = strings.TrimSpace(s)
	if len(s) <= 255 {
		return s
	}
	return s[:252] + "..."
}

func nullableString(s string) any {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	return s
}

func nullableJSON(raw json.RawMessage) any {
	if len(strings.TrimSpace(string(raw))) == 0 || string(raw) == "null" {
		return nil
	}
	return string(raw)
}

func seasonLabel(season string) string {
	if season == "" {
		return "ALL"
	}
	return season
}

func tokenSources(cfg config) []token.Source {
	var sources []token.Source
	if cfg.Token != "" {
		sources = append(sources, staticTokenSource{Token: cfg.Token})
	}
	if cfg.TokenFile != "" {
		sources = append(sources, fileTokenSource{Path: cfg.TokenFile})
	}
	sources = append(sources, localTokenSources(cfg.TokenMaxAgeDays)...)
	return sources
}

func localTokenSources(maxAgeDays int) []token.Source {
	if runtime.GOOS != "windows" && runtime.GOOS != "darwin" {
		return nil
	}
	return []token.Source{&wechat.Store{MaxAgeDays: maxAgeDays}}
}

type staticTokenSource struct {
	Token string
}

func (s staticTokenSource) Candidates() []string {
	if strings.TrimSpace(s.Token) == "" {
		return nil
	}
	return []string{strings.TrimSpace(s.Token)}
}

type fileTokenSource struct {
	Path string
}

func (s fileTokenSource) Candidates() []string {
	if strings.TrimSpace(s.Path) == "" {
		return nil
	}
	b, err := os.ReadFile(strings.TrimSpace(s.Path))
	if err != nil {
		return nil
	}
	if tok := strings.TrimSpace(string(b)); tok != "" {
		return []string{tok}
	}
	return nil
}
