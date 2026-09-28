// player-crawl walks the Huashan player/game graph from seed players and stores
// every reachable finished game (full raw detail plus per-seat scalar fields) into
// a local MySQL database for offline analysis and training.
//
// The login token is pasted in via -token / -token-file / HUASHAN_QUERY_TOKEN and is
// never written to the database. Crawling is resumable: state lives in the `players`
// table (0 pending, 1 done, 2 error); rerun to continue, -retry-errors to retry prior failures.
//
// Run on macOS/Windows/Linux. Requires the MySQL driver:
//
//	go get github.com/go-sql-driver/mysql
//	HUASHAN_QUERY_TOKEN=xxxxx go run ./cmd/player-crawl -dsn 'user:pass@tcp(127.0.0.1:3306)/huashan?charset=utf8mb4&parseTime=true&loc=Local'
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

const (
	tokenEnvName   = "HUASHAN_QUERY_TOKEN"
	statusFinished = 5
	// Maintained seed list (same as cmd/player-data); the crawl expands from here.
	defaultSeeds = "6964,3444,1209,9137,734,109,73,7781,7598,8528,6078,7668"
)

var errStopCrawl = errors.New("stop crawl")

type config struct {
	DSN               string
	Seeds             []string
	Token             string
	TokenFile         string
	Workers           int
	ListTimeout       time.Duration
	GameTimeout       time.Duration
	RequestInterval   time.Duration
	TokenPollInterval time.Duration
	TokenMaxAgeDays   int
	WaitToken         bool
	MaxGames          int
	RetryErrors       bool
	RetryDead         bool
	RefreshStored     bool
	MigrateOnly       bool
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "player-crawl failed:", err)
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

	if cfg.MigrateOnly {
		return runMigrate(cfg)
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
		return fmt.Errorf("connect db (is MySQL running and the DSN correct?): %w", err)
	}
	if err := ensureSchema(db); err != nil {
		return fmt.Errorf("apply schema: %w", err)
	}

	c := &crawler{
		cfg:    cfg,
		client: client,
		tokens: mgr,
		db:     db,
		// players.crawled_at is DATETIME without fractional seconds.
		runStartedAt: time.Now().Truncate(time.Second),
		seenFinal:    map[int]bool{},
		seenDead:     map[int]bool{},
	}
	if err := c.loadSeenFinal(); err != nil {
		return err
	}
	if err := c.loadSeenDead(); err != nil {
		return err
	}
	return c.crawl(context.Background())
}

func parseConfig(args []string) (config, error) {
	fs := flag.NewFlagSet("player-crawl", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	dsn := fs.String("dsn", "root@tcp(127.0.0.1:3306)/huashan?charset=utf8mb4&parseTime=true&loc=Local", "MySQL DSN")
	seeds := fs.String("seed", defaultSeeds, "comma/space separated seed player IDs to start the crawl from")
	tokenFlag := fs.String("token", "", "Huashan login token (overrides "+tokenEnvName+")")
	tokenFile := fs.String("token-file", "", "path to a file containing the token")
	workers := fs.Int("workers", 1, "concurrent game-detail fetches (1-16; use 1 for exact progress and gentler crawling)")
	listTimeout := fs.Duration("list-timeout", 4*time.Minute, "timeout for one player's full game-list fetch")
	gameTimeout := fs.Duration("game-timeout", 60*time.Second, "timeout for one game-detail fetch")
	requestInterval := fs.Duration("request-interval", 100*time.Millisecond, "minimum delay between upstream requests across the whole crawl; raise it if upstream starts returning 429 (the client already backs off 300ms/900ms and retries transient errors)")
	tokenPollInterval := fs.Duration("token-poll-interval", 30*time.Second, "when the token expires, how often to poll for a fresh token")
	tokenMaxAgeDays := fs.Int("token-max-age-days", 3, "maximum age of local WeChat token files when scanning local fallbacks; 0 disables age filtering")
	waitToken := fs.Bool("wait-token", true, "pause and wait for a fresh token instead of failing immediately on 401")
	maxGames := fs.Int("max-games", 0, "stop after this many stored games (0 = unlimited)")
	retryErrors := fs.Bool("retry-errors", false, "re-fetch players that were marked as error before this run")
	migrateOnly := fs.Bool("migrate", false, "apply schema and re-derive roster-quality flags from stored raw_json, then exit (no token, no crawling)")
	retryDead := fs.Bool("retry-dead", false, "re-request games the negative cache marked as permanently unavailable")
	refreshStored := fs.Bool("refresh-stored", false, "re-fetch stored games so upstream corrections can replace cached details")
	if err := fs.Parse(args); err != nil {
		return config{}, err
	}
	if *workers < 1 || *workers > 16 {
		return config{}, fmt.Errorf("workers must be 1-16, got %d", *workers)
	}
	if *requestInterval < 0 {
		return config{}, errors.New("request-interval cannot be negative")
	}
	if *tokenPollInterval <= 0 {
		return config{}, errors.New("token-poll-interval must be positive")
	}
	if *tokenMaxAgeDays < 0 {
		return config{}, errors.New("token-max-age-days cannot be negative")
	}
	tok := strings.TrimSpace(*tokenFlag)
	if tok == "" {
		tok = strings.TrimSpace(os.Getenv(tokenEnvName))
	}
	if tok == "" && strings.TrimSpace(*tokenFile) == "" && !*migrateOnly {
		return config{}, fmt.Errorf("no token source: set %s, -token, or -token-file", tokenEnvName)
	}
	ids, err := parseIDs(*seeds)
	if err != nil {
		return config{}, err
	}
	return config{
		DSN:               *dsn,
		Seeds:             ids,
		Token:             tok,
		TokenFile:         strings.TrimSpace(*tokenFile),
		Workers:           *workers,
		ListTimeout:       *listTimeout,
		GameTimeout:       *gameTimeout,
		RequestInterval:   *requestInterval,
		TokenPollInterval: *tokenPollInterval,
		TokenMaxAgeDays:   *tokenMaxAgeDays,
		WaitToken:         *waitToken,
		MaxGames:          *maxGames,
		RetryErrors:       *retryErrors,
		RetryDead:         *retryDead,
		RefreshStored:     *refreshStored,
		MigrateOnly:       *migrateOnly,
	}, nil
}

func parseIDs(raw string) ([]string, error) {
	parts := strings.FieldsFunc(raw, func(r rune) bool {
		return r == ',' || r == ';' || r == '，' || r == '；' || r == '\n' || r == '\r' || r == '\t' || r == ' '
	})
	seen := map[string]bool{}
	var ids []string
	for _, p := range parts {
		id := strings.TrimPrefix(strings.TrimSpace(p), "#")
		n, err := strconv.ParseUint(id, 10, 64)
		if err != nil || n == 0 {
			return nil, fmt.Errorf("invalid seed player ID %q", p)
		}
		s := strconv.FormatUint(n, 10)
		if !seen[s] {
			seen[s] = true
			ids = append(ids, s)
		}
	}
	if len(ids) == 0 {
		return nil, fmt.Errorf("at least one seed player ID is required")
	}
	return ids, nil
}

func ensureSchema(db *sql.DB) error {
	// Drop comment lines, then split into statements on ';'.
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
	if err := ensurePlayerQueueIndex(db); err != nil {
		return err
	}
	if err := ensureGamesStatusIndex(db); err != nil {
		return err
	}
	return ensureGamesRosterColumns(db)
}

// runMigrate applies the schema and re-derives roster-quality flags for every stored
// game from its raw_json, without a token or any upstream requests. Useful after a
// data-quality rule changes or when importing a dump that predates the roster flags.
func runMigrate(cfg config) error {
	db, err := sql.Open("mysql", cfg.DSN)
	if err != nil {
		return fmt.Errorf("open db: %w", err)
	}
	defer db.Close()
	pingCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := db.PingContext(pingCtx); err != nil {
		return fmt.Errorf("connect db (is MySQL running and the DSN correct?): %w", err)
	}
	if err := ensureSchema(db); err != nil {
		return fmt.Errorf("apply schema: %w", err)
	}
	total, bad, err := backfillRoster(db)
	if err != nil {
		return err
	}
	fmt.Printf("migrate: re-derived roster flags for %d games, %d flagged invalid\n", total, bad)
	return nil
}

// ensureGamesRosterColumns adds the roster-quality columns to an existing games table
// and, when it has to add them, backfills the flags from stored raw_json in one pass.
func ensureGamesRosterColumns(db *sql.DB) error {
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM information_schema.columns
WHERE table_schema = DATABASE() AND table_name = 'games' AND column_name = 'roster_ok'`).Scan(&n); err != nil {
		return fmt.Errorf("inspect games columns: %w", err)
	}
	if n > 0 {
		return nil
	}
	if _, err := db.Exec(`ALTER TABLE games
ADD COLUMN roster_ok TINYINT NOT NULL DEFAULT 1,
ADD COLUMN roster_issue VARCHAR(64) NULL`); err != nil {
		return fmt.Errorf("add games roster columns: %w", err)
	}
	total, bad, err := backfillRoster(db)
	if err != nil {
		return err
	}
	fmt.Printf("schema: added roster flags, backfilled %d games (%d flagged invalid)\n", total, bad)
	return nil
}

// backfillRoster re-parses every stored game's raw_json and writes its roster flags.
func backfillRoster(db *sql.DB) (total, bad int, err error) {
	rows, err := db.Query("SELECT game_id, raw_json FROM games")
	if err != nil {
		return 0, 0, fmt.Errorf("scan games for roster backfill: %w", err)
	}
	type result struct {
		id    int64
		ok    bool
		issue string
	}
	var results []result
	for rows.Next() {
		var id int64
		var raw string
		if err := rows.Scan(&id, &raw); err != nil {
			rows.Close()
			return 0, 0, err
		}
		var top map[string]json.RawMessage
		ok, issue := false, "unparseable_detail"
		if json.Unmarshal([]byte(raw), &top) == nil {
			ok, issue = evaluateRoster(parseForm2Rows(top["form2"]))
		}
		results = append(results, result{id, ok, issue})
	}
	if err := rows.Close(); err != nil {
		return 0, 0, err
	}
	if err := rows.Err(); err != nil {
		return 0, 0, err
	}
	stmt, err := db.Prepare("UPDATE games SET roster_ok = ?, roster_issue = ? WHERE game_id = ?")
	if err != nil {
		return 0, 0, err
	}
	defer stmt.Close()
	for _, r := range results {
		if _, err := stmt.Exec(boolToTinyint(r.ok), issueOrNull(r.issue), r.id); err != nil {
			return 0, 0, fmt.Errorf("update roster flags for game %d: %w", r.id, err)
		}
		total++
		if !r.ok {
			bad++
		}
	}
	return total, bad, nil
}

// evaluateRoster checks a game's form2 seats. A valid finished game has 12 seats, each
// a distinct positive player_id. Official data sometimes repeats one player across
// seats or leaves npc/empty fillers (player_id <= 0); such rosters cannot be attributed
// per player, so they are flagged for exclusion from analysis rather than stored as a
// misleading roster that would double-count games in player aggregates.
func evaluateRoster(rows []map[string]json.RawMessage) (bool, string) {
	seats := 0
	missing := false
	seen := map[int64]int{}
	for _, row := range rows {
		if _, ok := asInt(row["seat"]); !ok {
			continue
		}
		seats++
		pid, _ := asInt(row["player_id"])
		if pid <= 0 {
			missing = true
			continue
		}
		seen[pid]++
	}
	for _, count := range seen {
		if count > 1 {
			return false, "duplicate_player_seats"
		}
	}
	if missing {
		return false, "missing_player_seat"
	}
	if seats != 12 {
		return false, "incomplete_roster"
	}
	return true, ""
}

func boolToTinyint(b bool) int {
	if b {
		return 1
	}
	return 0
}

func issueOrNull(issue string) any {
	if issue == "" {
		return nil
	}
	return issue
}

func ensurePlayerQueueIndex(db *sql.DB) error {
	rows, err := db.Query(`SELECT DISTINCT index_name
FROM information_schema.statistics
WHERE table_schema = DATABASE()
  AND table_name = 'players'
  AND index_name IN ('idx_crawled', 'idx_crawled_at')`)
	if err != nil {
		return fmt.Errorf("inspect players indexes: %w", err)
	}
	indexes := map[string]bool{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			rows.Close()
			return fmt.Errorf("scan players index: %w", err)
		}
		indexes[name] = true
	}
	if err := rows.Close(); err != nil {
		return fmt.Errorf("close players index query: %w", err)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("inspect players indexes: %w", err)
	}

	if !indexes["idx_crawled_at"] {
		if _, err := db.Exec(`ALTER TABLE players ADD INDEX idx_crawled_at (crawled_at)`); err != nil {
			return fmt.Errorf("add players crawled_at index: %w", err)
		}
	}
	if indexes["idx_crawled"] {
		if _, err := db.Exec(`ALTER TABLE players DROP INDEX idx_crawled`); err != nil {
			return fmt.Errorf("drop obsolete players crawled index: %w", err)
		}
	}
	return nil
}

func ensureGamesStatusIndex(db *sql.DB) error {
	var n int
	if err := db.QueryRow(`SELECT COUNT(*)
FROM information_schema.statistics
WHERE table_schema = DATABASE() AND table_name = 'games' AND column_name = 'status' AND seq_in_index = 1`).Scan(&n); err != nil {
		return fmt.Errorf("inspect games status index: %w", err)
	}
	if n > 0 {
		return nil
	}
	if _, err := db.Exec(`ALTER TABLE games ADD INDEX idx_status (status)`); err != nil {
		return fmt.Errorf("add games status index: %w", err)
	}
	return nil
}

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
}

type crawler struct {
	cfg    config
	client *huashan.Client
	tokens interface {
		Refresh() (string, string, token.Reason)
	}
	db           *sql.DB
	runStartedAt time.Time

	mu        sync.Mutex
	seenFinal map[int]bool // game_ids already stored with finished status: skip refetch
	seenDead  map[int]bool // game_ids upstream no longer serves: skip unless -retry-dead
	stored    int          // games stored this run (for -max-games and progress)
}

func (c *crawler) loadSeenDead() error {
	rows, err := c.db.Query("SELECT game_id FROM game_fetch_failures WHERE permanent = 1")
	if err != nil {
		return fmt.Errorf("load dead games: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var id int
		if err := rows.Scan(&id); err != nil {
			return err
		}
		c.seenDead[id] = true
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if len(c.seenDead) > 0 {
		fmt.Printf("skipping: %d game(s) upstream no longer serves (-retry-dead to override)\n", len(c.seenDead))
	}
	return nil
}

// skipGame reports whether a game id needs no fetch this run.
func (c *crawler) skipGame(gid int) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return (!c.cfg.RefreshStored && c.seenFinal[gid]) || (c.seenDead[gid] && !c.cfg.RetryDead)
}

// deadVerdict classifies a game-detail fetch error for the negative cache.
//
// record=false means "say nothing about this game": cancellation and timeouts mean we gave
// up, not that upstream lacks the game, and counting them would let a Ctrl-C or a slow
// network blacklist perfectly good games across repeated runs.
//
// permanent=true means "stop asking for this game": 404/410 are upstream telling us it does
// not exist and will not come back, so one sighting is enough.
func deadVerdict(err error) (record, permanent bool, status int) {
	if err == nil {
		return false, false, 0
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return false, false, 0
	}
	var apiErr *huashan.APIError
	if errors.As(err, &apiErr) {
		status = apiErr.Status
	}
	return true, status == 404 || status == 410, status
}

// markDead records a failed fetch. Only explicit 404/410 responses are permanent: transport,
// rate-limit, and server failures must never turn a healthy game into a skipped dead game.
func (c *crawler) markDead(gid int, err error) {
	record, permanent, status := deadVerdict(err)
	if !record {
		return
	}
	msg := err.Error()
	if len(msg) > 255 {
		msg = msg[:255]
	}

	if permanent {
		c.mu.Lock()
		known := c.seenDead[gid]
		c.mu.Unlock()
		if known {
			return // already cached as dead; no need to write again
		}
	}

	now := time.Now().Truncate(time.Second)
	var statusArg any
	if status != 0 {
		statusArg = status
	}
	if _, execErr := c.db.Exec(`INSERT INTO game_fetch_failures
		(game_id, attempts, permanent, last_status, last_error, first_seen_at, last_attempt_at)
		VALUES (?, 1, ?, ?, ?, ?, ?)
		ON DUPLICATE KEY UPDATE
		 attempts = attempts + 1,
		 permanent = GREATEST(permanent, ?),
		 last_status = VALUES(last_status),
		 last_error = VALUES(last_error),
		 last_attempt_at = VALUES(last_attempt_at)`,
		gid, b2i(permanent), statusArg, msg, now, now, b2i(permanent)); execErr != nil {
		fmt.Printf("game %d: record failure: %v\n", gid, execErr)
		return
	}
	if permanent {
		c.mu.Lock()
		c.seenDead[gid] = true
		c.mu.Unlock()
	}
}

func b2i(b bool) int {
	if b {
		return 1
	}
	return 0
}

func (c *crawler) loadSeenFinal() error {
	rows, err := c.db.Query("SELECT game_id FROM games WHERE status = ?", statusFinished)
	if err != nil {
		return fmt.Errorf("load stored games: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var id int
		if err := rows.Scan(&id); err != nil {
			return err
		}
		c.seenFinal[id] = true
	}
	fmt.Printf("resuming: %d finished games already stored\n", len(c.seenFinal))
	return rows.Err()
}

func (c *crawler) crawl(ctx context.Context) error {
	if err := c.updateProgress("starting", 0, 0, "seeding crawl queue"); err != nil {
		return err
	}
	now := time.Now()
	for _, id := range c.cfg.Seeds {
		if _, err := c.db.Exec(
			"INSERT INTO players (player_id, crawled, discovered_at) VALUES (?, 0, ?) "+
				"ON DUPLICATE KEY UPDATE player_id = player_id", id, now); err != nil {
			return fmt.Errorf("seed player %s: %w", id, err)
		}
	}
	for {
		ids, err := c.pendingPlayers(256)
		if err != nil {
			return err
		}
		if len(ids) == 0 {
			break
		}
		for _, pid := range ids {
			if err := c.updateProgress("listing_games", pid, 0, "loading player game index"); err != nil {
				return err
			}
			err := c.processPlayer(ctx, pid)
			if errors.Is(err, errStopCrawl) {
				_ = c.updateProgress("stopped", pid, 0, fmt.Sprintf("reached -max-games=%d", c.cfg.MaxGames))
				fmt.Printf("reached -max-games=%d, stopping\n", c.cfg.MaxGames)
				return nil
			}
			state := 1
			if err != nil {
				state = 2
				fmt.Printf("player %d: %v\n", pid, err)
			}
			if _, e := c.db.Exec("UPDATE players SET crawled = ?, crawled_at = ? WHERE player_id = ?", state, time.Now(), pid); e != nil {
				return fmt.Errorf("mark player %d: %w", pid, e)
			}
			if c.cfg.MaxGames > 0 && c.storedCount() >= c.cfg.MaxGames {
				_ = c.updateProgress("stopped", pid, 0, fmt.Sprintf("reached -max-games=%d", c.cfg.MaxGames))
				fmt.Printf("reached -max-games=%d, stopping\n", c.cfg.MaxGames)
				return nil
			}
		}
		pend, _ := c.countPending()
		fmt.Printf("progress: %d games stored, %d players still pending\n", c.storedCount(), pend)
	}
	_ = c.updateProgress("done", 0, 0, fmt.Sprintf("stored %d game(s) this run", c.storedCount()))
	fmt.Printf("done: %d games stored this run\n", c.storedCount())
	return nil
}

func (c *crawler) pendingPlayers(limit int) ([]int, error) {
	rows, err := c.db.Query(
		`SELECT player_id
FROM players
`+playerPendingWhere(c.cfg.RetryErrors)+`
ORDER BY crawled_at IS NOT NULL, crawled_at, discovered_at, player_id
LIMIT ?`,
		c.runStartedAt, limit,
	)
	if err != nil {
		return nil, fmt.Errorf("select pending: %w", err)
	}
	defer rows.Close()
	var ids []int
	for rows.Next() {
		var id int
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func (c *crawler) countPending() (int, error) {
	var n int
	err := c.db.QueryRow(
		`SELECT COUNT(*)
FROM players
`+playerPendingWhere(c.cfg.RetryErrors),
		c.runStartedAt,
	).Scan(&n)
	return n, err
}

func playerPendingWhere(retryErrors bool) string {
	if retryErrors {
		return `WHERE crawled_at IS NULL OR crawled_at < ?`
	}
	return `WHERE crawled_at IS NULL OR (crawled_at < ? AND crawled <> 2)`
}

func (c *crawler) storedCount() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.stored
}

func (c *crawler) limitConcurrentTodo(todo []int) ([]int, bool) {
	if c.cfg.MaxGames <= 0 {
		return todo, false
	}
	remaining := c.cfg.MaxGames - c.storedCount()
	if remaining <= 0 {
		return nil, len(todo) > 0
	}
	if len(todo) > remaining {
		return todo[:remaining], true
	}
	return todo, false
}

// processPlayer fetches a player's full game index and stores every not-yet-finished game.
func (c *crawler) processPlayer(ctx context.Context, pid int) error {
	rows, trunc, err := c.loadPlayerGames(ctx, pid)
	if err != nil {
		return err
	}
	if err := c.storePlayerGameResults(pid, rows, trunc); err != nil {
		return err
	}
	if trunc {
		fmt.Printf("player %d: game list truncated (some games may be missed)\n", pid)
	}

	var todo []int
	for _, r := range rows {
		var row map[string]json.RawMessage
		if json.Unmarshal(r, &row) != nil {
			continue
		}
		gid, ok := asInt(row["game_id"])
		if !ok || gid <= 0 {
			continue
		}
		if !c.skipGame(int(gid)) {
			todo = append(todo, int(gid))
		}
	}

	if c.cfg.Workers == 1 {
		for _, gid := range todo {
			if c.cfg.MaxGames > 0 && c.storedCount() >= c.cfg.MaxGames {
				return errStopCrawl
			}
			if err := c.fetchAndStore(ctx, pid, gid); err != nil {
				fmt.Printf("game %d: %v\n", gid, err)
			}
		}
		return nil
	}

	var hitLimit bool
	todo, hitLimit = c.limitConcurrentTodo(todo)
	sem := make(chan struct{}, c.cfg.Workers)
	var wg sync.WaitGroup
	for _, gid := range todo {
		wg.Add(1)
		go func(gid int) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			if err := c.fetchAndStore(ctx, pid, gid); err != nil {
				fmt.Printf("game %d: %v\n", gid, err)
			}
		}(gid)
	}
	wg.Wait()
	if hitLimit || (c.cfg.MaxGames > 0 && c.storedCount() >= c.cfg.MaxGames) {
		return errStopCrawl
	}
	return nil
}

func (c *crawler) storePlayerGameResults(pid int, rows []json.RawMessage, truncated bool) error {
	tx, err := c.db.Begin()
	if err != nil {
		return fmt.Errorf("begin player game results for %d: %w", pid, err)
	}
	defer tx.Rollback()

	stmt, err := tx.Prepare(`INSERT INTO player_game_results
		(player_id, game_id, play_date, season_id, season_type_id, season_type_label, round,
		 edition_id, edition_name, sect_id, sect_name, rpt_id, rpt_name, total_point,
		 win, mvp, svp, bgx, raw_json, fetched_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON DUPLICATE KEY UPDATE
		 play_date=VALUES(play_date), season_id=VALUES(season_id),
		 season_type_id=VALUES(season_type_id), season_type_label=VALUES(season_type_label),
		 round=VALUES(round), edition_id=VALUES(edition_id), edition_name=VALUES(edition_name),
		 sect_id=VALUES(sect_id), sect_name=VALUES(sect_name), rpt_id=VALUES(rpt_id),
		 rpt_name=VALUES(rpt_name), total_point=VALUES(total_point), win=VALUES(win),
		 mvp=VALUES(mvp), svp=VALUES(svp), bgx=VALUES(bgx), raw_json=VALUES(raw_json),
		 fetched_at=VALUES(fetched_at)`)
	if err != nil {
		return fmt.Errorf("prepare player game results for %d: %w", pid, err)
	}
	defer stmt.Close()

	now := time.Now()
	stored, invalid := 0, 0
	for _, raw := range rows {
		var row map[string]json.RawMessage
		if err := json.Unmarshal(raw, &row); err != nil {
			invalid++
			continue
		}
		gid, ok := asInt(row["game_id"])
		if !ok || gid <= 0 {
			invalid++
			continue
		}
		if _, err := stmt.Exec(
			pid, gid, niDate(row["play_date"]), niInt(row["season_id"]),
			niInt(row["season_type_id"]), niStr(row["season_type_label"]), niInt(row["round"]),
			niInt(row["edition_id"]), niStr(row["edition_name"]), niInt(row["sect_id"]),
			niStr(row["sect_name"]), niInt(row["rpt_id"]), niStr(row["rpt_name"]),
			nullableNumber(row["total_point"]), nullableFlag(row["win"]), nullableFlag(row["mvp"]),
			nullableFlag(row["svp"]), nullableFlag(row["bgx"]), string(raw), now,
		); err != nil {
			return fmt.Errorf("store player %d game %d result: %w", pid, gid, err)
		}
		stored++
	}

	complete := !truncated && invalid == 0
	if _, err := tx.Exec(`INSERT INTO player_game_result_state
		(player_id, fetched_rows, stored_rows, invalid_rows, complete, fetched_at)
		VALUES (?, ?, ?, ?, ?, ?)
		ON DUPLICATE KEY UPDATE
		 fetched_rows=VALUES(fetched_rows), stored_rows=VALUES(stored_rows),
		 invalid_rows=VALUES(invalid_rows), complete=VALUES(complete), fetched_at=VALUES(fetched_at)`,
		pid, len(rows), stored, invalid, complete, now); err != nil {
		return fmt.Errorf("store player %d game result state: %w", pid, err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit player game results for %d: %w", pid, err)
	}
	return nil
}

func (c *crawler) loadPlayerGames(ctx context.Context, pid int) ([]json.RawMessage, bool, error) {
	for {
		listCtx, cancel := context.WithTimeout(ctx, c.cfg.ListTimeout)
		rows, trunc, err := c.client.PlayerGames(listCtx, strconv.Itoa(pid), "ALL")
		cancel()
		if err == nil {
			return rows, trunc, nil
		}
		if !isAuth(err) || !c.cfg.WaitToken {
			return nil, false, fmt.Errorf("game list: %w", err)
		}
		if err := c.waitForFreshToken(ctx, pid, 0, err); err != nil {
			return nil, false, err
		}
	}
}

func (c *crawler) fetchAndStore(ctx context.Context, pid, gid int) error {
	for {
		if err := c.updateProgress("fetching_game", pid, gid, "loading game detail"); err != nil {
			return err
		}
		gameCtx, cancel := context.WithTimeout(ctx, c.cfg.GameTimeout)
		raw, err := c.client.Game(gameCtx, strconv.Itoa(gid))
		cancel()
		if err == nil {
			return c.store(gid, raw)
		}
		if isAuth(err) {
			if !c.cfg.WaitToken {
				return err
			}
			if werr := c.waitForFreshToken(ctx, pid, gid, err); werr != nil {
				return werr
			}
			continue
		}
		c.markDead(gid, err)
		return err
	}
}

// —— storage ——

func (c *crawler) store(gid int, raw []byte) error {
	var top map[string]json.RawMessage
	if err := json.Unmarshal(raw, &top); err != nil {
		return fmt.Errorf("parse detail: %w", err)
	}
	status, _ := asInt(top["status"])
	editionID, editionName := 0, ""
	if e := top["edition"]; len(e) > 0 {
		var ed struct {
			ID   int    `json:"id"`
			Name string `json:"name"`
		}
		if json.Unmarshal(e, &ed) == nil {
			editionID, editionName = ed.ID, ed.Name
		}
	}

	tx, err := c.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	form2Rows := parseForm2Rows(top["form2"])
	rosterOK, rosterIssue := evaluateRoster(form2Rows)

	_, err = tx.Exec(`INSERT INTO games
		(game_id, play_date, season_id, season_type_id, season_type_label, round,
		 edition_id, edition_name, referee_id, referee_name, victory_camp, total_days,
		 mvp_seat, svp_seat, bgx_seat, status, roster_ok, roster_issue, raw_json, fetched_at)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
		ON DUPLICATE KEY UPDATE
		 play_date=VALUES(play_date), season_id=VALUES(season_id), season_type_id=VALUES(season_type_id),
		 season_type_label=VALUES(season_type_label), round=VALUES(round), edition_id=VALUES(edition_id),
		 edition_name=VALUES(edition_name), referee_id=VALUES(referee_id), referee_name=VALUES(referee_name),
		 victory_camp=VALUES(victory_camp), total_days=VALUES(total_days), mvp_seat=VALUES(mvp_seat),
		 svp_seat=VALUES(svp_seat), bgx_seat=VALUES(bgx_seat), status=VALUES(status),
		 roster_ok=VALUES(roster_ok), roster_issue=VALUES(roster_issue),
		 raw_json=VALUES(raw_json), fetched_at=VALUES(fetched_at)`,
		gid, niDate(top["play_date"]), niInt(top["season_id"]), niInt(top["season_type_id"]),
		niStr(top["season_type_label"]), niInt(top["round"]), niZero(editionID), niStrVal(editionName),
		niInt(top["referee_id"]), niStr(top["referee_name"]), niInt(top["victory_camp"]), niInt(top["day"]),
		niInt(top["mvp_seat"]), niInt(top["svp_seat"]), niInt(top["bgx_seat"]), niInt(top["status"]),
		boolToTinyint(rosterOK), issueOrNull(rosterIssue),
		string(raw), time.Now())
	if err != nil {
		return fmt.Errorf("insert game: %w", err)
	}

	discovered := map[int]string{}
	for _, row := range form2Rows {
		seat, ok := asInt(row["seat"])
		if !ok {
			continue
		}
		pid, _ := asInt(row["player_id"])
		name := asStrOr(row["player_name"])
		if pid > 0 {
			discovered[int(pid)] = name
		}
		_, err = tx.Exec(`INSERT INTO game_players
			(game_id, seat, player_id, player_name, sect_id, sect_name, rpt_id, rpt_name,
			 day_of_hantiao, hantiao_rpt_name, day_of_jinhui, zibao_day, votes_json, skills_json)
			VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
			ON DUPLICATE KEY UPDATE
			 player_id=VALUES(player_id), player_name=VALUES(player_name), sect_id=VALUES(sect_id),
			 sect_name=VALUES(sect_name), rpt_id=VALUES(rpt_id), rpt_name=VALUES(rpt_name),
			 day_of_hantiao=VALUES(day_of_hantiao), hantiao_rpt_name=VALUES(hantiao_rpt_name),
			 day_of_jinhui=VALUES(day_of_jinhui), zibao_day=VALUES(zibao_day),
			 votes_json=VALUES(votes_json), skills_json=VALUES(skills_json)`,
			gid, seat, niZero64(pid), niStrVal(name), niInt(row["sect_id"]), niStr(row["sect_name"]),
			niInt(row["rpt_id"]), niStr(row["rpt_name"]), niInt(row["day_of_hantiao"]),
			niStr(row["hantiao_rpt_name"]), niInt(row["day_of_jinhui"]), niZero(zibaoDay(row)),
			votesJSON(row), skillsJSON(row))
		if err != nil {
			return fmt.Errorf("insert seat: %w", err)
		}
	}

	now := time.Now()
	for pid, name := range discovered {
		if _, err := tx.Exec(
			"INSERT INTO players (player_id, player_name, crawled, discovered_at) VALUES (?,?,0,?) "+
				"ON DUPLICATE KEY UPDATE player_name = COALESCE(VALUES(player_name), player_name)",
			pid, niStrVal(name), now); err != nil {
			return fmt.Errorf("discover player %d: %w", pid, err)
		}
	}
	if _, err := tx.Exec("DELETE FROM game_fetch_failures WHERE game_id = ?", gid); err != nil {
		return fmt.Errorf("clear game failure for %d: %w", gid, err)
	}

	if err := tx.Commit(); err != nil {
		return err
	}

	c.mu.Lock()
	c.stored++
	if int(status) == statusFinished {
		c.seenFinal[gid] = true
	}
	c.mu.Unlock()
	return nil
}

// —— form2 parsing ——

func parseForm2Rows(f2raw json.RawMessage) []map[string]json.RawMessage {
	if len(f2raw) == 0 {
		return nil
	}
	var inner []byte
	var s string
	if json.Unmarshal(f2raw, &s) == nil { // form2 is a double-encoded JSON string
		inner = []byte(s)
	} else {
		inner = f2raw
	}
	var f2 struct {
		Rows []map[string]json.RawMessage `json:"rows"`
	}
	if json.Unmarshal(inner, &f2) != nil {
		return nil
	}
	return f2.Rows
}

func zibaoDay(row map[string]json.RawMessage) int {
	for d := 1; d <= 8; d++ {
		var b bool
		if raw, ok := row["zibao"+strconv.Itoa(d)]; ok && json.Unmarshal(raw, &b) == nil && b {
			return d
		}
	}
	return 0
}

func votesJSON(row map[string]json.RawMessage) any {
	out := map[string]string{}
	for d := 1; d <= 8; d++ {
		if v := asStrOr(row["vote_day"+strconv.Itoa(d)]); v != "" && v != "0" {
			out["day"+strconv.Itoa(d)] = v
		}
	}
	if v := asStrOr(row["vote_jinhui"]); v != "" && v != "0" {
		out["jinhui"] = v
	}
	if len(out) == 0 {
		return nil
	}
	b, _ := json.Marshal(out)
	return string(b)
}

func skillsJSON(row map[string]json.RawMessage) any {
	if raw, ok := row["skills"]; ok && len(raw) > 0 {
		return string(raw)
	}
	return nil
}

func isAuth(err error) bool {
	var apiErr *huashan.APIError
	return errors.As(err, &apiErr) && apiErr.Status == 401
}

func (c *crawler) waitForFreshToken(ctx context.Context, pid, gid int, cause error) error {
	if c.tokens == nil {
		return cause
	}
	source := "configured token source"
	if c.cfg.TokenFile != "" {
		source = c.cfg.TokenFile
	}
	fmt.Printf("auth expired at player %d game %d: %v\n", pid, gid, cause)
	fmt.Printf("waiting for a fresh token from %s (poll interval %s)\n", source, c.cfg.TokenPollInterval)
	if err := c.updateProgress("waiting_token", pid, gid, "waiting for a fresh token"); err != nil {
		return err
	}
	for {
		tok, nick, reason := c.tokens.Refresh()
		if reason == token.ReasonOK && tok != "" {
			if nick != "" {
				fmt.Printf("accepted refreshed token for %s, resuming\n", nick)
			} else {
				fmt.Printf("accepted refreshed token, resuming\n")
			}
			return c.updateProgress("resuming", pid, gid, "accepted refreshed token")
		}
		fmt.Printf("token still unavailable (%s); keeping progress at player %d game %d\n", reason, pid, gid)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(c.cfg.TokenPollInterval):
		}
	}
}

func (c *crawler) updateProgress(stage string, playerID, gameID int, note string) error {
	_, err := c.db.Exec(`INSERT INTO crawl_state
		(crawl_name, stage, current_player_id, current_game_id, note, updated_at)
		VALUES ('player-crawl', ?, NULLIF(?, 0), NULLIF(?, 0), ?, ?)
		ON DUPLICATE KEY UPDATE
		 stage=VALUES(stage),
		 current_player_id=VALUES(current_player_id),
		 current_game_id=VALUES(current_game_id),
		 note=VALUES(note),
		 updated_at=VALUES(updated_at)`,
		stage, playerID, gameID, clipNote(note), time.Now())
	if err != nil {
		return fmt.Errorf("update crawl progress: %w", err)
	}
	return nil
}

func clipNote(s string) string {
	s = strings.TrimSpace(s)
	runes := []rune(s)
	if len(runes) <= 255 {
		return s
	}
	return string(runes[:252]) + "..."
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

// —— tolerant field coercion (numbers may arrive as JSON numbers or quoted strings) ——

func asInt(raw json.RawMessage) (int64, bool) {
	if len(raw) == 0 {
		return 0, false
	}
	var n json.Number
	if json.Unmarshal(raw, &n) == nil {
		if i, err := n.Int64(); err == nil {
			return i, true
		}
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		if i, err := strconv.ParseInt(strings.TrimSpace(s), 10, 64); err == nil {
			return i, true
		}
	}
	return 0, false
}

func asStrOr(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var n json.Number
	if json.Unmarshal(raw, &n) == nil {
		return n.String()
	}
	return ""
}

// nullable insert helpers: return nil (SQL NULL) when absent/empty.
func niInt(raw json.RawMessage) any {
	if i, ok := asInt(raw); ok {
		return i
	}
	return nil
}
func niStr(raw json.RawMessage) any {
	if s := asStrOr(raw); s != "" {
		return s
	}
	return nil
}
func niStrVal(s string) any {
	if s == "" {
		return nil
	}
	return s
}
func niZero(i int) any {
	if i == 0 {
		return nil
	}
	return i
}
func niZero64(i int64) any {
	if i == 0 {
		return nil
	}
	return i
}
func niDate(raw json.RawMessage) any {
	s := asStrOr(raw)
	if s == "" {
		return nil
	}
	return s
}

func nullableNumber(raw json.RawMessage) any {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	var n json.Number
	if json.Unmarshal(raw, &n) == nil {
		if f, err := n.Float64(); err == nil {
			return f
		}
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		if f, err := strconv.ParseFloat(strings.TrimSpace(s), 64); err == nil {
			return f
		}
	}
	return nil
}

func nullableFlag(raw json.RawMessage) any {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	var b bool
	if json.Unmarshal(raw, &b) == nil {
		if b {
			return 1
		}
		return 0
	}
	if n, ok := asInt(raw); ok {
		if n != 0 {
			return 1
		}
		return 0
	}
	return nil
}
