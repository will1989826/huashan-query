CREATE TABLE IF NOT EXISTS analysis_runs (
  run_id                BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
  mode                  VARCHAR(16)  NOT NULL,
  status                VARCHAR(16)  NOT NULL,
  algorithm_version     VARCHAR(32)  NOT NULL,
  knowledge_version     VARCHAR(32)  NOT NULL,
  source_game_count     INT          NOT NULL,
  source_max_game_id    BIGINT       NULL,
  source_max_play_date  DATE         NULL,
  source_fingerprint    CHAR(64)     NOT NULL,
  new_games             INT          NOT NULL DEFAULT 0,
  changed_games         INT          NOT NULL DEFAULT 0,
  removed_games         INT          NOT NULL DEFAULT 0,
  processed_games       INT          NOT NULL DEFAULT 0,
  valid_games           INT          NOT NULL DEFAULT 0,
  invalid_games         INT          NOT NULL DEFAULT 0,
  error_message         VARCHAR(512) NULL,
  started_at            DATETIME     NOT NULL,
  completed_at          DATETIME     NULL,
  KEY idx_analysis_runs_status (status, run_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS analysis_state (
  state_id      TINYINT  NOT NULL PRIMARY KEY,
  latest_run_id BIGINT   NULL,
  updated_at    DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS analysis_games (
  game_id            BIGINT       NOT NULL PRIMARY KEY,
  source_hash        CHAR(64)     NOT NULL,
  source_fetched_at  DATETIME     NOT NULL,
  analysis_run_id    BIGINT       NOT NULL,
  play_date          DATE         NULL,
  season_id          INT          NULL,
  season_type_id     INT          NULL,
  edition_id         INT          NULL,
  edition_name       VARCHAR(64)  NULL,
  victory_camp       TINYINT      NULL,
  total_days         INT          NULL,
  parsed_ok          TINYINT      NOT NULL,
  roster_count       INT          NOT NULL,
  vote_count         INT          NOT NULL,
  skill_event_count  INT          NOT NULL,
  death_count        INT          NOT NULL,
  doubt_count        INT          NOT NULL,
  parse_error        VARCHAR(255) NULL,
  analyzed_at        DATETIME     NOT NULL,
  KEY idx_analysis_games_date (play_date, game_id),
  KEY idx_analysis_games_scope (season_id, season_type_id, edition_id),
  KEY idx_analysis_games_quality (parsed_ok, doubt_count)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS analysis_game_players (
  game_id                BIGINT      NOT NULL,
  seat                   INT         NOT NULL,
  analysis_run_id        BIGINT      NOT NULL,
  player_id              BIGINT      NULL,
  player_name            VARCHAR(64) NULL,
  sect_id                INT         NULL,
  sect_name              VARCHAR(64) NULL,
  role_id                INT         NULL,
  role_name              VARCHAR(32) NULL,
  camp                   VARCHAR(8)  NOT NULL,
  won                    TINYINT     NULL,
  final_alive            TINYINT     NOT NULL,
  death_day              INT         NULL,
  death_phase            VARCHAR(8)  NULL,
  death_cause            VARCHAR(32) NULL,
  death_doubt            TINYINT     NOT NULL,
  mvp                    TINYINT     NOT NULL,
  svp                    TINYINT     NOT NULL,
  bgx                    TINYINT     NOT NULL,
  day_of_hantiao         INT         NULL,
  hantiao_role_name      VARCHAR(32) NULL,
  day_of_badge           INT         NULL,
  self_destruct_day      INT         NULL,
  day_vote_events        INT         NOT NULL,
  good_vote_events       INT         NOT NULL,
  good_vote_hits         INT         NOT NULL,
  badge_vote_events      INT         NOT NULL,
  badge_vote_hits        INT         NOT NULL,
  wolf_charge_votes      INT         NOT NULL,
  wolf_hook_votes        INT         NOT NULL,
  find_skill_events      INT         NOT NULL DEFAULT 0,
  find_skill_hits        INT         NOT NULL DEFAULT 0,
  checked_by_seer        INT         NOT NULL DEFAULT 0,
  checked_as_wolf        INT         NOT NULL DEFAULT 0,
  zhanbian_att            INT        NOT NULL DEFAULT 0,
  zhanbian_correct        INT        NOT NULL DEFAULT 0,
  zhanbian_correct_exiled INT        NOT NULL DEFAULT 0,
  is_civ                  INT        NOT NULL DEFAULT 0,
  civ_night_death         INT        NOT NULL DEFAULT 0,
  is_god                  INT        NOT NULL DEFAULT 0,
  god_alive               INT        NOT NULL DEFAULT 0,
  nightmare_att           INT        NOT NULL DEFAULT 0,
  nightmare_god           INT        NOT NULL DEFAULT 0,
  charm_att               INT        NOT NULL DEFAULT 0,
  charm_god               INT        NOT NULL DEFAULT 0,
  seer_cleared            INT        NOT NULL DEFAULT 0,
  seer_duel               INT        NOT NULL DEFAULT 0,
  seer_duel_win           INT        NOT NULL DEFAULT 0,
  hantiao_duel            INT        NOT NULL DEFAULT 0,
  hantiao_duel_win        INT        NOT NULL DEFAULT 0,
  badge_duel_vote         INT        NOT NULL DEFAULT 0,
  badge_seer_hit          INT        NOT NULL DEFAULT 0,
  badge_hantiao_hit       INT        NOT NULL DEFAULT 0,
  badge_present           INT        NOT NULL DEFAULT 0,
  badge_cast              INT        NOT NULL DEFAULT 0,
  hook_opp_game           INT        NOT NULL DEFAULT 0,
  hantiao_hook_game       INT        NOT NULL DEFAULT 0,
  PRIMARY KEY (game_id, seat),
  KEY idx_analysis_game_players_player (player_id, camp, game_id),
  KEY idx_analysis_game_players_role (role_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS analysis_votes (
  game_id          BIGINT       NOT NULL,
  vote_kind        VARCHAR(8)   NOT NULL,
  day              INT          NOT NULL,
  voter_seat       INT          NOT NULL,
  analysis_run_id  BIGINT       NOT NULL,
  voter_player_id  BIGINT       NULL,
  voter_camp       VARCHAR(8)   NOT NULL,
  target_seat      INT          NULL,
  target_player_id BIGINT       NULL,
  target_camp      VARCHAR(8)   NULL,
  weight           DECIMAL(3,1) NOT NULL,
  badge_weight     TINYINT      NOT NULL,
  abstain          TINYINT      NOT NULL,
  good_vote_hit    TINYINT      NULL,
  wolf_vote_type   VARCHAR(8)   NULL,
  PRIMARY KEY (game_id, vote_kind, day, voter_seat),
  KEY idx_analysis_votes_voter (voter_player_id, vote_kind, day),
  KEY idx_analysis_votes_target (target_player_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS analysis_skill_events (
  game_id          BIGINT       NOT NULL,
  actor_seat       INT          NOT NULL,
  event_index      INT          NOT NULL,
  target_index     INT          NOT NULL,
  analysis_run_id  BIGINT       NOT NULL,
  actor_player_id  BIGINT       NULL,
  actor_camp       VARCHAR(8)   NOT NULL,
  actor_role_name  VARCHAR(32)  NULL,
  day              INT          NOT NULL,
  phase            VARCHAR(8)   NOT NULL,
  skill_name       VARCHAR(32)  NULL,
  target_seat      INT          NULL,
  target_player_id BIGINT       NULL,
  target_camp      VARCHAR(8)   NULL,
  target_role_name VARCHAR(32)  NULL,
  PRIMARY KEY (game_id, actor_seat, event_index, target_index),
  KEY idx_analysis_skills_actor (actor_player_id, skill_name),
  KEY idx_analysis_skills_target (target_player_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS analysis_deaths (
  game_id          BIGINT      NOT NULL,
  seat             INT         NOT NULL,
  analysis_run_id  BIGINT      NOT NULL,
  player_id        BIGINT      NULL,
  camp             VARCHAR(8)  NOT NULL,
  role_name        VARCHAR(32) NULL,
  day              INT         NOT NULL,
  phase            VARCHAR(8)  NOT NULL,
  cause            VARCHAR(32) NOT NULL,
  doubt            TINYINT     NOT NULL,
  PRIMARY KEY (game_id, seat),
  KEY idx_analysis_deaths_player (player_id, camp, day),
  KEY idx_analysis_deaths_cause (cause, phase)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS analysis_player_periods (
  player_id          BIGINT      NOT NULL,
  camp               VARCHAR(8)  NOT NULL,
  period_type        VARCHAR(16) NOT NULL,
  period_key         VARCHAR(16) NOT NULL,
  analysis_run_id    BIGINT      NOT NULL,
  player_name        VARCHAR(64) NULL,
  games              INT         NOT NULL,
  wins               INT         NOT NULL,
  mvp_count          INT         NOT NULL,
  svp_count          INT         NOT NULL,
  bgx_count          INT         NOT NULL,
  final_alive_count  INT         NOT NULL,
  day_vote_events    INT         NOT NULL,
  good_vote_events   INT         NOT NULL,
  good_vote_hits     INT         NOT NULL,
  badge_vote_events  INT         NOT NULL,
  badge_vote_hits    INT         NOT NULL,
  wolf_charge_votes  INT         NOT NULL,
  wolf_hook_votes    INT         NOT NULL,
  hantiao_games      INT         NOT NULL,
  self_destruct_games INT        NOT NULL,
  find_skill_events   INT        NOT NULL DEFAULT 0,
  find_skill_hits     INT        NOT NULL DEFAULT 0,
  badge_games         INT        NOT NULL DEFAULT 0,
  hantiao_badge_games INT        NOT NULL DEFAULT 0,
  exposed_games       INT        NOT NULL DEFAULT 0,
  exposed_survived_games INT     NOT NULL DEFAULT 0,
  charge_games        INT        NOT NULL DEFAULT 0,
  charge_survived_games INT      NOT NULL DEFAULT 0,
  hook_games          INT        NOT NULL DEFAULT 0,
  hook_survived_games INT        NOT NULL DEFAULT 0,
  d3_alive_games      INT        NOT NULL DEFAULT 0,
  checked_games       INT        NOT NULL DEFAULT 0,
  won_fw_hits         INT        NOT NULL DEFAULT 0,
  won_fw_att          INT        NOT NULL DEFAULT 0,
  lost_fw_hits        INT        NOT NULL DEFAULT 0,
  lost_fw_att         INT        NOT NULL DEFAULT 0,
  zhanbian_att            INT    NOT NULL DEFAULT 0,
  zhanbian_correct        INT    NOT NULL DEFAULT 0,
  zhanbian_correct_exiled INT    NOT NULL DEFAULT 0,
  civ_games               INT    NOT NULL DEFAULT 0,
  civ_night_deaths        INT    NOT NULL DEFAULT 0,
  god_games               INT    NOT NULL DEFAULT 0,
  god_alive_games         INT    NOT NULL DEFAULT 0,
  nightmare_att           INT    NOT NULL DEFAULT 0,
  nightmare_god           INT    NOT NULL DEFAULT 0,
  charm_att               INT    NOT NULL DEFAULT 0,
  charm_god               INT    NOT NULL DEFAULT 0,
  seer_cleared_games      INT    NOT NULL DEFAULT 0,
  seer_duel_games         INT    NOT NULL DEFAULT 0,
  seer_duel_wins          INT    NOT NULL DEFAULT 0,
  hantiao_duel_games      INT    NOT NULL DEFAULT 0,
  hantiao_duel_wins       INT    NOT NULL DEFAULT 0,
  badge_duel_votes        INT    NOT NULL DEFAULT 0,
  badge_seer_hits         INT    NOT NULL DEFAULT 0,
  badge_hantiao_hits      INT    NOT NULL DEFAULT 0,
  badge_present_games     INT    NOT NULL DEFAULT 0,
  badge_cast_games        INT    NOT NULL DEFAULT 0,
  hook_opp_games          INT    NOT NULL DEFAULT 0,
  PRIMARY KEY (player_id, camp, period_type, period_key),
  KEY idx_analysis_period_scope (period_type, period_key, camp, games)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS analysis_metric_values (
  player_id          BIGINT        NOT NULL,
  camp               VARCHAR(8)    NOT NULL,
  period_type        VARCHAR(16)   NOT NULL,
  period_key         VARCHAR(16)   NOT NULL,
  metric_key         VARCHAR(40)   NOT NULL,
  analysis_run_id    BIGINT        NOT NULL,
  metric_type        VARCHAR(16)   NOT NULL,
  direction          VARCHAR(8)    NOT NULL,
  numerator          INT           NOT NULL,
  denominator        INT           NOT NULL,
  raw_value          DECIMAL(12,8) NULL,
  baseline_value     DECIMAL(12,8) NULL,
  prior_weight       DECIMAL(8,2)  NOT NULL,
  smoothed_value     DECIMAL(12,8) NULL,
  eligible           TINYINT       NOT NULL,
  PRIMARY KEY (player_id, camp, period_type, period_key, metric_key),
  KEY idx_metric_cohort (metric_key, period_type, period_key, camp, eligible, smoothed_value)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS analysis_label_thresholds (
  analysis_run_id  BIGINT        NOT NULL,
  metric_key       VARCHAR(40)   NOT NULL,
  camp             VARCHAR(8)    NOT NULL,
  period_type      VARCHAR(16)   NOT NULL,
  period_key       VARCHAR(16)   NOT NULL,
  cohort_key       VARCHAR(64)   NOT NULL,
  cohort_size      INT           NOT NULL,
  baseline_value   DECIMAL(12,8) NOT NULL,
  prior_weight     DECIMAL(8,2)  NOT NULL,
  p10              DECIMAL(12,8) NOT NULL,
  p30              DECIMAL(12,8) NOT NULL,
  p70              DECIMAL(12,8) NOT NULL,
  p90              DECIMAL(12,8) NOT NULL,
  PRIMARY KEY (analysis_run_id, metric_key, camp, period_type, period_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS analysis_player_labels (
  player_id          BIGINT        NOT NULL,
  camp               VARCHAR(8)    NOT NULL,
  period_type        VARCHAR(16)   NOT NULL,
  period_key         VARCHAR(16)   NOT NULL,
  metric_key         VARCHAR(40)   NOT NULL,
  analysis_run_id    BIGINT        NOT NULL,
  metric_type        VARCHAR(16)   NOT NULL,
  direction          VARCHAR(8)    NOT NULL,
  distribution_band VARCHAR(16)   NOT NULL,
  percentile         DECIMAL(7,6)  NOT NULL,
  cohort_key         VARCHAR(64)   NOT NULL,
  cohort_size        INT           NOT NULL,
  confidence         VARCHAR(16)   NOT NULL,
  PRIMARY KEY (player_id, camp, period_type, period_key, metric_key),
  KEY idx_labels_metric (metric_key, camp, period_type, period_key, distribution_band)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE OR REPLACE VIEW v_analysis_coverage AS
SELECT
  s.latest_run_id AS analysis_run_id,
  r.completed_at,
  r.algorithm_version,
  r.knowledge_version,
  r.source_game_count,
  r.source_max_play_date,
  r.source_fingerprint,
  COUNT(g.game_id) AS analyzed_games,
  COALESCE(SUM(g.parsed_ok = 1), 0) AS reconstructed_games,
  COALESCE(SUM(g.parsed_ok = 0), 0) AS failed_games,
  COALESCE(SUM(g.doubt_count > 0), 0) AS games_with_doubt,
  COALESCE(SUM(g.roster_count = 12), 0) AS twelve_seat_games
FROM analysis_state s
JOIN analysis_runs r ON r.run_id = s.latest_run_id AND r.status = 'ready'
LEFT JOIN analysis_games g ON TRUE
WHERE s.state_id = 1
GROUP BY s.latest_run_id, r.completed_at, r.algorithm_version, r.knowledge_version,
         r.source_game_count, r.source_max_play_date, r.source_fingerprint;

CREATE OR REPLACE VIEW v_player_profile AS
SELECT
  p.player_id,
  p.player_name,
  p.camp,
  p.games,
  p.wins,
  p.mvp_count,
  p.svp_count,
  p.bgx_count,
  p.final_alive_count,
  p.day_vote_events,
  p.good_vote_events,
  p.good_vote_hits,
  p.badge_vote_events,
  p.badge_vote_hits,
  p.wolf_charge_votes,
  p.wolf_hook_votes,
  p.hantiao_games,
  p.self_destruct_games,
  ROUND(100 * p.wins / NULLIF(p.games, 0), 2) AS win_pct,
  ROUND(100 * p.good_vote_hits / NULLIF(p.good_vote_events, 0), 2) AS self_good_vote_hit_pct,
  ROUND(100 * p.badge_vote_hits / NULLIF(p.badge_vote_events, 0), 2) AS self_badge_vote_hit_pct,
  CASE
    WHEN p.games < 10 THEN 'clue_only'
    WHEN p.games < 30 THEN 'low'
    WHEN p.games < 80 THEN 'medium'
    ELSE 'higher'
  END AS confidence
FROM analysis_player_periods p
JOIN analysis_state s ON s.state_id = 1 AND s.latest_run_id = p.analysis_run_id
WHERE p.period_type = 'career' AND p.period_key = 'all';

CREATE OR REPLACE VIEW v_player_ability_labels AS
SELECT
  l.player_id,
  p.player_name,
  l.camp,
  l.period_type,
  l.period_key,
  l.metric_key,
  l.metric_type,
  l.direction,
  m.numerator,
  m.denominator,
  m.raw_value,
  m.smoothed_value,
  l.percentile,
  l.distribution_band,
  l.cohort_key,
  l.cohort_size,
  l.confidence,
  l.analysis_run_id
FROM analysis_player_labels l
JOIN analysis_metric_values m
  ON m.player_id = l.player_id AND m.camp = l.camp
 AND m.period_type = l.period_type AND m.period_key = l.period_key
 AND m.metric_key = l.metric_key AND m.analysis_run_id = l.analysis_run_id
JOIN analysis_player_periods p
  ON p.player_id = l.player_id AND p.camp = l.camp
 AND p.period_type = l.period_type AND p.period_key = l.period_key
 AND p.analysis_run_id = l.analysis_run_id
JOIN analysis_state s ON s.state_id = 1 AND s.latest_run_id = l.analysis_run_id;
