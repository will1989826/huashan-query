"""Phase 3b: metric interaction / 联动 rules.

The user's framework: derive not just per-metric levels but joint patterns. First
validate the two hypotheses on good players (career, >=30 games):
  - high find-wolf + low survival  -> finds wolves but poor speech / often on 抗推位
    (should show the HIGHEST exile rate = voted out).
  - low find-wolf + high survival  -> easily trusted but can't find wolves themselves
    (should show the LOWEST exile rate).
Splits by the camp median of each metric; validates against actual exile (白天放逐) rate.

Run from research/:  python interactions.py
"""
import numpy as np
import pandas as pd

from db import engine


def main():
    eng = engine()
    p = pd.read_sql(
        "SELECT player_id, player_name, games, final_alive_count, "
        "good_vote_events, good_vote_hits, find_skill_events, find_skill_hits "
        "FROM analysis_player_periods "
        "WHERE camp='good' AND period_type='career' AND period_key='all'",
        eng,
    )
    exile = pd.read_sql(
        "SELECT player_id, COUNT(*) AS good_games, SUM(death_cause='exile') AS exiles "
        "FROM analysis_game_players WHERE camp='good' AND player_id IS NOT NULL "
        "GROUP BY player_id",
        eng,
    )
    df = p.merge(exile, on="player_id", how="left")
    df["findwolf"] = (df.good_vote_hits + df.find_skill_hits) / (df.good_vote_events + df.find_skill_events)
    df["survival"] = df.final_alive_count / df.games
    df["exile_rate"] = df.exiles / df.good_games
    df = df[(df.games >= 30) & (df.good_vote_events + df.find_skill_events >= 10)].dropna(
        subset=["findwolf", "survival"])

    fw_med, sv_med = df.findwolf.median(), df.survival.median()
    print(f"Good players (>=30 games): {len(df):,}")
    print(f"medians — findwolf {fw_med:.3f}, survival {sv_med:.3f}")
    print(f"corr(findwolf, survival) = {df.findwolf.corr(df.survival):+.3f}")
    print(f"corr(findwolf, exile_rate) = {df.findwolf.corr(df.exile_rate):+.3f}")
    print(f"corr(survival, exile_rate) = {df.survival.corr(df.exile_rate):+.3f}\n")

    df["hi_fw"] = df.findwolf >= fw_med
    df["hi_sv"] = df.survival >= sv_med
    labels = {
        (True, True): "强(会找狼且能活)",
        (True, False): "能找狼但存活低 → 发言差/抗推位",
        (False, True): "存活高但找狼低 → 好人缘好、自己找不到狼",
        (False, False): "弱(找狼低且存活低)",
    }
    print("四象限(投狼/找狼 × 存活):")
    for key, name in labels.items():
        q = df[(df.hi_fw == key[0]) & (df.hi_sv == key[1])]
        print(f"  {name}: n={len(q):,} | findwolf {q.findwolf.mean():.3f} | "
              f"survival {q.survival.mean():.3f} | 放逐率 {q.exile_rate.mean():.3f}")

    # Win rate per quadrant needs wins; pull separately.
    wins = pd.read_sql(
        "SELECT player_id, wins, games FROM analysis_player_periods "
        "WHERE camp='good' AND period_type='career' AND period_key='all'", eng)
    df = df.merge(wins[["player_id", "wins"]], on="player_id", how="left")
    df["win_rate"] = df.wins / df.games
    print("\n放逐率验证(应:高找狼低存活=放逐率最高;低找狼高存活=最低):")
    for key, name in labels.items():
        q = df[(df.hi_fw == key[0]) & (df.hi_sv == key[1])]
        print(f"  {name}: 放逐率 {q.exile_rate.mean():.3f} · 胜率 {q.win_rate.mean():.3f}")


if __name__ == "__main__":
    main()
