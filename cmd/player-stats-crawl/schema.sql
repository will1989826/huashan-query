-- Official player summary snapshots for player-stats-crawl.

CREATE TABLE IF NOT EXISTS player_stats (
  player_id          BIGINT       NOT NULL,
  zone_id            VARCHAR(16)  NOT NULL,
  season_id          INT          NOT NULL DEFAULT 0,
  player_name        VARCHAR(64)  NULL,
  avatar_url         VARCHAR(512) NULL,
  power_json         TEXT         NULL,
  joined_zones_json  LONGTEXT     NULL,
  honors_json        LONGTEXT     NULL,
  summary_json       LONGTEXT     NULL,
  haoren_json        LONGTEXT     NULL,
  langren_json       LONGTEXT     NULL,
  raw_json           LONGTEXT     NULL,
  fetch_status       VARCHAR(16)  NOT NULL,
  fetch_error        VARCHAR(255) NULL,
  fetched_at         DATETIME     NOT NULL,
  PRIMARY KEY (player_id, zone_id, season_id),
  KEY idx_scope_status (zone_id, season_id, fetch_status),
  KEY idx_fetched_at (fetched_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS player_stats_crawl_state (
  crawl_name        VARCHAR(32)  NOT NULL PRIMARY KEY,
  zone_id           VARCHAR(16)  NOT NULL,
  season_id         INT          NOT NULL DEFAULT 0,
  stage             VARCHAR(32)  NOT NULL,
  current_player_id BIGINT       NULL,
  note              VARCHAR(255) NULL,
  updated_at        DATETIME     NOT NULL,
  KEY idx_updated_at (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
