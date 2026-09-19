-- Huashan werewolf crawl schema (MySQL 8+, utf8mb4).
-- The crawler auto-applies this on startup; kept here as the single source of truth.

CREATE TABLE IF NOT EXISTS games (
  game_id            BIGINT       NOT NULL PRIMARY KEY,
  play_date          DATE         NULL,
  season_id          INT          NULL,
  season_type_id     INT          NULL,
  season_type_label  VARCHAR(64)  NULL,
  round              INT          NULL,
  edition_id         INT          NULL,
  edition_name       VARCHAR(64)  NULL,
  referee_id         INT          NULL,
  referee_name       VARCHAR(64)  NULL,
  victory_camp       TINYINT      NULL,
  total_days         INT          NULL,
  mvp_seat           INT          NULL,
  svp_seat           INT          NULL,
  bgx_seat           INT          NULL,
  status             INT          NULL,
  raw_json           LONGTEXT     NOT NULL,
  fetched_at         DATETIME     NOT NULL,
  KEY idx_play_date (play_date),
  KEY idx_season (season_id, season_type_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS game_players (
  game_id          BIGINT       NOT NULL,
  seat             INT          NOT NULL,
  player_id        BIGINT       NULL,
  player_name      VARCHAR(64)  NULL,
  sect_id          INT          NULL,
  sect_name        VARCHAR(64)  NULL,
  rpt_id           INT          NULL,
  rpt_name         VARCHAR(32)  NULL,
  day_of_hantiao   INT          NULL,
  hantiao_rpt_name VARCHAR(32)  NULL,
  day_of_jinhui    INT          NULL,
  zibao_day        INT          NULL,
  votes_json       TEXT         NULL,
  skills_json      TEXT         NULL,
  PRIMARY KEY (game_id, seat),
  KEY idx_player (player_id),
  KEY idx_role (rpt_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS players (
  player_id     BIGINT      NOT NULL PRIMARY KEY,
  player_name   VARCHAR(64) NULL,
  crawled       TINYINT     NOT NULL DEFAULT 0,   -- 0 pending, 1 done, 2 error
  discovered_at DATETIME    NOT NULL,
  crawled_at    DATETIME    NULL,
  KEY idx_crawled (crawled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS crawl_state (
  crawl_name        VARCHAR(32)  NOT NULL PRIMARY KEY,
  stage             VARCHAR(32)  NOT NULL,
  current_player_id BIGINT       NULL,
  current_game_id   BIGINT       NULL,
  note              VARCHAR(255) NULL,
  updated_at        DATETIME     NOT NULL,
  KEY idx_updated_at (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
