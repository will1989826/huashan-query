"""Phase 3c: cross-camp & coupling-gap signals (人狼一致性 / 被带赢).

The user's reasoning: combine a player's good-camp and wolf-camp records, and read the
GAP between mechanically-coupled metrics. Wolf survival << wolf win is universal
(wolves die but the team wins), so the signal is the gap RELATIVE to peers.

Validates the archetype: good "好人脸" (high survival + low find-wolf = trusted but
wrong) should, as wolf, survive less and be carried more (win-survival gap large,
early death high). Then surfaces other cross/gap signals.

Run from research/:  python cross_signals.py
"""
import numpy as np
import pandas as pd

from db import engine


def main():
    eng = engine()
    per = pd.read_sql(
        "SELECT player_id, player_name, camp, games, wins, final_alive_count, "
        "good_vote_events, good_vote_hits, find_skill_events, find_skill_hits, "
        "exposed_games, exposed_survived_games "
        "FROM analysis_player_periods WHERE period_type='career' AND period_key='all'",
        eng,
    )
    early = pd.read_sql(
        "SELECT player_id, camp, AVG(death_day<=2 AND final_alive=0) AS early_exit "
        "FROM analysis_game_players WHERE player_id IS NOT NULL AND death_day IS NOT NULL "
        "GROUP BY player_id, camp", eng)

    per["survival"] = per.final_alive_count / per.games
    per["win"] = per.wins / per.games
    per["findwolf"] = (per.good_vote_hits + per.find_skill_hits) / (
        per.good_vote_events + per.find_skill_events).replace(0, np.nan)
    per = per.merge(early, on=["player_id", "camp"], how="left")

    g = per[per.camp == "good"].set_index("player_id")
    w = per[per.camp == "wolf"].set_index("player_id")
    both = pd.DataFrame({
        "name": g.player_name,
        "g_games": g.games, "w_games": w.games,
        "g_fw": g.findwolf, "g_sv": g.survival, "g_win": g.win,
        "w_sv": w.survival, "w_win": w.win, "w_early": w.early_exit,
        "w_exp_sv": w.exposed_survived_games / w.exposed_games.replace(0, np.nan),
    }).dropna(subset=["g_sv", "w_sv"])
    both = both[(both.g_games >= 30) & (both.w_games >= 30)]
    both["w_carried"] = both.w_win - both.w_sv          # larger = wins without surviving
    both["hunlang_gap"] = both.g_sv - both.w_sv          # larger = lives as good, dies as wolf

    print(f"Players with >=30 good AND >=30 wolf games: {len(both):,}\n")
    print("Cross-camp correlations:")
    print(f"  corr(good survival, wolf survival) = {both.g_sv.corr(both.w_sv):+.3f}")
    print(f"  corr(good findwolf, wolf survival) = {both.g_fw.corr(both.w_sv):+.3f}")
    print(f"  corr(wolf carried-gap, wolf early-exit) = {both.w_carried.corr(both.w_early):+.3f}"
          "  (>0 validates: bigger gap = dies earlier but wins = carried)")

    # Validate the user's archetype: good 好人脸 = high survival + low find-wolf.
    fw_med, gsv_med = both.g_fw.median(), both.g_sv.median()
    face = both[(both.g_sv >= gsv_med) & (both.g_fw < fw_med)]   # trusted but wrong
    rest = both.drop(face.index)
    print(f"\n好人脸组 (好人高存活+低找狼) n={len(face)} vs 其余 n={len(rest)}:")
    for col, lab in [("w_sv", "狼存活"), ("w_carried", "狼被带赢差(胜-存活)"), ("w_early", "狼早死率")]:
        print(f"  {lab}: {face[col].mean():.3f} vs {rest[col].mean():.3f}")

    print("\n最像『人狼不统一/只会当好人』(好人存活高、拿狼存活低、被带赢差大):")
    cand = both[(both.g_sv >= gsv_med) & (both.g_fw < fw_med)].nlargest(8, "hunlang_gap")
    print(cand[["name", "g_fw", "g_sv", "w_sv", "w_win", "w_carried"]].round(3).to_string(index=False))

    print("\n反面『拿狼比拿好人强』(拿狼存活高于拿好人):")
    opp = both.nsmallest(6, "hunlang_gap")
    print(opp[["name", "g_sv", "w_sv", "w_win", "w_exp_sv"]].round(3).to_string(index=False))


if __name__ == "__main__":
    main()
