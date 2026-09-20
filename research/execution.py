"""Phase 2e prototype (round 1): individual in-game execution ("个人带队"证据).

Attributable, per player-game, kept SEPARATE from the team win/residual (guardrail:
team win != individual skill). Focus on the user's thesis — "好人都蠢、靠自己投票赢、
尤其带警徽": a good player whose own vote accuracy beats a weak field, carries the
badge, and wins. Cross-tabbed against the difficulty residual (expected_win.py) to
surface "个人带队赢下难局".

v0 uses day-vote find-wolf + badge (the clearest "靠投票带队" signals). Skill hits and
key-round weighting are round 2. Run from research/:  python execution.py
Writes: research/output/execution.csv  (gitignored, regenerable)
"""
import os

import numpy as np
import pandas as pd

from db import engine

OUT = "output/execution.csv"


def main():
    eng = engine()

    base = pd.read_sql(
        "SELECT p.game_id, p.seat, p.player_id, p.camp, p.won, p.final_alive, "
        "p.good_vote_events AS gve, p.good_vote_hits AS gvh, "
        "(p.day_of_badge IS NOT NULL) AS carried_badge, "
        "(p.day_of_hantiao IS NOT NULL) AS hantiao, "
        "(p.self_destruct_day IS NOT NULL) AS self_destruct, "
        "p.wolf_charge_votes AS charge, p.wolf_hook_votes AS hook "
        "FROM analysis_game_players p JOIN analysis_games g ON g.game_id=p.game_id "
        "WHERE g.parsed_ok=1 AND p.player_id IS NOT NULL",
        eng,
    )

    # Good-side team find-wolf totals per game -> the "field" a good player is compared to.
    gteam = base[base.camp == "good"].groupby("game_id").agg(
        team_gve=("gve", "sum"), team_gvh=("gvh", "sum")).reset_index()
    df = base.merge(gteam, on="game_id", how="left")

    good = df.camp == "good"
    field_ev = (df.team_gve - df.gve).where(good)
    field_hi = (df.team_gvh - df.gvh).where(good)
    df["self_findwolf_rate"] = np.where(df.gve > 0, df.gvh / df.gve, np.nan)
    df["field_findwolf_rate"] = np.where(field_ev > 0, field_hi / field_ev, np.nan)
    df["above_field"] = df.self_findwolf_rate - df.field_findwolf_rate

    # "个人投票带队" candidate: good win, out-voted a weak field on find-wolf.
    df["vote_carry"] = (
        good & (df.won == 1) & (df.gve >= 2)
        & (df.above_field > 0) & (df.field_findwolf_rate < 0.5)
    ).fillna(False)

    # Difficulty residual as a context tag (from expected_win.py).
    try:
        resid = pd.read_csv("output/game_expected_win.csv")[["game_id", "p_good_win", "resid_good"]]
        df = df.merge(resid, on="game_id", how="left")
    except FileNotFoundError:
        df["p_good_win"] = np.nan
        df["resid_good"] = np.nan
        print("(run expected_win.py first for the difficulty residual join)\n")

    os.makedirs("output", exist_ok=True)
    df.to_csv(OUT, index=False, encoding="utf-8-sig")

    # ---- report ----
    g = df[good]
    print(f"Good seat-games with >=2 find-wolf votes: {int((g.gve >= 2).sum()):,}")
    print("above_field (self - teammates find-wolf rate) distribution:")
    print(g.above_field.describe()[["mean", "std", "min", "25%", "50%", "75%", "max"]].round(3).to_string())

    carry = df[df.vote_carry]
    print(f"\n'个人投票带队' candidates (good win, out-voted weak field): {len(carry):,}")
    print(f"  of which carried the badge: {int(carry.carried_badge.sum()):,}")
    print(f"  mean p_good_win of those games: {carry.p_good_win.mean():.3f}  "
          f"(low = they won as underdog)")
    print(f"  mean resid_good: {carry.resid_good.mean():.3f}  (high = beat expectation)")

    # The sharpest 个人带队赢下难局: badge carriers, big above-field, underdog game.
    sharp = carry[carry.carried_badge == 1].nlargest(8, "resid_good")
    print("\nSharpest '带警徽、个人带队赢下难局' examples:")
    cols = ["game_id", "player_id", "gvh", "gve", "self_findwolf_rate",
            "field_findwolf_rate", "p_good_win"]
    print(sharp[cols].round(3).to_string(index=False))
    print(f"\nWrote {OUT}")


if __name__ == "__main__":
    main()
