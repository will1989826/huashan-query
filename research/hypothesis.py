"""Test user hypothesis: is find-wolf accuracy inversely related to survival-after-
wrong-stance? Low 投狼率 -> tolerated -> survive even when 站错 (good) / 冲锋 (wolf)?
"""
import pandas as pd
from db import engine


def main():
    eng = engine()
    # Good: find-wolf (自算) + 站错边存活率 (survived among 站错 games).
    per = pd.read_sql(
        "SELECT player_id, games, (good_vote_hits+find_skill_hits)/NULLIF(good_vote_events+find_skill_events,0) findwolf "
        "FROM analysis_player_periods WHERE camp='good' AND period_type='career' AND period_key='all'", eng)
    wrong = pd.read_sql(
        "SELECT p.player_id, "
        "SUM(p.zhanbian_att=1 AND p.zhanbian_correct=0) wrong_games, "
        "SUM(p.zhanbian_att=1 AND p.zhanbian_correct=0 AND p.final_alive=1) wrong_surv "
        "FROM analysis_game_players p JOIN analysis_games g ON g.game_id=p.game_id "
        "WHERE g.parsed_ok=1 AND p.camp='good' AND p.player_id IS NOT NULL GROUP BY p.player_id", eng)
    g = per.merge(wrong, on="player_id", how="left")
    g["wrong_survival"] = g.wrong_surv / g.wrong_games
    gg = g[(g.games >= 30) & (g.wrong_games >= 5)].dropna(subset=["findwolf", "wrong_survival"])
    print(f"好人（>=30局 且 站错>=5次）: {len(gg)}")
    print(f"站错样本量中位数: {gg.wrong_games.median():.0f}")
    print(f"corr(投狼/找狼率, 站错边存活率) = {gg.findwolf.corr(gg.wrong_survival):+.3f}")
    print("  (你的假设成立则应为负：找狼越准，站错时越容易被清)")
    # 四分位对照
    gg = gg.copy()
    gg["fw_q"] = pd.qcut(gg.findwolf, 4, labels=["找狼最低", "偏低", "偏高", "找狼最高"])
    print("\n按找狼率四分位看站错边存活率:")
    print(gg.groupby("fw_q", observed=True).wrong_survival.agg(["mean", "size"]).round(3).to_string())

    # Wolf: 冲锋后存活 vs (wolf 无投狼；看倒钩占比/悍跳). 报冲锋后存活分布 + 与倒钩后存活对照
    w = pd.read_sql(
        "SELECT charge_survived_games/NULLIF(charge_games,0) charge_surv, "
        "hook_survived_games/NULLIF(hook_games,0) hook_surv, charge_games, hook_games "
        "FROM analysis_player_periods WHERE camp='wolf' AND period_type='career' AND period_key='all'", eng)
    ww = w[(w.charge_games >= 5) & (w.hook_games >= 5)].dropna()
    print(f"\n狼（冲锋、倒钩各>=5次）: {len(ww)}")
    print(f"冲锋后存活率 均值 {ww.charge_surv.mean():.3f} | 倒钩后存活率 均值 {ww.hook_surv.mean():.3f}")
    print(f"corr(冲锋后存活, 倒钩后存活) = {ww.charge_surv.corr(ww.hook_surv):+.3f}")


if __name__ == "__main__":
    main()
