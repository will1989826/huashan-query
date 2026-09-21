"""Shared builder: one wide per-player table with both-camp career metrics.

Used by the deeper analyses (clustering, win-drivers, correlations). Players kept only
if they have >=min_games in BOTH camps, so cross-camp columns are comparable.
"""
import numpy as np
import pandas as pd


def build_player_table(eng, min_games=30):
    per = pd.read_sql(
        "SELECT player_id, player_name, camp, games, wins, final_alive_count, mvp_count, "
        "good_vote_events, good_vote_hits, find_skill_events, find_skill_hits, "
        "badge_games, hantiao_games, self_destruct_games, exposed_games, exposed_survived_games "
        "FROM analysis_player_periods WHERE period_type='career' AND period_key='all'", eng)
    checked = pd.read_sql(
        "SELECT gp.player_id, gp.camp, SUM(chk.target_seat IS NOT NULL)/COUNT(*) AS checked_rate "
        "FROM analysis_game_players gp LEFT JOIN "
        "(SELECT DISTINCT game_id, target_seat FROM analysis_skill_events "
        " WHERE skill_name='预言家' AND target_seat IS NOT NULL) chk "
        "ON chk.game_id=gp.game_id AND chk.target_seat=gp.seat "
        "WHERE gp.player_id IS NOT NULL GROUP BY gp.player_id, gp.camp", eng)
    per = per.merge(checked, on=["player_id", "camp"], how="left")

    per["survival"] = per.final_alive_count / per.games
    per["win"] = per.wins / per.games
    per["mvp"] = per.mvp_count / per.games
    per["findwolf"] = (per.good_vote_hits + per.find_skill_hits) / (
        per.good_vote_events + per.find_skill_events).replace(0, np.nan)
    per["badge"] = per.badge_games / per.games
    per["hantiao"] = per.hantiao_games / per.games
    per["selfd"] = per.self_destruct_games / per.games

    g = per[per.camp == "good"].set_index("player_id")
    w = per[per.camp == "wolf"].set_index("player_id")
    tbl = pd.DataFrame({
        "name": g.player_name, "g_games": g.games, "w_games": w.games,
        "g_findwolf": g.findwolf, "g_survival": g.survival, "g_win": g.win,
        "g_mvp": g.mvp, "g_badge": g.badge, "g_checked": g.checked_rate,
        "w_survival": w.survival, "w_win": w.win, "w_mvp": w.mvp,
        "w_hantiao": w.hantiao, "w_selfd": w.selfd, "w_checked": w.checked_rate,
    })
    return tbl[(tbl.g_games >= min_games) & (tbl.w_games >= min_games)].copy()


FEATURE_LABEL = {
    "g_findwolf": "好·找狼", "g_survival": "好·存活", "g_win": "好·胜率", "g_mvp": "好·MVP",
    "g_badge": "好·警长", "g_checked": "好·被验率",
    "w_survival": "狼·存活", "w_win": "狼·胜率", "w_mvp": "狼·MVP",
    "w_hantiao": "狼·悍跳", "w_selfd": "狼·自爆", "w_checked": "狼·被查杀",
}
