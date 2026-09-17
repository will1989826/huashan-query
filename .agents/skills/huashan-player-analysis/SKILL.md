---
name: huashan-player-analysis
description: Analyze Huashan werewolf player statistics and replays to produce evidence-based good-camp and wolf-camp playstyle profiles. Use when querying player IDs, comparing players, interpreting survival or other metrics, or drawing scouting conclusions; do not use for merely displaying raw statistics or explaining one official rule.
---

# Huashan Player Analysis

Use this skill to turn official player data into evidence-based profiles. Keep official facts, reproducible derived values, domain interpretations, and unverified hypotheses distinct.

## Route the Request

Always read [`docs/knowledge/player-analysis/index.md`](../../../docs/knowledge/player-analysis/index.md) and [`evidence-method.md`](../../../docs/knowledge/player-analysis/evidence-method.md).

- Read [`metrics.md`](../../../docs/knowledge/player-analysis/metrics.md) for metric interpretation or a full profile.
- Read [`survival.md`](../../../docs/knowledge/player-analysis/survival.md) whenever survival, early exits, endgame ability, threat, deep-water play, or sacrificial play matters.
- Read [`good-camp-patterns.md`](../../../docs/knowledge/player-analysis/good-camp-patterns.md) for good-camp strengths, weaknesses, roles, or scouting.
- Read [`wolf-camp-patterns.md`](../../../docs/knowledge/player-analysis/wolf-camp-patterns.md) for wolf-camp strengths, weaknesses, roles, or scouting.
- Use `docs/standards/werewolf-language.md` for terminology and consult `internal/server/web/js/rules-data.js` when scoring, assessment priority, or role rules affect a conclusion.

Choose the minimum sufficient data tier:

- T0: official summaries for descriptive totals and rates.
- T1: all detail rows for identity, format, date, result, score, and assessment splits; deep data requires at least T1.
- T2: replays for survival causes, daily votes, badge play, skills, charge/hook, sacrifice, deep-water, or turn-by-turn claims.
- T3: video or trustworthy transcripts for speech, persuasion, adaptation, and night-discussion claims.

## Acquire Data

From the repository root, run `go run ./cmd/player-data`. It defaults to the maintained 12-player list; use `-ids` to replace it.

Use the default T1 output unless the requested conclusion needs replays. For T2, pass `-tier 2`; constrain retrieval with `-replay-since` or `-replay-max-per-player` only when full retrieval is impractical. Preserve coverage metadata.

The command reads local WeChat credentials or `HUASHAN_QUERY_TOKEN`. Never print, serialize, quote, or persist a token. Keep generated data in the ignored `analysis-output/` directory unless the user requests another path.

## Analyze

1. Declare fetch time, scope, tiers, endpoint coverage, missing data, and whether the result is complete or sampled.
2. Establish same-camp and preferably same-season baselines. Do not compare raw good-camp and wolf-camp scores.
3. Split career from recent form, then control for camp, ordinary/special roles, high-volume identities, format, and rule era.
4. Apply the routed knowledge pages. Treat mechanically coupled metrics as one signal unless conditioning adds independent information.
5. Support every major claim with at least two non-duplicate signals and state a competing explanation or counterevidence.
6. Report each player's good-camp and wolf-camp profile separately: primary pattern, evidence with denominators, suitable duties, vulnerability, confidence, and missing evidence.

## Boundaries

- Do not infer speech content, private night discussion, team decision ownership, or motive without a source that records it.
- Do not turn missing T2/T3 evidence into a confident archetype; state the strongest narrower conclusion the data supports.
- If access, token, upstream failures, or retrieval cost block the required tier, report obtained coverage and stop expanding the claim.
- Do not turn historical data into deterministic in-game tells. For live-match use, frame findings as private preparation rather than quotable database speech.
