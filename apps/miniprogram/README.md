# WeChat Mini Program

This app has no project-owned backend. It keeps a user-provided Huashan Token
in memory and calls `https://v2.huashan.tv/api` directly with `wx.request`.

Player and event services expose stable facades in `huashan.js` and
`events.js`. HTTP access, paging, and session caches live in `player-data.js`
and `event-data.js`; the facades coordinate cross-layer operations. Pure
display, aggregation, grouping, and draw inference live in `player-model.js`
and `event-model.js`.

## Open in WeChat DevTools

1. Import this directory, not the repository root.
2. Use the configured AppID, or replace it with a test AppID in `project.config.json`.
3. Keep domain validation disabled while testing the direct API connection.
4. Compile, paste a valid Token, and validate the current account.

The current prototype implements a standalone home, name or exact-ID player search, four-section
player details with shared zone, season, and sect scope, complete match history, a 12-player comparison basket, event data,
and the full toolbox. The Overview section renders
independently. Role, edition, and match-history sections are derived from the
complete match list. The remaining 100-row API pages load with four workers;
filters and sorting become available only after that process finishes so
partial results are not mistaken for complete ones. Match rows open a replay
with the same seat, day, vote, skill, elimination, and penalty views as the
desktop app.

The home page offers the same four themes as desktop: Qingya Night, Cinnabar
Paper, Yulehui, and Jinfeng Xiyulou. The selected theme id and per-player crest
choice are persisted; the Token remains memory-only. The chosen palette applies
to every page and the native navigation bar. Player profiles match available
crests by normalized sect name, auto-select a unique match, and ask the user to
choose when more than one crest matches.

Comparison matches the desktop feature set: individual or batch player selection with ambiguous-name confirmation, shared zone and season scope,
camp and custom metrics, both role layouts, sorting, temporary player focus,
and shared-match summaries or details. Shared matches can be filtered by
edition, ordered by date, revealed in batches, and opened in the full replay.
Comparison opens as its own result page. Metrics stay in a fixed left-hand
rail while player columns scroll horizontally, so every value being compared
remains on the same row. Shared-match player summaries use the same compact
horizontal browsing pattern.

Event Data uses the desktop scope and calculation rules. It requires a zone,
season, and competition type, shows official sect rankings first, then derives
sect averages and player rankings from the scoped official aggregate. Opening a
sect reads scoped match rows to identify its participants and calculate their
match count, total, average, win rate, and awards.

The Toolbox contains all three desktop tools. Rules Quick Search reuses the full
2026.4.4 handbook-derived catalog. Draw Simulation supports playoff 15-take-14
and final 16-take-15 scoring, including carry points, off-match penalties,
future projections, and tied ranks. Group Simulation seeds every ranked sect by
total, MVP, SVP, fewer BGX, and sect id, then draws them into balanced A-D groups. Draw projections are persisted per zone, season, and competition type; group results mark the next, pending, assigned, and most recently drawn teams.

## Current usage

1. Paste and validate a Token.
2. From Home, open Personal Data and search by player name or switch to exact ID lookup.
3. Tap a result to open Overview, Role Performance, Edition Performance, or
   Match History as separate sections of the detail page. Use the zone, season, and sect pickers to apply one scope to all four sections.
4. Filter Role Performance by camp and sort it by any displayed metric. Search
   Edition Performance by name and sort it by any displayed metric.
5. Filter Match History by role, sect, result, camp, or match mark, then sort by
   date or point. Tap a match to open its Seat or Day replay. Use Load More to
   reveal 20 more in-memory rows.
6. Reopening a recently viewed player or replay reuses in-memory data. Use Reload on the
   detail page to explicitly request current official data.
7. Add up to 12 search results to the comparison basket one at a time, or paste multiple names and confirm ambiguous matches. Compare by camp or
   role, or find matches attended by every selected player. Hiding a player
   changes only the display and does not change the shared-match sample. On
   the result page, tap a metric to sort and swipe left to see more players.
8. Open Event Data, select a zone, season, and competition type, then switch
   among Sect Ranking, Sect Average, and Player Ranking. Tap a sect to read its
   scoped participant list.
9. Open Toolbox to search the rules, simulate a playoff or final draw, or draw
   regular-season and challenger teams into four groups.

If either player stats or match history fails, the page keeps the other section
available and identifies the section that could not be read. A 401 or 403
response clears the in-memory session and returns to Token entry.

## Security boundary

- The raw Token is stored only in a module variable.
- It is not written with `wx.setStorage` and disappears when the process is
  reclaimed.
- It is never placed in a URL or console output.
- A 401 or 403 response clears it immediately.

Do not add analytics or generic request logging around authorization headers.
