// player-analysis-build turns raw crawl tables into reproducible T2 facts,
// player-period metrics, and distribution-calibrated labels.
package main

import (
	"context"
	"crypto/sha256"
	"database/sql"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"math"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	_ "github.com/go-sql-driver/mysql"

	"huashanquery/internal/player"
)

//go:embed schema.sql
var schemaSQL string

const (
	algorithmVersion   = "t2-labels-v4"
	knowledgeVersion   = "2026-09-19"
	minimumDenominator = 10
	minimumCohortSize  = 30
	priorWeight        = 20.0
)

// goodFindSkills are the good-side skills whose target being a wolf counts as a
// find-wolf hit (merged with day votes into findwolf_rate). Matches the research bench.
var goodFindSkills = map[string]bool{
	"预言家": true, "女巫毒": true, "猎人枪": true, "骑士骑": true,
	"侦探翻": true, "猎魔人": true, "警犬查验": true,
}

func isFindSkill(name string) bool { return goodFindSkills[strings.TrimSpace(name)] }

// godRoles are the 神职 (good non-civilian) roles, per docs/standards/werewolf-language.md.
var godRoles = map[string]bool{
	"预言家": true, "女巫": true, "猎人": true, "白痴": true, "守卫": true, "骑士": true,
	"守墓人": true, "摄梦人": true, "猎魔人": true, "警犬": true, "熊": true, "侦探": true,
}

type config struct {
	DSN     string
	Rebuild bool
	Status  bool
}

type sourceGame struct {
	ID, SeasonID, SeasonTypeID, EditionID, VictoryCamp, TotalDays int64
	PlayDate, EditionName                                         sql.NullString
	MVPSeat, SVPSeat, BGXSeat                                     sql.NullInt64
	RosterOK                                                      int64
	RosterIssue                                                   sql.NullString
	FetchedAt                                                     time.Time
	Raw, Hash                                                     string
}

type sourcePlayer struct {
	Seat                                        int
	PlayerID, SectID, RoleID                    sql.NullInt64
	PlayerName, SectName, RoleName, HantiaoRole sql.NullString
	DayHantiao, DayBadge, SelfDestructDay       sql.NullInt64
	SkillsJSON                                  sql.NullString
}

type skillRow struct {
	Day     int               `json:"day"`
	Name    string            `json:"name"`
	Targets []json.RawMessage `json:"target_seats"`
}

type factPlayer struct {
	GameID                                      int64
	Seat                                        int
	PlayerID                                    sql.NullInt64
	PlayerName                                  sql.NullString
	Camp                                        string
	Won, MVP, SVP, BGX, FinalAlive              int
	DayVoteEvents, GoodVoteEvents, GoodVoteHits int
	BadgeVoteEvents, BadgeVoteHits              int
	WolfChargeVotes, WolfHookVotes              int
	FindSkillEvents, FindSkillHits              int
	CheckedBySeer, CheckedAsWolf                int
	HantiaoGames, SelfDestructGames, BadgeGames int
	ZhanbianAtt, ZhanbianCorrect, ZhanbianExiled int
	IsCiv, CivNightDeath, IsGod, GodAlive       int
	NightmareAtt, NightmareGod, CharmAtt, CharmGod int
	SeerCleared, SeerDuel, SeerDuelWin, HantiaoDuel, HantiaoDuelWin int
	DeathDay                                    sql.NullInt64
	PlayDate                                    sql.NullString
}

type periodKey struct {
	PlayerID          int64
	Camp, Type, Value string
}

type periodAgg struct {
	PlayerName                                            string
	Games, Wins, MVP, SVP, BGX, Alive                     int
	DayVotes, GoodVotes, GoodHits, BadgeVotes, BadgeHits  int
	WolfCharge, WolfHook, HantiaoGames, SelfDestructGames int
	FindSkillEvents, FindSkillHits, BadgeGames            int
	HantiaoBadgeGames, ExposedGames, ExposedSurvivedGames int
	ChargeGames, ChargeSurvived, HookGames, HookSurvived  int
	D3AliveGames, CheckedGames                            int
	WonFwHits, WonFwAtt, LostFwHits, LostFwAtt            int
	ZhanbianAtt, ZhanbianCorrect, ZhanbianExiled          int
	CivGames, CivNightDeaths, GodGames, GodAlive          int
	NightmareAtt, NightmareGod, CharmAtt, CharmGod        int
	SeerClearedGames                                      int
	SeerDuelGames, SeerDuelWins, HantiaoDuelGames, HantiaoDuelWins int
}

type metricDef struct {
	Key, Type, Direction, Camp string
	Values                     func(*periodAgg) (int, int)
}

type metricValue struct {
	Period      periodKey
	Def         metricDef
	Numerator   int
	Denominator int
	Raw         float64
	Baseline    float64
	Smoothed    float64
	Eligible    bool
}

type cohortKey struct {
	Metric, Camp, PeriodType, PeriodKey string
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "player-analysis-build failed:", err)
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
	db, err := sql.Open("mysql", cfg.DSN)
	if err != nil {
		return fmt.Errorf("open database: %w", err)
	}
	defer db.Close()
	db.SetMaxOpenConns(4)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		return fmt.Errorf("connect database: %w", err)
	}
	if err := ensureSchema(db); err != nil {
		return fmt.Errorf("apply analysis schema: %w", err)
	}
	if cfg.Status {
		return printStatus(db)
	}
	return build(db, cfg.Rebuild)
}

func parseConfig(args []string) (config, error) {
	fs := flag.NewFlagSet("player-analysis-build", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	dsn := fs.String("dsn", "root@tcp(127.0.0.1:3306)/huashan?charset=utf8mb4&parseTime=true&loc=Local", "MySQL DSN")
	rebuild := fs.Bool("rebuild", false, "rebuild every deterministic fact instead of refreshing changed games")
	status := fs.Bool("status", false, "show the latest analysis run and coverage without rebuilding")
	if err := fs.Parse(args); err != nil {
		return config{}, err
	}
	if *rebuild && *status {
		return config{}, errors.New("rebuild and status cannot be used together")
	}
	return config{DSN: strings.TrimSpace(*dsn), Rebuild: *rebuild, Status: *status}, nil
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
	for _, statement := range strings.Split(b.String(), ";") {
		statement = strings.TrimSpace(statement)
		if statement == "" {
			continue
		}
		if _, err := db.Exec(statement); err != nil {
			return fmt.Errorf("execute %q: %w", firstLine(statement), err)
		}
	}
	return ensureAnalysisColumns(db)
}

// ensureAnalysisColumns adds columns introduced after a table was first created, so
// existing analysis databases pick up new derived fields without a manual drop.
func ensureAnalysisColumns(db *sql.DB) error {
	cols := []struct{ table, name, ddl string }{
		{"analysis_game_players", "find_skill_events", "INT NOT NULL DEFAULT 0"},
		{"analysis_game_players", "find_skill_hits", "INT NOT NULL DEFAULT 0"},
		{"analysis_game_players", "checked_by_seer", "INT NOT NULL DEFAULT 0"},
		{"analysis_game_players", "checked_as_wolf", "INT NOT NULL DEFAULT 0"},
		{"analysis_game_players", "zhanbian_att", "INT NOT NULL DEFAULT 0"},
		{"analysis_game_players", "zhanbian_correct", "INT NOT NULL DEFAULT 0"},
		{"analysis_game_players", "zhanbian_correct_exiled", "INT NOT NULL DEFAULT 0"},
		{"analysis_game_players", "is_civ", "INT NOT NULL DEFAULT 0"},
		{"analysis_game_players", "civ_night_death", "INT NOT NULL DEFAULT 0"},
		{"analysis_game_players", "is_god", "INT NOT NULL DEFAULT 0"},
		{"analysis_game_players", "god_alive", "INT NOT NULL DEFAULT 0"},
		{"analysis_game_players", "nightmare_att", "INT NOT NULL DEFAULT 0"},
		{"analysis_game_players", "nightmare_god", "INT NOT NULL DEFAULT 0"},
		{"analysis_game_players", "charm_att", "INT NOT NULL DEFAULT 0"},
		{"analysis_game_players", "charm_god", "INT NOT NULL DEFAULT 0"},
		{"analysis_game_players", "seer_cleared", "INT NOT NULL DEFAULT 0"},
		{"analysis_game_players", "seer_duel", "INT NOT NULL DEFAULT 0"},
		{"analysis_game_players", "seer_duel_win", "INT NOT NULL DEFAULT 0"},
		{"analysis_game_players", "hantiao_duel", "INT NOT NULL DEFAULT 0"},
		{"analysis_game_players", "hantiao_duel_win", "INT NOT NULL DEFAULT 0"},
		{"analysis_player_periods", "find_skill_events", "INT NOT NULL DEFAULT 0"},
		{"analysis_player_periods", "find_skill_hits", "INT NOT NULL DEFAULT 0"},
		{"analysis_player_periods", "badge_games", "INT NOT NULL DEFAULT 0"},
		{"analysis_player_periods", "hantiao_badge_games", "INT NOT NULL DEFAULT 0"},
		{"analysis_player_periods", "exposed_games", "INT NOT NULL DEFAULT 0"},
		{"analysis_player_periods", "exposed_survived_games", "INT NOT NULL DEFAULT 0"},
		{"analysis_player_periods", "charge_games", "INT NOT NULL DEFAULT 0"},
		{"analysis_player_periods", "charge_survived_games", "INT NOT NULL DEFAULT 0"},
		{"analysis_player_periods", "hook_games", "INT NOT NULL DEFAULT 0"},
		{"analysis_player_periods", "hook_survived_games", "INT NOT NULL DEFAULT 0"},
		{"analysis_player_periods", "d3_alive_games", "INT NOT NULL DEFAULT 0"},
		{"analysis_player_periods", "checked_games", "INT NOT NULL DEFAULT 0"},
		{"analysis_player_periods", "won_fw_hits", "INT NOT NULL DEFAULT 0"},
		{"analysis_player_periods", "won_fw_att", "INT NOT NULL DEFAULT 0"},
		{"analysis_player_periods", "lost_fw_hits", "INT NOT NULL DEFAULT 0"},
		{"analysis_player_periods", "lost_fw_att", "INT NOT NULL DEFAULT 0"},
		{"analysis_player_periods", "zhanbian_att", "INT NOT NULL DEFAULT 0"},
		{"analysis_player_periods", "zhanbian_correct", "INT NOT NULL DEFAULT 0"},
		{"analysis_player_periods", "zhanbian_correct_exiled", "INT NOT NULL DEFAULT 0"},
		{"analysis_player_periods", "civ_games", "INT NOT NULL DEFAULT 0"},
		{"analysis_player_periods", "civ_night_deaths", "INT NOT NULL DEFAULT 0"},
		{"analysis_player_periods", "god_games", "INT NOT NULL DEFAULT 0"},
		{"analysis_player_periods", "god_alive_games", "INT NOT NULL DEFAULT 0"},
		{"analysis_player_periods", "nightmare_att", "INT NOT NULL DEFAULT 0"},
		{"analysis_player_periods", "nightmare_god", "INT NOT NULL DEFAULT 0"},
		{"analysis_player_periods", "charm_att", "INT NOT NULL DEFAULT 0"},
		{"analysis_player_periods", "charm_god", "INT NOT NULL DEFAULT 0"},
		{"analysis_player_periods", "seer_cleared_games", "INT NOT NULL DEFAULT 0"},
		{"analysis_player_periods", "seer_duel_games", "INT NOT NULL DEFAULT 0"},
		{"analysis_player_periods", "seer_duel_wins", "INT NOT NULL DEFAULT 0"},
		{"analysis_player_periods", "hantiao_duel_games", "INT NOT NULL DEFAULT 0"},
		{"analysis_player_periods", "hantiao_duel_wins", "INT NOT NULL DEFAULT 0"},
	}
	for _, c := range cols {
		var n int
		if err := db.QueryRow(`SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=? AND column_name=?`, c.table, c.name).Scan(&n); err != nil {
			return fmt.Errorf("inspect %s.%s: %w", c.table, c.name, err)
		}
		if n == 0 {
			if _, err := db.Exec("ALTER TABLE " + c.table + " ADD COLUMN " + c.name + " " + c.ddl); err != nil {
				return fmt.Errorf("add %s.%s: %w", c.table, c.name, err)
			}
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

func build(db *sql.DB, forceRebuild bool) (retErr error) {
	games, fingerprint, err := loadGames(db)
	if err != nil {
		return err
	}
	if len(games) == 0 {
		return errors.New("source games table is empty")
	}
	oldHashes, latestAlgorithm, latestKnowledge, err := loadAnalysisState(db)
	if err != nil {
		return err
	}
	full := forceRebuild || len(oldHashes) == 0 || latestAlgorithm != algorithmVersion || latestKnowledge != knowledgeVersion
	newIDs, changedIDs, removedIDs := classifyChanges(games, oldHashes)
	if full {
		newIDs = nil
		changedIDs = make([]int64, 0, len(games))
		for _, game := range games {
			changedIDs = append(changedIDs, game.ID)
		}
	}
	mode := "refresh"
	if full {
		mode = "rebuild"
	}
	maxID, maxDate := sourceCutoff(games)
	runID, err := startRun(db, mode, len(games), maxID, maxDate, fingerprint, len(newIDs), len(changedIDs), len(removedIDs))
	if err != nil {
		return err
	}
	defer func() {
		if retErr != nil {
			_, _ = db.Exec(`UPDATE analysis_runs SET status='failed', error_message=?, completed_at=NOW() WHERE run_id=?`, clip(retErr.Error(), 512), runID)
		}
	}()

	toProcess := append(append([]int64(nil), newIDs...), changedIDs...)
	if !full && len(toProcess) == 0 && len(removedIDs) == 0 {
		fmt.Printf("Source is unchanged; rebuilding aggregates and labels as run %d.\n", runID)
	}
	playersByGame, err := loadSourcePlayers(db, idSet(toProcess))
	if err != nil {
		return err
	}

	tx, err := db.BeginTx(context.Background(), &sql.TxOptions{Isolation: sql.LevelRepeatableRead})
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if full {
		if err := clearFacts(tx); err != nil {
			return err
		}
	} else if err := deleteGameFacts(tx, append(append([]int64(nil), changedIDs...), removedIDs...)); err != nil {
		return err
	}

	processSet := idSet(toProcess)
	valid, invalid := 0, 0
	for i := range games {
		game := &games[i]
		if !processSet[game.ID] {
			continue
		}
		ok, err := storeGameFacts(tx, runID, game, playersByGame[game.ID])
		if err != nil {
			return fmt.Errorf("game %d: %w", game.ID, err)
		}
		if ok {
			valid++
		} else {
			invalid++
		}
		if (valid+invalid)%1000 == 0 {
			fmt.Printf("Normalized %d/%d changed games.\n", valid+invalid, len(toProcess))
		}
	}

	periods, err := rebuildPeriods(tx, runID)
	if err != nil {
		return err
	}
	metricCount, labelCount, err := rebuildLabels(tx, runID, periods)
	if err != nil {
		return err
	}
	if err := validateBuild(tx, len(games)); err != nil {
		return err
	}
	if _, err := tx.Exec(`UPDATE analysis_runs SET status='ready', processed_games=?, valid_games=?, invalid_games=?, completed_at=NOW() WHERE run_id=?`, len(toProcess), valid, invalid, runID); err != nil {
		return err
	}
	if _, err := tx.Exec(`INSERT INTO analysis_state (state_id, latest_run_id, updated_at) VALUES (1, ?, NOW()) ON DUPLICATE KEY UPDATE latest_run_id=VALUES(latest_run_id), updated_at=VALUES(updated_at)`, runID); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	fmt.Printf("Analysis run %d is ready: %d source games, %d normalized now, %d invalid now, %d period rows, %d metrics, %d labels.\n", runID, len(games), valid, invalid, len(periods), metricCount, labelCount)
	return nil
}

func loadGames(db *sql.DB) ([]sourceGame, string, error) {
	rows, err := db.Query(`SELECT game_id, play_date, season_id, season_type_id, edition_id, edition_name, victory_camp, total_days, mvp_seat, svp_seat, bgx_seat, roster_ok, roster_issue, fetched_at, raw_json FROM games ORDER BY game_id`)
	if err != nil {
		return nil, "", fmt.Errorf("load source games: %w", err)
	}
	defer rows.Close()
	h := sha256.New()
	var games []sourceGame
	for rows.Next() {
		var g sourceGame
		var seasonID, seasonTypeID, editionID, victoryCamp, totalDays sql.NullInt64
		if err := rows.Scan(&g.ID, &g.PlayDate, &seasonID, &seasonTypeID, &editionID, &g.EditionName, &victoryCamp, &totalDays, &g.MVPSeat, &g.SVPSeat, &g.BGXSeat, &g.RosterOK, &g.RosterIssue, &g.FetchedAt, &g.Raw); err != nil {
			return nil, "", err
		}
		g.SeasonID, g.SeasonTypeID, g.EditionID, g.VictoryCamp, g.TotalDays = nullInt(seasonID), nullInt(seasonTypeID), nullInt(editionID), nullInt(victoryCamp), nullInt(totalDays)
		sum := sha256.Sum256([]byte(g.Raw))
		g.Hash = hex.EncodeToString(sum[:])
		fmt.Fprintf(h, "%d:%s\n", g.ID, g.Hash)
		games = append(games, g)
	}
	if err := rows.Err(); err != nil {
		return nil, "", err
	}
	return games, hex.EncodeToString(h.Sum(nil)), nil
}

func loadAnalysisState(db *sql.DB) (map[int64]string, string, string, error) {
	hashes := map[int64]string{}
	rows, err := db.Query(`SELECT game_id, source_hash FROM analysis_games`)
	if err != nil {
		return nil, "", "", err
	}
	for rows.Next() {
		var id int64
		var hash string
		if err := rows.Scan(&id, &hash); err != nil {
			rows.Close()
			return nil, "", "", err
		}
		hashes[id] = hash
	}
	if err := rows.Close(); err != nil {
		return nil, "", "", err
	}
	var algorithm, knowledge sql.NullString
	err = db.QueryRow(`SELECT r.algorithm_version, r.knowledge_version FROM analysis_state s JOIN analysis_runs r ON r.run_id=s.latest_run_id WHERE s.state_id=1 AND r.status='ready'`).Scan(&algorithm, &knowledge)
	if err != nil && err != sql.ErrNoRows {
		return nil, "", "", err
	}
	return hashes, algorithm.String, knowledge.String, nil
}

func classifyChanges(games []sourceGame, old map[int64]string) (newIDs, changedIDs, removedIDs []int64) {
	seen := make(map[int64]bool, len(games))
	for _, game := range games {
		seen[game.ID] = true
		hash, exists := old[game.ID]
		switch {
		case !exists:
			newIDs = append(newIDs, game.ID)
		case hash != game.Hash:
			changedIDs = append(changedIDs, game.ID)
		}
	}
	for id := range old {
		if !seen[id] {
			removedIDs = append(removedIDs, id)
		}
	}
	sort.Slice(removedIDs, func(i, j int) bool { return removedIDs[i] < removedIDs[j] })
	return
}

func sourceCutoff(games []sourceGame) (int64, any) {
	var maxID int64
	var maxDate string
	for _, game := range games {
		if game.ID > maxID {
			maxID = game.ID
		}
		if game.PlayDate.Valid && game.PlayDate.String > maxDate {
			maxDate = game.PlayDate.String
		}
	}
	if maxDate == "" {
		return maxID, nil
	}
	return maxID, maxDate
}

func startRun(db *sql.DB, mode string, count int, maxID int64, maxDate any, fingerprint string, newCount, changedCount, removedCount int) (int64, error) {
	res, err := db.Exec(`INSERT INTO analysis_runs (mode,status,algorithm_version,knowledge_version,source_game_count,source_max_game_id,source_max_play_date,source_fingerprint,new_games,changed_games,removed_games,started_at) VALUES (?, 'building', ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`, mode, algorithmVersion, knowledgeVersion, count, maxID, maxDate, fingerprint, newCount, changedCount, removedCount)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func loadSourcePlayers(db *sql.DB, wanted map[int64]bool) (map[int64][]sourcePlayer, error) {
	out := map[int64][]sourcePlayer{}
	if len(wanted) == 0 {
		return out, nil
	}
	rows, err := db.Query(`SELECT game_id,seat,player_id,player_name,sect_id,sect_name,rpt_id,rpt_name,day_of_hantiao,hantiao_rpt_name,day_of_jinhui,zibao_day,skills_json FROM game_players ORDER BY game_id,seat`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var gameID int64
		var p sourcePlayer
		if err := rows.Scan(&gameID, &p.Seat, &p.PlayerID, &p.PlayerName, &p.SectID, &p.SectName, &p.RoleID, &p.RoleName, &p.DayHantiao, &p.HantiaoRole, &p.DayBadge, &p.SelfDestructDay, &p.SkillsJSON); err != nil {
			return nil, err
		}
		if wanted[gameID] {
			out[gameID] = append(out[gameID], p)
		}
	}
	return out, rows.Err()
}

func storeGameFacts(tx *sql.Tx, runID int64, game *sourceGame, seats []sourcePlayer) (bool, error) {
	if game.RosterOK == 0 {
		reason := "roster invalid"
		if game.RosterIssue.Valid && game.RosterIssue.String != "" {
			reason = "roster invalid: " + game.RosterIssue.String
		}
		_, err := tx.Exec(`INSERT INTO analysis_games (game_id,source_hash,source_fetched_at,analysis_run_id,play_date,season_id,season_type_id,edition_id,edition_name,victory_camp,total_days,parsed_ok,roster_count,vote_count,skill_event_count,death_count,doubt_count,parse_error,analyzed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,0,0,0,0,0,0,?,NOW())`, game.ID, game.Hash, game.FetchedAt, runID, nullableString(game.PlayDate), nullableInt64(game.SeasonID), nullableInt64(game.SeasonTypeID), nullableInt64(game.EditionID), nullableString(game.EditionName), nullableInt64(game.VictoryCamp), nullableInt64(game.TotalDays), clip(reason, 255))
		return false, err
	}
	an, parseErr := player.AnalyzeGame([]byte(game.Raw))
	if parseErr != nil {
		_, err := tx.Exec(`INSERT INTO analysis_games (game_id,source_hash,source_fetched_at,analysis_run_id,play_date,season_id,season_type_id,edition_id,edition_name,victory_camp,total_days,parsed_ok,roster_count,vote_count,skill_event_count,death_count,doubt_count,parse_error,analyzed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,0,0,0,0,0,0,?,NOW())`, game.ID, game.Hash, game.FetchedAt, runID, nullableString(game.PlayDate), nullableInt64(game.SeasonID), nullableInt64(game.SeasonTypeID), nullableInt64(game.EditionID), nullableString(game.EditionName), nullableInt64(game.VictoryCamp), nullableInt64(game.TotalDays), clip(parseErr.Error(), 255))
		return false, err
	}
	bySeat := make(map[int]sourcePlayer, len(seats))
	for _, seat := range seats {
		bySeat[seat.Seat] = seat
	}
	camps := map[int]string{}
	for _, seat := range an.Roster.Wolf {
		camps[seat] = "wolf"
	}
	for _, seat := range an.Roster.Gods {
		camps[seat] = "good"
	}
	for _, seat := range an.Roster.Civ {
		camps[seat] = "good"
	}
	alive := map[int]bool{}
	for _, seat := range an.Alive {
		alive[seat] = true
	}
	deaths := map[int]player.Death{}
	for _, death := range an.Deaths {
		deaths[death.Seat] = death
	}

	type voteCounts struct{ day, good, goodHit, badge, badgeHit, charge, hook int }
	counts := map[int]*voteCounts{}
	for seat := 1; seat <= 12; seat++ {
		counts[seat] = &voteCounts{}
	}
	voteRows := 0
	insertVote := func(kind string, day int, vote player.Vote) error {
		voter := bySeat[vote.Seat]
		target := bySeat[vote.Target]
		voterCamp, targetCamp := camps[vote.Seat], camps[vote.Target]
		abstain := vote.Abstain || vote.Target < 1 || vote.Target > 12
		var targetSeat, targetPlayerID, targetCampValue any
		if !abstain {
			targetSeat = vote.Target
			targetPlayerID = nullableInt(target.PlayerID)
			targetCampValue = targetCamp
		}
		var goodHit, wolfType any
		c := counts[vote.Seat]
		if kind == "day" {
			c.day++
			if voterCamp == "good" && !abstain {
				c.good++
				if targetCamp == "wolf" {
					c.goodHit++
					goodHit = 1
				} else {
					goodHit = 0
				}
			}
			if voterCamp == "wolf" && !abstain {
				if targetCamp == "wolf" {
					c.hook++
					wolfType = "hook"
				} else if targetCamp == "good" {
					c.charge++
					wolfType = "charge"
				}
			}
		} else if voterCamp == "good" && !abstain {
			c.badge++
			if targetCamp == "wolf" {
				c.badgeHit++
				goodHit = 1
			} else {
				goodHit = 0
			}
		}
		_, err := tx.Exec(`INSERT INTO analysis_votes (game_id,vote_kind,day,voter_seat,analysis_run_id,voter_player_id,voter_camp,target_seat,target_player_id,target_camp,weight,badge_weight,abstain,good_vote_hit,wolf_vote_type) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, game.ID, kind, day, vote.Seat, runID, nullableInt(voter.PlayerID), voterCamp, targetSeat, targetPlayerID, targetCampValue, vote.Weight, boolInt(vote.Badge), boolInt(abstain), goodHit, wolfType)
		if err == nil {
			voteRows++
		}
		return err
	}
	for _, vote := range an.BadgeVotes {
		if err := insertVote("badge", 0, vote); err != nil {
			return false, err
		}
	}
	days := make([]int, 0, len(an.Votes))
	for key := range an.Votes {
		day, _ := strconv.Atoi(key)
		days = append(days, day)
	}
	sort.Ints(days)
	for _, day := range days {
		for _, vote := range an.Votes[strconv.Itoa(day)] {
			if err := insertVote("day", day, vote); err != nil {
				return false, err
			}
		}
	}

	skillRows := 0
	findAtt := map[int]int{}
	findHit := map[int]int{}
	checked := map[int]int{}
	checkedWolf := map[int]int{}
	nmAtt := map[int]int{}
	nmGod := map[int]int{}
	charmAtt := map[int]int{}
	charmGod := map[int]int{}
	for seat := 1; seat <= 12; seat++ {
		p := bySeat[seat]
		if !p.SkillsJSON.Valid {
			continue
		}
		var skills []skillRow
		if err := json.Unmarshal([]byte(p.SkillsJSON.String), &skills); err != nil {
			return false, fmt.Errorf("decode seat %d skills: %w", seat, err)
		}
		for eventIndex, skill := range skills {
			if strings.TrimSpace(skill.Name) == "" {
				continue
			}
			targets := skill.Targets
			if len(targets) == 0 {
				targets = []json.RawMessage{nil}
			}
			for targetIndex, rawTarget := range targets {
				targetSeat := rawInt(rawTarget)
				target := bySeat[targetSeat]
				phase := "night"
				if isDaySkill(skill.Name) {
					phase = "day"
				}
				if camps[seat] == "good" && isFindSkill(skill.Name) && targetSeat >= 1 && targetSeat <= 12 {
					findAtt[seat]++
					if camps[targetSeat] == "wolf" {
						findHit[seat]++
					}
				}
				if skill.Name == "预言家" && targetSeat >= 1 && targetSeat <= 12 {
					checked[targetSeat] = 1
					if camps[targetSeat] == "wolf" {
						checkedWolf[targetSeat] = 1
					}
				}
				if camps[seat] == "wolf" && targetSeat >= 1 && targetSeat <= 12 {
					targetGod := camps[targetSeat] == "good" && godRoles[bySeat[targetSeat].RoleName.String]
					if bySeat[seat].RoleName.String == "梦魇" && skill.Name == "梦魇" {
						nmAtt[seat]++
						if targetGod {
							nmGod[seat]++
						}
					}
					if bySeat[seat].RoleName.String == "狼美人" && skill.Name == "狼美人" {
						charmAtt[seat]++
						if targetGod {
							charmGod[seat]++
						}
					}
				}
				_, err := tx.Exec(`INSERT INTO analysis_skill_events (game_id,actor_seat,event_index,target_index,analysis_run_id,actor_player_id,actor_camp,actor_role_name,day,phase,skill_name,target_seat,target_player_id,target_camp,target_role_name) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, game.ID, seat, eventIndex, targetIndex, runID, nullableInt(p.PlayerID), camps[seat], nullableString(p.RoleName), skill.Day, phase, skill.Name, nullableSeat(targetSeat), nullableInt(target.PlayerID), nullableCamp(camps[targetSeat]), nullableString(target.RoleName))
				if err != nil {
					return false, err
				}
				skillRows++
			}
		}
	}

	doubts := 0
	for _, death := range an.Deaths {
		p := bySeat[death.Seat]
		if death.Doubt {
			doubts++
		}
		if _, err := tx.Exec(`INSERT INTO analysis_deaths (game_id,seat,analysis_run_id,player_id,camp,role_name,day,phase,cause,doubt) VALUES (?,?,?,?,?,?,?,?,?,?)`, game.ID, death.Seat, runID, nullableInt(p.PlayerID), camps[death.Seat], nullableString(p.RoleName), death.Day, death.Phase, death.Cause, boolInt(death.Doubt)); err != nil {
			return false, err
		}
	}
	if len(bySeat) != 12 {
		return false, fmt.Errorf("source game_players has %d seats, want 12", len(bySeat))
	}

	// —— 对跳 / 站对边 / 身份条件化（自算，以准为先）——
	realSeer := 0
	for s := 1; s <= 12; s++ {
		if camps[s] == "good" && bySeat[s].RoleName.String == "预言家" {
			realSeer = s
			break
		}
	}
	hantiaoWolf := map[int]bool{}
	for s := 1; s <= 12; s++ {
		if camps[s] == "wolf" && bySeat[s].HantiaoRole.String == "预言家" {
			hantiaoWolf[s] = true
		}
	}
	duiTiao := realSeer != 0 && len(hantiaoWolf) > 0
	exiled := map[int]bool{}
	for _, d := range an.Deaths {
		if d.Cause == "exile" {
			exiled[d.Seat] = true
		}
	}
	_, seerDied := deaths[realSeer]
	seerClearedGame := realSeer != 0 && seerDied

	badgeTgt := map[int]int{}
	for _, v := range an.BadgeVotes {
		if !v.Abstain && v.Target >= 1 && v.Target <= 12 {
			badgeTgt[v.Seat] = v.Target
		}
	}
	day1Tgt := map[int]int{}
	if len(days) > 0 {
		for _, v := range an.Votes[strconv.Itoa(days[0])] {
			if !v.Abstain && v.Target >= 1 && v.Target <= 12 {
				day1Tgt[v.Seat] = v.Target
			}
		}
	}

	zbAtt, zbCorrect, zbExiled := map[int]int{}, map[int]int{}, map[int]int{}
	isCiv, civNight, isGod, godAlive := map[int]int{}, map[int]int{}, map[int]int{}, map[int]int{}
	seerCleared := map[int]int{}
	seerDuelM, seerDuelWinM := map[int]int{}, map[int]int{}
	hantiaoDuelM, hantiaoDuelWinM := map[int]int{}, map[int]int{}
	for s := 1; s <= 12; s++ {
		role := bySeat[s].RoleName.String
		if camps[s] == "good" {
			if role == "平民" {
				isCiv[s] = 1
				if d, ok := deaths[s]; ok && d.Phase == "night" && d.Day >= 2 {
					civNight[s] = 1
				}
			} else {
				isGod[s] = 1
				if alive[s] {
					godAlive[s] = 1
				}
			}
			if duiTiao && s != realSeer {
				decided := 0 // 1 站对, -1 站错（警徽票为主，首日放逐票兜底）
				if t, ok := badgeTgt[s]; ok {
					if t == realSeer {
						decided = 1
					} else if hantiaoWolf[t] {
						decided = -1
					}
				}
				if decided == 0 {
					if t, ok := day1Tgt[s]; ok {
						if hantiaoWolf[t] {
							decided = 1
						} else if t == realSeer {
							decided = -1
						}
					}
				}
				if decided != 0 {
					zbAtt[s] = 1
					if decided == 1 {
						zbCorrect[s] = 1
						if exiled[s] {
							zbExiled[s] = 1
						}
					}
				}
			}
		}
		if camps[s] == "wolf" && seerClearedGame {
			seerCleared[s] = 1
		}
	}
	if duiTiao {
		seerDuelM[realSeer] = 1
		for w := range hantiaoWolf {
			if exiled[w] {
				seerDuelWinM[realSeer] = 1
			}
			hantiaoDuelM[w] = 1
			if seerClearedGame {
				hantiaoDuelWinM[w] = 1
			}
		}
	}

	for seat := 1; seat <= 12; seat++ {
		p, ok := bySeat[seat]
		if !ok {
			return false, fmt.Errorf("source game_players is missing seat %d", seat)
		}
		death, dead := deaths[seat]
		var deathDay, deathPhase, deathCause any
		deathDoubt := 0
		if dead {
			deathDay, deathPhase, deathCause, deathDoubt = death.Day, death.Phase, death.Cause, boolInt(death.Doubt)
		}
		camp := camps[seat]
		won := 0
		if (camp == "good" && game.VictoryCamp == 1) || (camp == "wolf" && game.VictoryCamp == 2) {
			won = 1
		}
		c := counts[seat]
		_, err := tx.Exec(`INSERT INTO analysis_game_players (game_id,seat,analysis_run_id,player_id,player_name,sect_id,sect_name,role_id,role_name,camp,won,final_alive,death_day,death_phase,death_cause,death_doubt,mvp,svp,bgx,day_of_hantiao,hantiao_role_name,day_of_badge,self_destruct_day,day_vote_events,good_vote_events,good_vote_hits,badge_vote_events,badge_vote_hits,wolf_charge_votes,wolf_hook_votes,find_skill_events,find_skill_hits,checked_by_seer,checked_as_wolf,zhanbian_att,zhanbian_correct,zhanbian_correct_exiled,is_civ,civ_night_death,is_god,god_alive,nightmare_att,nightmare_god,charm_att,charm_god,seer_cleared,seer_duel,seer_duel_win,hantiao_duel,hantiao_duel_win) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, game.ID, seat, runID, nullableInt(p.PlayerID), nullableString(p.PlayerName), nullableInt(p.SectID), nullableString(p.SectName), nullableInt(p.RoleID), nullableString(p.RoleName), camp, won, boolInt(alive[seat]), deathDay, deathPhase, deathCause, deathDoubt, boolInt(game.MVPSeat.Valid && game.MVPSeat.Int64 == int64(seat)), boolInt(game.SVPSeat.Valid && game.SVPSeat.Int64 == int64(seat)), boolInt(game.BGXSeat.Valid && game.BGXSeat.Int64 == int64(seat)), nullableInt(p.DayHantiao), nullableString(p.HantiaoRole), nullableInt(p.DayBadge), nullableInt(p.SelfDestructDay), c.day, c.good, c.goodHit, c.badge, c.badgeHit, c.charge, c.hook, findAtt[seat], findHit[seat], checked[seat], checkedWolf[seat], zbAtt[seat], zbCorrect[seat], zbExiled[seat], isCiv[seat], civNight[seat], isGod[seat], godAlive[seat], nmAtt[seat], nmGod[seat], charmAtt[seat], charmGod[seat], seerCleared[seat], seerDuelM[seat], seerDuelWinM[seat], hantiaoDuelM[seat], hantiaoDuelWinM[seat])
		if err != nil {
			return false, err
		}
	}
	_, err := tx.Exec(`INSERT INTO analysis_games (game_id,source_hash,source_fetched_at,analysis_run_id,play_date,season_id,season_type_id,edition_id,edition_name,victory_camp,total_days,parsed_ok,roster_count,vote_count,skill_event_count,death_count,doubt_count,parse_error,analyzed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,NULL,NOW())`, game.ID, game.Hash, game.FetchedAt, runID, nullableString(game.PlayDate), nullableInt64(game.SeasonID), nullableInt64(game.SeasonTypeID), nullableInt64(game.EditionID), nullableString(game.EditionName), nullableInt64(game.VictoryCamp), nullableInt64(game.TotalDays), 12, voteRows, skillRows, len(an.Deaths), doubts)
	return err == nil, err
}

func clearFacts(tx *sql.Tx) error {
	for _, table := range []string{"analysis_votes", "analysis_skill_events", "analysis_deaths", "analysis_game_players", "analysis_games"} {
		if _, err := tx.Exec("DELETE FROM " + table); err != nil {
			return err
		}
	}
	return nil
}

func deleteGameFacts(tx *sql.Tx, ids []int64) error {
	if len(ids) == 0 {
		return nil
	}
	for start := 0; start < len(ids); start += 500 {
		end := min(start+500, len(ids))
		args := make([]any, end-start)
		marks := make([]string, end-start)
		for i, id := range ids[start:end] {
			args[i], marks[i] = id, "?"
		}
		for _, table := range []string{"analysis_votes", "analysis_skill_events", "analysis_deaths", "analysis_game_players", "analysis_games"} {
			if _, err := tx.Exec("DELETE FROM "+table+" WHERE game_id IN ("+strings.Join(marks, ",")+")", args...); err != nil {
				return err
			}
		}
	}
	return nil
}

func rebuildPeriods(tx *sql.Tx, runID int64) (map[periodKey]*periodAgg, error) {
	rows, err := tx.Query(`SELECT p.game_id,p.seat,p.player_id,p.player_name,p.camp,p.won,p.mvp,p.svp,p.bgx,p.final_alive,p.day_vote_events,p.good_vote_events,p.good_vote_hits,p.badge_vote_events,p.badge_vote_hits,p.wolf_charge_votes,p.wolf_hook_votes,p.find_skill_events,p.find_skill_hits,p.checked_by_seer,p.checked_as_wolf,p.zhanbian_att,p.zhanbian_correct,p.zhanbian_correct_exiled,p.is_civ,p.civ_night_death,p.is_god,p.god_alive,p.nightmare_att,p.nightmare_god,p.charm_att,p.charm_god,p.seer_cleared,p.seer_duel,p.seer_duel_win,p.hantiao_duel,p.hantiao_duel_win,p.death_day,(p.day_of_hantiao IS NOT NULL),(p.self_destruct_day IS NOT NULL),(p.day_of_badge IS NOT NULL),DATE_FORMAT(g.play_date,'%Y-%m-%d') FROM analysis_game_players p JOIN analysis_games g ON g.game_id=p.game_id WHERE g.parsed_ok=1 AND p.player_id IS NOT NULL ORDER BY p.player_id,p.camp,g.play_date DESC,p.game_id DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	periods := map[periodKey]*periodAgg{}
	var lastPlayer int64 = -1
	lastCamp := ""
	rank := 0
	for rows.Next() {
		var f factPlayer
		if err := rows.Scan(&f.GameID, &f.Seat, &f.PlayerID, &f.PlayerName, &f.Camp, &f.Won, &f.MVP, &f.SVP, &f.BGX, &f.FinalAlive, &f.DayVoteEvents, &f.GoodVoteEvents, &f.GoodVoteHits, &f.BadgeVoteEvents, &f.BadgeVoteHits, &f.WolfChargeVotes, &f.WolfHookVotes, &f.FindSkillEvents, &f.FindSkillHits, &f.CheckedBySeer, &f.CheckedAsWolf, &f.ZhanbianAtt, &f.ZhanbianCorrect, &f.ZhanbianExiled, &f.IsCiv, &f.CivNightDeath, &f.IsGod, &f.GodAlive, &f.NightmareAtt, &f.NightmareGod, &f.CharmAtt, &f.CharmGod, &f.SeerCleared, &f.SeerDuel, &f.SeerDuelWin, &f.HantiaoDuel, &f.HantiaoDuelWin, &f.DeathDay, &f.HantiaoGames, &f.SelfDestructGames, &f.BadgeGames, &f.PlayDate); err != nil {
			return nil, err
		}
		if f.PlayerID.Int64 != lastPlayer || f.Camp != lastCamp {
			lastPlayer, lastCamp, rank = f.PlayerID.Int64, f.Camp, 0
		}
		rank++
		addFact(periods, periodKey{f.PlayerID.Int64, f.Camp, "career", "all"}, f)
		if f.PlayDate.Valid && len(f.PlayDate.String) >= 4 {
			addFact(periods, periodKey{f.PlayerID.Int64, f.Camp, "year", f.PlayDate.String[:4]}, f)
		}
		for _, n := range []int{20, 30, 50, 100} {
			if rank <= n {
				addFact(periods, periodKey{f.PlayerID.Int64, f.Camp, "recent", strconv.Itoa(n)}, f)
			}
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(`DELETE FROM analysis_player_periods`); err != nil {
		return nil, err
	}
	keys := sortedPeriodKeys(periods)
	for _, key := range keys {
		a := periods[key]
		_, err := tx.Exec(`INSERT INTO analysis_player_periods (player_id,camp,period_type,period_key,analysis_run_id,player_name,games,wins,mvp_count,svp_count,bgx_count,final_alive_count,day_vote_events,good_vote_events,good_vote_hits,badge_vote_events,badge_vote_hits,wolf_charge_votes,wolf_hook_votes,hantiao_games,self_destruct_games,find_skill_events,find_skill_hits,badge_games,hantiao_badge_games,exposed_games,exposed_survived_games,charge_games,charge_survived_games,hook_games,hook_survived_games,d3_alive_games,checked_games,won_fw_hits,won_fw_att,lost_fw_hits,lost_fw_att,zhanbian_att,zhanbian_correct,zhanbian_correct_exiled,civ_games,civ_night_deaths,god_games,god_alive_games,nightmare_att,nightmare_god,charm_att,charm_god,seer_cleared_games,seer_duel_games,seer_duel_wins,hantiao_duel_games,hantiao_duel_wins) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, key.PlayerID, key.Camp, key.Type, key.Value, runID, nullableText(a.PlayerName), a.Games, a.Wins, a.MVP, a.SVP, a.BGX, a.Alive, a.DayVotes, a.GoodVotes, a.GoodHits, a.BadgeVotes, a.BadgeHits, a.WolfCharge, a.WolfHook, a.HantiaoGames, a.SelfDestructGames, a.FindSkillEvents, a.FindSkillHits, a.BadgeGames, a.HantiaoBadgeGames, a.ExposedGames, a.ExposedSurvivedGames, a.ChargeGames, a.ChargeSurvived, a.HookGames, a.HookSurvived, a.D3AliveGames, a.CheckedGames, a.WonFwHits, a.WonFwAtt, a.LostFwHits, a.LostFwAtt, a.ZhanbianAtt, a.ZhanbianCorrect, a.ZhanbianExiled, a.CivGames, a.CivNightDeaths, a.GodGames, a.GodAlive, a.NightmareAtt, a.NightmareGod, a.CharmAtt, a.CharmGod, a.SeerClearedGames, a.SeerDuelGames, a.SeerDuelWins, a.HantiaoDuelGames, a.HantiaoDuelWins)
		if err != nil {
			return nil, err
		}
	}
	return periods, nil
}

func addFact(periods map[periodKey]*periodAgg, key periodKey, f factPlayer) {
	a := periods[key]
	if a == nil {
		a = &periodAgg{}
		periods[key] = a
	}
	if a.PlayerName == "" && f.PlayerName.Valid {
		a.PlayerName = f.PlayerName.String
	}
	a.Games++
	a.Wins += f.Won
	a.MVP += f.MVP
	a.SVP += f.SVP
	a.BGX += f.BGX
	a.Alive += f.FinalAlive
	a.DayVotes += f.DayVoteEvents
	a.GoodVotes += f.GoodVoteEvents
	a.GoodHits += f.GoodVoteHits
	a.BadgeVotes += f.BadgeVoteEvents
	a.BadgeHits += f.BadgeVoteHits
	a.WolfCharge += f.WolfChargeVotes
	a.WolfHook += f.WolfHookVotes
	a.HantiaoGames += f.HantiaoGames
	a.SelfDestructGames += f.SelfDestructGames
	a.FindSkillEvents += f.FindSkillEvents
	a.FindSkillHits += f.FindSkillHits
	a.BadgeGames += f.BadgeGames
	if f.HantiaoGames == 1 && f.BadgeGames == 1 {
		a.HantiaoBadgeGames++
	}
	exposed := f.HantiaoGames == 1 || f.SelfDestructGames == 1 || f.WolfChargeVotes > 0
	if exposed {
		a.ExposedGames++
		if f.FinalAlive == 1 {
			a.ExposedSurvivedGames++
		}
	}
	if f.WolfChargeVotes > 0 {
		a.ChargeGames++
		if f.FinalAlive == 1 {
			a.ChargeSurvived++
		}
	}
	if f.WolfHookVotes > 0 {
		a.HookGames++
		if f.FinalAlive == 1 {
			a.HookSurvived++
		}
	}
	if f.FinalAlive == 1 || (f.DeathDay.Valid && f.DeathDay.Int64 >= 3) {
		a.D3AliveGames++
	}
	a.CheckedGames += f.CheckedBySeer
	fwAtt := f.GoodVoteEvents + f.FindSkillEvents
	fwHit := f.GoodVoteHits + f.FindSkillHits
	if f.Won == 1 {
		a.WonFwAtt += fwAtt
		a.WonFwHits += fwHit
	} else {
		a.LostFwAtt += fwAtt
		a.LostFwHits += fwHit
	}
	a.ZhanbianAtt += f.ZhanbianAtt
	a.ZhanbianCorrect += f.ZhanbianCorrect
	a.ZhanbianExiled += f.ZhanbianExiled
	a.CivGames += f.IsCiv
	a.CivNightDeaths += f.CivNightDeath
	a.GodGames += f.IsGod
	a.GodAlive += f.GodAlive
	a.NightmareAtt += f.NightmareAtt
	a.NightmareGod += f.NightmareGod
	a.CharmAtt += f.CharmAtt
	a.CharmGod += f.CharmGod
	a.SeerClearedGames += f.SeerCleared
	a.SeerDuelGames += f.SeerDuel
	a.SeerDuelWins += f.SeerDuelWin
	a.HantiaoDuelGames += f.HantiaoDuel
	a.HantiaoDuelWins += f.HantiaoDuelWin
}

func rebuildLabels(tx *sql.Tx, runID int64, periods map[periodKey]*periodAgg) (int, int, error) {
	defs := metricDefinitions()
	values := make([]*metricValue, 0, len(periods)*4)
	cohorts := map[cohortKey][]*metricValue{}
	for key, aggregate := range periods {
		for _, def := range defs {
			if def.Camp != "" && def.Camp != key.Camp {
				continue
			}
			numerator, denominator := def.Values(aggregate)
			value := &metricValue{Period: key, Def: def, Numerator: numerator, Denominator: denominator, Eligible: denominator >= minimumDenominator}
			if denominator > 0 {
				value.Raw = float64(numerator) / float64(denominator)
			}
			values = append(values, value)
			if value.Eligible {
				ck := cohortKey{def.Key, key.Camp, key.Type, key.Value}
				cohorts[ck] = append(cohorts[ck], value)
			}
		}
	}
	for _, group := range cohorts {
		totalNumerator, totalDenominator := 0, 0
		for _, value := range group {
			totalNumerator += value.Numerator
			totalDenominator += value.Denominator
		}
		baseline := float64(totalNumerator) / float64(totalDenominator)
		for _, value := range group {
			value.Baseline = baseline
			value.Smoothed = (float64(value.Numerator) + baseline*priorWeight) / (float64(value.Denominator) + priorWeight)
		}
	}
	if _, err := tx.Exec(`DELETE FROM analysis_player_labels`); err != nil {
		return 0, 0, err
	}
	if _, err := tx.Exec(`DELETE FROM analysis_label_thresholds`); err != nil {
		return 0, 0, err
	}
	if _, err := tx.Exec(`DELETE FROM analysis_metric_values`); err != nil {
		return 0, 0, err
	}
	sort.Slice(values, func(i, j int) bool {
		a, b := values[i], values[j]
		if a.Period != b.Period {
			return lessPeriod(a.Period, b.Period)
		}
		return a.Def.Key < b.Def.Key
	})
	for _, value := range values {
		var raw, baseline, smoothed any
		if value.Denominator > 0 {
			raw = value.Raw
		}
		if value.Eligible {
			baseline = value.Baseline
			smoothed = value.Smoothed
		}
		_, err := tx.Exec(`INSERT INTO analysis_metric_values (player_id,camp,period_type,period_key,metric_key,analysis_run_id,metric_type,direction,numerator,denominator,raw_value,baseline_value,prior_weight,smoothed_value,eligible) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, value.Period.PlayerID, value.Period.Camp, value.Period.Type, value.Period.Value, value.Def.Key, runID, value.Def.Type, value.Def.Direction, value.Numerator, value.Denominator, raw, baseline, priorWeight, smoothed, boolInt(value.Eligible))
		if err != nil {
			return 0, 0, err
		}
	}
	labelCount := 0
	cohortKeys := make([]cohortKey, 0, len(cohorts))
	for key := range cohorts {
		cohortKeys = append(cohortKeys, key)
	}
	sort.Slice(cohortKeys, func(i, j int) bool { return fmt.Sprint(cohortKeys[i]) < fmt.Sprint(cohortKeys[j]) })
	for _, key := range cohortKeys {
		group := cohorts[key]
		if len(group) < minimumCohortSize {
			continue
		}
		sortedValues := make([]float64, len(group))
		for i, value := range group {
			sortedValues[i] = value.Smoothed
		}
		sort.Float64s(sortedValues)
		p10, p30, p70, p90 := quantile(sortedValues, .10), quantile(sortedValues, .30), quantile(sortedValues, .70), quantile(sortedValues, .90)
		baseline := group[0].Baseline
		cohortName := "camp:" + key.Camp
		_, err := tx.Exec(`INSERT INTO analysis_label_thresholds (analysis_run_id,metric_key,camp,period_type,period_key,cohort_key,cohort_size,baseline_value,prior_weight,p10,p30,p70,p90) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, runID, key.Metric, key.Camp, key.PeriodType, key.PeriodKey, cohortName, len(group), baseline, priorWeight, p10, p30, p70, p90)
		if err != nil {
			return 0, 0, err
		}
		for _, value := range group {
			percentile := empiricalPercentile(sortedValues, value.Smoothed)
			_, err := tx.Exec(`INSERT INTO analysis_player_labels (player_id,camp,period_type,period_key,metric_key,analysis_run_id,metric_type,direction,distribution_band,percentile,cohort_key,cohort_size,confidence) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, value.Period.PlayerID, value.Period.Camp, value.Period.Type, value.Period.Value, value.Def.Key, runID, value.Def.Type, value.Def.Direction, distributionBand(value.Smoothed, p10, p30, p70, p90), percentile, cohortName, len(group), confidence(value.Denominator))
			if err != nil {
				return 0, 0, err
			}
			labelCount++
		}
	}
	return len(values), labelCount, nil
}

func metricDefinitions() []metricDef {
	return []metricDef{
		{"win_rate", "result", "high", "", func(a *periodAgg) (int, int) { return a.Wins, a.Games }},
		{"mvp_rate", "result", "high", "", func(a *periodAgg) (int, int) { return a.MVP, a.Games }},
		{"survival_rate", "structure", "high", "", func(a *periodAgg) (int, int) { return a.Alive, a.Games }},
		{"good_vote_hit_rate", "ability", "high", "good", func(a *periodAgg) (int, int) { return a.GoodHits, a.GoodVotes }},
		{"badge_vote_hit_rate", "ability", "high", "good", func(a *periodAgg) (int, int) { return a.BadgeHits, a.BadgeVotes }},
		{"findwolf_rate", "ability", "high", "good", func(a *periodAgg) (int, int) {
			return a.GoodHits + a.FindSkillHits, a.GoodVotes + a.FindSkillEvents
		}},
		{"badge_carry_rate", "structure", "neutral", "good", func(a *periodAgg) (int, int) { return a.BadgeGames, a.Games }},
		{"wolf_hook_rate", "tendency", "neutral", "wolf", func(a *periodAgg) (int, int) { return a.WolfHook, a.WolfHook + a.WolfCharge }},
		{"hantiao_rate", "tendency", "neutral", "wolf", func(a *periodAgg) (int, int) { return a.HantiaoGames, a.Games }},
		{"hantiao_badge_rate", "ability", "high", "wolf", func(a *periodAgg) (int, int) { return a.HantiaoBadgeGames, a.HantiaoGames }},
		{"exposed_survival_rate", "ability", "high", "wolf", func(a *periodAgg) (int, int) { return a.ExposedSurvivedGames, a.ExposedGames }},
		{"charge_survival_rate", "ability", "high", "wolf", func(a *periodAgg) (int, int) { return a.ChargeSurvived, a.ChargeGames }},
		{"hook_survival_rate", "ability", "high", "wolf", func(a *periodAgg) (int, int) { return a.HookSurvived, a.HookGames }},
		{"self_destruct_rate", "tendency", "neutral", "wolf", func(a *periodAgg) (int, int) { return a.SelfDestructGames, a.Games }},
		{"d3_survival_rate", "structure", "high", "", func(a *periodAgg) (int, int) { return a.D3AliveGames, a.Games }},
		{"won_findwolf_rate", "ability", "high", "good", func(a *periodAgg) (int, int) { return a.WonFwHits, a.WonFwAtt }},
		{"lost_findwolf_rate", "ability", "high", "good", func(a *periodAgg) (int, int) { return a.LostFwHits, a.LostFwAtt }},
		{"seer_checked_rate", "tendency", "neutral", "", func(a *periodAgg) (int, int) { return a.CheckedGames, a.Games }},
		{"zhanbian_rate", "ability", "high", "good", func(a *periodAgg) (int, int) { return a.ZhanbianCorrect, a.ZhanbianAtt }},
		{"zhanbian_exiled_rate", "structure", "neutral", "good", func(a *periodAgg) (int, int) { return a.ZhanbianExiled, a.ZhanbianCorrect }},
		{"civ_night_death_rate", "structure", "neutral", "good", func(a *periodAgg) (int, int) { return a.CivNightDeaths, a.CivGames }},
		{"god_survival_rate", "structure", "high", "good", func(a *periodAgg) (int, int) { return a.GodAlive, a.GodGames }},
		{"nightmare_god_rate", "ability", "high", "wolf", func(a *periodAgg) (int, int) { return a.NightmareGod, a.NightmareAtt }},
		{"charm_god_rate", "ability", "high", "wolf", func(a *periodAgg) (int, int) { return a.CharmGod, a.CharmAtt }},
		{"seer_cleared_rate", "result", "high", "wolf", func(a *periodAgg) (int, int) { return a.SeerClearedGames, a.Games }},
		{"seer_duel_win_rate", "ability", "high", "good", func(a *periodAgg) (int, int) { return a.SeerDuelWins, a.SeerDuelGames }},
		{"hantiao_duel_win_rate", "ability", "high", "wolf", func(a *periodAgg) (int, int) { return a.HantiaoDuelWins, a.HantiaoDuelGames }},
	}
}

func validateBuild(tx *sql.Tx, sourceGames int) error {
	var games, badSeats, badRates, danglingVotes int
	if err := tx.QueryRow(`SELECT COUNT(*) FROM analysis_games`).Scan(&games); err != nil {
		return err
	}
	if games != sourceGames {
		return fmt.Errorf("coverage validation: %d analysis games for %d source games", games, sourceGames)
	}
	if err := tx.QueryRow(`SELECT COUNT(*) FROM analysis_games g LEFT JOIN (SELECT game_id,COUNT(*) n FROM analysis_game_players GROUP BY game_id) p USING(game_id) WHERE g.parsed_ok=1 AND COALESCE(p.n,0)<>12`).Scan(&badSeats); err != nil {
		return err
	}
	if badSeats > 0 {
		return fmt.Errorf("coverage validation: %d reconstructed games do not have 12 fact seats", badSeats)
	}
	if err := tx.QueryRow(`SELECT COUNT(*) FROM analysis_metric_values WHERE numerator<0 OR denominator<0 OR numerator>denominator`).Scan(&badRates); err != nil {
		return err
	}
	if badRates > 0 {
		return fmt.Errorf("metric validation: %d invalid numerator/denominator rows", badRates)
	}
	if err := tx.QueryRow(`SELECT COUNT(*) FROM analysis_votes v LEFT JOIN analysis_game_players p ON p.game_id=v.game_id AND p.seat=v.voter_seat WHERE p.game_id IS NULL`).Scan(&danglingVotes); err != nil {
		return err
	}
	if danglingVotes > 0 {
		return fmt.Errorf("vote validation: %d votes lack a voter seat", danglingVotes)
	}
	return nil
}

func printStatus(db *sql.DB) error {
	var runID, sourceCount, analyzed, reconstructed, failed, doubts, seats sql.NullInt64
	var completed, algorithm, knowledge, cutoff, fingerprint sql.NullString
	err := db.QueryRow(`SELECT analysis_run_id,completed_at,algorithm_version,knowledge_version,source_game_count,source_max_play_date,source_fingerprint,analyzed_games,reconstructed_games,failed_games,games_with_doubt,twelve_seat_games FROM v_analysis_coverage`).Scan(&runID, &completed, &algorithm, &knowledge, &sourceCount, &cutoff, &fingerprint, &analyzed, &reconstructed, &failed, &doubts, &seats)
	if err == sql.ErrNoRows {
		fmt.Println("No ready analysis run.")
		return nil
	}
	if err != nil {
		return err
	}
	var metricRows, labelRows int
	_ = db.QueryRow(`SELECT COUNT(*) FROM analysis_metric_values WHERE analysis_run_id=?`, runID.Int64).Scan(&metricRows)
	_ = db.QueryRow(`SELECT COUNT(*) FROM analysis_player_labels WHERE analysis_run_id=?`, runID.Int64).Scan(&labelRows)
	fp := fingerprint.String
	if len(fp) > 12 {
		fp = fp[:12]
	}
	fmt.Printf("Latest run: %d ready at %s\n", runID.Int64, completed.String)
	fmt.Printf("Versions: algorithm=%s knowledge=%s fingerprint=%s\n", algorithm.String, knowledge.String, fp)
	fmt.Printf("Coverage: source=%d analyzed=%d reconstructed=%d failed=%d doubts=%d twelve-seat=%d cutoff=%s\n", sourceCount.Int64, analyzed.Int64, reconstructed.Int64, failed.Int64, doubts.Int64, seats.Int64, cutoff.String)
	fmt.Printf("Derived rows: metrics=%d labels=%d\n", metricRows, labelRows)
	return nil
}

func quantile(values []float64, q float64) float64 {
	if len(values) == 0 {
		return math.NaN()
	}
	if len(values) == 1 {
		return values[0]
	}
	pos := q * float64(len(values)-1)
	lo := int(math.Floor(pos))
	hi := int(math.Ceil(pos))
	if lo == hi {
		return values[lo]
	}
	return values[lo] + (values[hi]-values[lo])*(pos-float64(lo))
}
func empiricalPercentile(values []float64, target float64) float64 {
	lower, equal := 0, 0
	for _, v := range values {
		if v < target-1e-12 {
			lower++
		} else if math.Abs(v-target) <= 1e-12 {
			equal++
		}
	}
	return (float64(lower) + float64(equal)/2) / float64(len(values))
}
func distributionBand(value, p10, p30, p70, p90 float64) string {
	switch {
	case value < p10:
		return "very_low"
	case value < p30:
		return "low"
	case value <= p70:
		return "middle"
	case value < p90:
		return "high"
	default:
		return "very_high"
	}
}
func confidence(denominator int) string {
	switch {
	case denominator < 10:
		return "clue_only"
	case denominator < 30:
		return "low"
	case denominator < 80:
		return "medium"
	default:
		return "higher"
	}
}
func sortedPeriodKeys(periods map[periodKey]*periodAgg) []periodKey {
	keys := make([]periodKey, 0, len(periods))
	for key := range periods {
		keys = append(keys, key)
	}
	sort.Slice(keys, func(i, j int) bool { return lessPeriod(keys[i], keys[j]) })
	return keys
}
func lessPeriod(a, b periodKey) bool {
	if a.PlayerID != b.PlayerID {
		return a.PlayerID < b.PlayerID
	}
	if a.Camp != b.Camp {
		return a.Camp < b.Camp
	}
	if a.Type != b.Type {
		return a.Type < b.Type
	}
	return a.Value < b.Value
}
func idSet(ids []int64) map[int64]bool {
	out := make(map[int64]bool, len(ids))
	for _, id := range ids {
		out[id] = true
	}
	return out
}
func boolInt(v bool) int {
	if v {
		return 1
	}
	return 0
}
func nullInt(v sql.NullInt64) int64 {
	if v.Valid {
		return v.Int64
	}
	return 0
}
func nullableInt(v sql.NullInt64) any {
	if v.Valid && v.Int64 != 0 {
		return v.Int64
	}
	return nil
}
func nullableInt64(v int64) any {
	if v != 0 {
		return v
	}
	return nil
}
func nullableSeat(v int) any {
	if v >= 1 && v <= 12 {
		return v
	}
	return nil
}
func nullableCamp(v string) any {
	if v != "" {
		return v
	}
	return nil
}
func nullableString(v sql.NullString) any {
	if v.Valid && strings.TrimSpace(v.String) != "" {
		return v.String
	}
	return nil
}
func nullableText(v string) any {
	if strings.TrimSpace(v) != "" {
		return v
	}
	return nil
}
func rawInt(raw json.RawMessage) int {
	if len(raw) == 0 {
		return 0
	}
	var n int
	if json.Unmarshal(raw, &n) == nil {
		return n
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		n, _ = strconv.Atoi(s)
	}
	return n
}
func isDaySkill(name string) bool {
	return strings.Contains(name, "猎人") || strings.Contains(name, "侦探") || strings.Contains(name, "骑士")
}
func clip(value string, n int) string {
	value = strings.TrimSpace(value)
	if len(value) <= n {
		return value
	}
	return value[:n-3] + "..."
}
