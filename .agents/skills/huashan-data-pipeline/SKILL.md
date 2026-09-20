---
name: huashan-data-pipeline
description: Run, diagnose, or update the Huashan MySQL data pipeline from player crawling through T1/T2 normalization and incremental derived analysis. Use for refreshing the analysis database, importing a crawl dump, checking coverage, rebuilding materialized analysis tables, or handling corrected historical games; do not use for one-off player interpretation after the analysis data is already current.
---

# Huashan Data Pipeline

Maintain a reproducible path from official API data to queryable analysis results. Keep raw source tables, deterministic facts, statistical estimates, and interpretations separate.

## Load The Contract

Always read:

- [`../../../docs/knowledge/player-analysis/index.md`](../../../docs/knowledge/player-analysis/index.md)
- [`../../../docs/knowledge/player-analysis/evidence-method.md`](../../../docs/knowledge/player-analysis/evidence-method.md)
- [`../../../docs/knowledge/player-analysis/matchup-impact.md`](../../../docs/knowledge/player-analysis/matchup-impact.md)
- [`../../../docs/knowledge/player-analysis/ability-labels.md`](../../../docs/knowledge/player-analysis/ability-labels.md)
- [`references/pipeline-contract.md`](references/pipeline-contract.md)

Read `metrics.md`, `survival.md`, and `player-traits.md` before adding or changing derived fields that implement those concepts. Check `docs/standards/werewolf-language.md` and `internal/server/web/js/rules-data.js` when role, scoring, assessment, or rule-era behavior changes.

## Route The Operation

- **Status or audit:** inspect source freshness, crawl state, table coverage, invalid rows, analysis run state, and source hashes without changing data.
- **Refresh:** crawl new official data, normalize changed games, recompute affected chronological estimates, rebuild current aggregates, and verify views.
- **Rebuild:** recompute all deterministic facts and derived results from raw tables. Do not refetch upstream data unless requested.
- **Dump import:** use an isolated empty MySQL database because repository dumps can contain `DROP TABLE`; inspect the header before import.
- **Schema or metric change:** update the knowledge definition first, then schema/calculation code, tests, pipeline help, and coverage output.

## Execute The Pipeline

1. Record the target database, source time range, source row counts, latest fetch times, and current analysis run before mutation.
2. Run `player-crawl` to refresh T1 game rows and T2 game details. Run `player-stats-crawl` for the separate T0 snapshot. Never serialize or print a token.
3. Stop before analysis when any required crawl is still running, source tables are inconsistent, or coverage materially regressed. Report the exact incomplete stage.
4. Run the repository analysis builder in refresh mode. It must hash raw games, reuse unchanged deterministic facts, and identify the earliest changed historical game.
5. For append-only data, extend chronological snapshots. For a corrected or backfilled old game, recompute every time-dependent result from the earliest changed point. For deletions or scope changes, use a full rebuild.
6. Build new results transactionally. Mark a run ready and switch the latest views only after all facts, aggregates, coverage checks, and model checks succeed.
7. Report run ID, algorithm and knowledge versions, source cutoff, T0/T1/T2 coverage, changed/new/removed games, recomputation range, and validation results.

## Preserve These Invariants

- Raw crawl tables are source evidence; analysis commands never rewrite them.
- T0 official summaries and T2 self-calculated metrics remain separate fields and labeled sources.
- Historical pregame strength uses only prior games. A current T0 career snapshot never backfills past strength.
- Every rate retains numerator, denominator, exclusions, scope, and coverage.
- Every derived row is traceable to an analysis run and, where applicable, a game and player.
- Failed refreshes leave the previous ready run queryable.
- Logs are English; user-facing operational explanations are concise Chinese unless the user chooses another language.

## Safety And Stops

- Treat DSNs, token files, and dumps as local sensitive inputs. Do not echo passwords or token contents.
- Do not import a dump that contains destructive statements into an existing user database. Use an isolated target or obtain explicit confirmation for the exact database.
- Do not continue from crawling to analysis merely because a command exited successfully; validate coverage and crawl-state rows.
- Do not publish rankings when T2 coverage is incomplete or biased without stratifying and disclosing the gap.
- Do not convert T2-only data into T3 claims about speech, private night discussion, decision ownership, or motive.
