"""Phase 3d: mine interaction rules from the metric correlation structure.

Instead of hand-guessing pairs, build a per-player table with good- and wolf-camp
metrics side by side (incl. 被验读感 = how the seer treats them), correlate everything,
and rank the pairs. Strong +/- correlations and notable near-zero independences each
become candidate interaction rules to interpret.

Run from research/:  python cross_correlations.py
"""
import numpy as np
import pandas as pd

from db import engine

LABEL = {
    "g_findwolf": "好·找狼", "g_survival": "好·存活", "g_win": "好·胜率", "g_mvp": "好·MVP",
    "g_badge": "好·警长", "g_jinshui": "好·被金水率", "g_early": "好·早死",
    "w_survival": "狼·存活", "w_win": "狼·胜率", "w_mvp": "狼·MVP", "w_hantiao": "狼·悍跳率",
    "w_expsv": "狼·暴露后存活", "w_selfd": "狼·自爆率", "w_chasha": "狼·被查杀率", "w_early": "狼·早死",
}


def main():
    eng = engine()
    per = pd.read_sql(
        "SELECT player_id, camp, games, wins, final_alive_count, mvp_count, "
        "good_vote_events, good_vote_hits, find_skill_events, find_skill_hits, "
        "badge_games, hantiao_games, self_destruct_games, exposed_games, exposed_survived_games "
        "FROM analysis_player_periods WHERE period_type='career' AND period_key='all'", eng)
    checked = pd.read_sql(
        "SELECT gp.player_id, gp.camp, COUNT(*) games, "
        "SUM(chk.target_seat IS NOT NULL) checked "
        "FROM analysis_game_players gp LEFT JOIN "
        "(SELECT DISTINCT game_id, target_seat FROM analysis_skill_events "
        " WHERE skill_name='预言家' AND target_seat IS NOT NULL) chk "
        "ON chk.game_id=gp.game_id AND chk.target_seat=gp.seat "
        "WHERE gp.player_id IS NOT NULL GROUP BY gp.player_id, gp.camp", eng)
    early = pd.read_sql(
        "SELECT player_id, camp, AVG(death_day<=2 AND final_alive=0) early "
        "FROM analysis_game_players WHERE player_id IS NOT NULL AND death_day IS NOT NULL "
        "GROUP BY player_id, camp", eng)

    per = per.merge(checked[["player_id", "camp", "checked"]], on=["player_id", "camp"], how="left")
    per = per.merge(early, on=["player_id", "camp"], how="left")
    per["survival"] = per.final_alive_count / per.games
    per["win"] = per.wins / per.games
    per["mvp"] = per.mvp_count / per.games
    per["findwolf"] = (per.good_vote_hits + per.find_skill_hits) / (
        per.good_vote_events + per.find_skill_events).replace(0, np.nan)
    per["badge"] = per.badge_games / per.games
    per["hantiao"] = per.hantiao_games / per.games
    per["selfd"] = per.self_destruct_games / per.games
    per["expsv"] = per.exposed_survived_games / per.exposed_games.replace(0, np.nan)
    per["checked_rate"] = per.checked / per.games

    g = per[per.camp == "good"].set_index("player_id")
    w = per[per.camp == "wolf"].set_index("player_id")
    tbl = pd.DataFrame({
        "g_findwolf": g.findwolf, "g_survival": g.survival, "g_win": g.win, "g_mvp": g.mvp,
        "g_badge": g.badge, "g_jinshui": g.checked_rate, "g_early": g.early, "g_games": g.games,
        "w_survival": w.survival, "w_win": w.win, "w_mvp": w.mvp, "w_hantiao": w.hantiao,
        "w_expsv": w.expsv, "w_selfd": w.selfd, "w_chasha": w.checked_rate, "w_early": w.early,
        "w_games": w.games,
    })
    tbl = tbl[(tbl.g_games >= 30) & (tbl.w_games >= 30)].drop(columns=["g_games", "w_games"])
    print(f"Players with >=30 good AND >=30 wolf games: {len(tbl):,}\n")

    corr = tbl.corr()
    cols = list(corr.columns)
    pairs = []
    for i in range(len(cols)):
        for j in range(i + 1, len(cols)):
            pairs.append((cols[i], cols[j], corr.iloc[i, j]))
    pairs.sort(key=lambda x: -abs(x[2]))

    def lab(a, b, r):
        cross = "跨" if a[0] != b[0] else "  "
        return f"  [{cross}] {LABEL[a]:<8} × {LABEL[b]:<10} r={r:+.2f}"

    print("== 最强正相关 ==")
    for a, b, r in [p for p in pairs if p[2] > 0][:10]:
        print(lab(a, b, r))
    print("\n== 最强负相关 ==")
    for a, b, r in [p for p in pairs if p[2] < 0][:10]:
        print(lab(a, b, r))
    print("\n== 跨阵营相关(好×狼),按|r|排 ==")
    cross = [p for p in pairs if p[0][0] != p[1][0]]
    for a, b, r in cross[:12]:
        print(lab(a, b, r))


if __name__ == "__main__":
    main()
