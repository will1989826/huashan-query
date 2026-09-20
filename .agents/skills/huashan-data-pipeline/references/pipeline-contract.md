# Pipeline Contract

## Layers

1. **Raw T0:** `player_stats`, one current official snapshot per player and scope.
2. **Raw T1:** `player_game_results` plus `player_game_result_state`, preserving every player-list row and its completeness.
3. **Raw T2:** `games` and `game_players`, preserving full game JSON, the 12-seat roster, votes, and skills.
4. **Deterministic facts:** normalized game seats, votes, skill events, deaths, survival, quality flags, and source hashes.
5. **Derived analysis:** period metrics, pregame snapshots, game expectations, result residuals, and teammate/opponent effects.
6. **Views:** stable read interfaces over the latest ready analysis run.

Analysis code may read lower layers but never rewrite them. Interpretation belongs in reports and the player-analysis knowledge base, not in raw or fact tables.

## Source Audit

Before a refresh, capture at least:

- game count, minimum/maximum `play_date`, and maximum `fetched_at`;
- roster-row count, distinct players, and distribution of seats per game;
- invalid game JSON, missing `form2`, missing player IDs or roles, and reconstruction failures;
- T1 row/state counts, incomplete or truncated players, and T1-to-roster coverage;
- T0 status/scope counts and maximum `fetched_at`;
- last ready analysis run and its source fingerprint.

Completed standard games should normally have 12 unique seats. Preserve abnormal rows and exclude them through explicit quality flags instead of repairing them silently.

## Change Detection

Use a stable content hash for each raw game and T1 player-game row. Timestamps are freshness metadata, not sufficient proof that content changed.

Classify a refresh as:

- **append-only:** all prior source hashes remain and new games sort after the previous cutoff;
- **historical correction/backfill:** an existing hash changes or a new game sorts at/before the prior cutoff;
- **deletion/scope change:** a prior source row disappears or configured scope changes;
- **algorithm-only:** sources are unchanged but the schema, knowledge definition, or algorithm version changes.

Append-only refreshes can reuse prior facts and rating checkpoints. Historical changes rebuild deterministic facts for changed games and all chronological estimates from the earliest affected ordering key. Deletion, scope, or incompatible algorithm changes require a full rebuild.

## Run Lifecycle

Use explicit states such as `building`, `ready`, and `failed`.

1. Insert a building run with source fingerprint, cutoff, algorithm version, and knowledge version.
2. Write deterministic facts and derived outputs inside transactions or versioned staging tables.
3. Run coverage and referential-integrity checks.
4. Mark the run ready and atomically update the latest pointer/views.
5. On error, mark it failed without replacing the previous ready run.

Keep enough metadata to reproduce which sources and definitions produced each result. Retention of older heavy fact rows may be configurable, but run metadata and validation summaries should remain.

## Required Refresh Validation

- every normalized vote references an existing game and voter seat;
- target seats outside `1..12` are explicit abstain/invalid values, never valid player targets;
- every normalized death references an existing seat and retains its `doubt` flag;
- player/camp win values agree with `victory_camp` for valid roles;
- T0 and T2 rates are never merged into one numerator or denominator;
- chronological pregame rows have no source game at or after their target ordering key;
- aggregate numerators do not exceed denominators;
- current views reference exactly one ready run;
- coverage regressions are reported by camp, role, result, and time period before rankings are exposed.

## Operational Sequence

Use repository command help as the source for exact flags. The intended sequence is:

```text
player-crawl             -> raw T1 + T2
player-stats-crawl       -> separate raw T0 snapshot
player-analysis-build    -> facts + incremental derived analysis
player-analysis status   -> coverage and latest-run verification
```

Long-running crawl and analysis commands must expose resumable state. A normal scheduled refresh should stop after validation; it must not loop indefinitely on permanent source errors.
