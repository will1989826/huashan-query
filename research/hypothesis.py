"""Sharper test: within-player 站错 vs 站对 survival gap, and whether 投狼率 modulates it.
Good: 站对边/站错边 survival. Wolf: 倒钩(≈站对)/冲锋(≈站错) survival. vs overall.
"""
import json
import pandas as pd
from db import engine


def main():
    eng = engine()
    per = pd.read_sql(
        "SELECT player_id, games, final_alive_count, "
        "(good_vote_hits+find_skill_hits)/NULLIF(good_vote_events+find_skill_events,0) findwolf "
        "FROM analysis_player_periods WHERE camp='good' AND period_type='career' AND period_key='all'", eng)
    cond = pd.read_sql(
        "SELECT p.player_id, "
        "SUM(p.zhanbian_att=1 AND p.zhanbian_correct=1) rg, "
        "SUM(p.zhanbian_att=1 AND p.zhanbian_correct=1 AND p.final_alive=1) rs, "
        "SUM(p.zhanbian_att=1 AND p.zhanbian_correct=0) wg, "
        "SUM(p.zhanbian_att=1 AND p.zhanbian_correct=0 AND p.final_alive=1) ws "
        "FROM analysis_game_players p JOIN analysis_games g ON g.game_id=p.game_id "
        "WHERE g.parsed_ok=1 AND p.camp='good' AND p.player_id IS NOT NULL GROUP BY p.player_id", eng)
    d = per.merge(cond, on="player_id", how="left")
    d["overall"] = d.final_alive_count / d.games
    d["right_s"] = d.rs / d.rg
    d["wrong_s"] = d.ws / d.wg
    d["gap"] = d.wrong_s - d.right_s      # 站错存活 - 站对存活；≈0=错不受罚(被容忍)
    d = d[(d.games >= 30) & (d.rg >= 5) & (d.wg >= 5)].dropna(subset=["findwolf", "right_s", "wrong_s"])

    print(f"好人（站对>=5 且 站错>=5）: {len(d)}")
    print(f"均值:  整体 {d.overall.mean():.3f}  |  站对边 {d.right_s.mean():.3f}  |  站错边 {d.wrong_s.mean():.3f}")
    print(f"corr(投狼率, 站错−站对 差) = {d.findwolf.corr(d.gap):+.3f}  (你的假设成立则应为负)")
    d = d.copy()
    d["decile"] = pd.qcut(d.findwolf, 10, labels=[f"D{i}" for i in range(1, 11)])
    print("\n按投狼率(自算找狼率)10 档 → 站对边/站错边存活率:")
    tab = d.groupby("decile", observed=True).agg(
        投狼率均值=("findwolf", "mean"), 站对边存活=("right_s", "mean"),
        站错边存活=("wrong_s", "mean"), 站错减站对=("gap", "mean"), 人数=("gap", "size"))
    tab["投狼率均值"] = (tab["投狼率均值"] * 100).round(1)
    print(tab.round(3).to_string())

    # 狼人：倒钩(≈站对) / 冲锋(≈站错) / 整体
    w = pd.read_sql(
        "SELECT games, final_alive_count, charge_games, charge_survived_games, hook_games, hook_survived_games "
        "FROM analysis_player_periods WHERE camp='wolf' AND period_type='career' AND period_key='all'", eng)
    w = w[(w.charge_games >= 5) & (w.hook_games >= 5) & (w.games >= 30)].copy()
    w["overall"] = w.final_alive_count / w.games
    w["charge_s"] = w.charge_survived_games / w.charge_games
    w["hook_s"] = w.hook_survived_games / w.hook_games
    print(f"\n狼人（冲锋>=5 且 倒钩>=5）: {len(w)}")
    print(f"均值:  整体 {w.overall.mean():.3f}  |  倒钩后(≈站对) {w.hook_s.mean():.3f}  |  冲锋后(≈站错) {w.charge_s.mean():.3f}")


if __name__ == "__main__":
    main()
