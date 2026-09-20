"""Phase 2 synthesis: per player-game 对局成色 view (execution-centric).

Axis = individual in-game execution (attributable). Team difficulty (opponent
strength, expected win, over-expectation residual) rides along ONLY as descriptive
context tags — round-2 evidence showed it barely predicts outcomes, so it is never
folded into a single 含金量 score. Every rate keeps its numerator/denominator.

Good execution: find-wolf (votes+skills) vs the field, badge carried, survival.
Wolf execution: hantiao (+badge), charge/hook, self-destruct, survived-after-exposure.
Round-2 TODO: key-exile-round weighting, true-seer clearance (needs seer identification).

Run from research/:  python game_quality.py
Writes: research/output/game_quality.csv  (gitignored, regenerable)
"""
import os

import numpy as np
import pandas as pd

from db import engine
from game_facts import GOOD_FIND_SKILLS, in_list
from pregame_strength import game_aggregates, load_rows, pregame_strength

OUT = "output/game_quality.csv"


def main():
    eng = engine()

    base = pd.read_sql(
        "SELECT p.game_id, p.seat, p.player_id, p.camp, p.role_name, p.won, p.final_alive, "
        "g.total_days, p.death_day, p.good_vote_events AS gve, p.good_vote_hits AS gvh, "
        "(p.day_of_badge IS NOT NULL) AS carried_badge, "
        "(p.day_of_hantiao IS NOT NULL) AS hantiao, "
        "(p.self_destruct_day IS NOT NULL) AS self_destruct, "
        "p.wolf_charge_votes AS charge, p.wolf_hook_votes AS hook "
        "FROM analysis_game_players p JOIN analysis_games g ON g.game_id=p.game_id "
        "WHERE g.parsed_ok=1 AND p.player_id IS NOT NULL",
        eng,
    )

    # Good find-wolf skill attempts/hits by actor seat (merged with votes below).
    skills = pd.read_sql(
        "SELECT game_id, actor_seat AS seat, COUNT(*) AS sk_att, "
        "SUM(target_camp='wolf') AS sk_hit "
        f"FROM analysis_skill_events WHERE actor_camp='good' AND skill_name IN {in_list(GOOD_FIND_SKILLS)} "
        "AND target_seat IS NOT NULL GROUP BY game_id, actor_seat",
        eng,
    )
    df = base.merge(skills, on=["game_id", "seat"], how="left")
    df[["sk_att", "sk_hit"]] = df[["sk_att", "sk_hit"]].fillna(0).astype(int)

    # Merged find-wolf (votes + skills).
    df["fw_att"] = df.gve + df.sk_att
    df["fw_hit"] = df.gvh + df.sk_hit

    # Good-side team totals per game -> the field each good player is compared to.
    good = df.camp == "good"
    team = df[good].groupby("game_id").agg(team_att=("fw_att", "sum"), team_hit=("fw_hit", "sum")).reset_index()
    df = df.merge(team, on="game_id", how="left")
    field_att = (df.team_att - df.fw_att).where(good)
    field_hit = (df.team_hit - df.fw_hit).where(good)
    df["self_fw_rate"] = np.where(df.fw_att > 0, df.fw_hit / df.fw_att, np.nan)
    df["field_fw_rate"] = np.where(field_att > 0, field_hit / field_att, np.nan)
    df["above_field"] = df.self_fw_rate - df.field_fw_rate

    # Wolf execution.
    wolf = df.camp == "wolf"
    df["hantiao_got_badge"] = (wolf & df.hantiao & df.carried_badge).fillna(False)
    df["exposed"] = (wolf & (df.hantiao | df.self_destruct | (df.charge > 0))).fillna(False)
    df["survived_after_exposed"] = (df.exposed & (df.final_alive == 1)).fillna(False)

    # Survival.
    df["survived_to_end"] = df.final_alive == 1
    df["survival_days"] = np.where(df.final_alive == 1, df.total_days, df.death_day)

    # Context tags (descriptive only): pre-game strengths + expected win / residual.
    seat = load_rows(eng)
    seat, _ = pregame_strength(seat)
    seat = game_aggregates(seat)
    ctx = seat[["game_id", "player_id", "pregame_strength", "opponent_strength", "teammate_support"]]
    df = df.merge(ctx, on=["game_id", "player_id"], how="left")
    try:
        resid = pd.read_csv("output/game_expected_win.csv")[["game_id", "p_good_win", "resid_good"]]
        df = df.merge(resid, on="game_id", how="left")
        df["resid_camp"] = np.where(good, df.resid_good, -df.resid_good)
    except FileNotFoundError:
        df["p_good_win"] = df["resid_good"] = df["resid_camp"] = np.nan
        print("(run expected_win.py first for the difficulty context tags)\n")

    cols = ["game_id", "player_id", "camp", "role_name", "won", "survived_to_end", "survival_days",
            "fw_hit", "fw_att", "self_fw_rate", "field_fw_rate", "above_field", "carried_badge",
            "hantiao", "hantiao_got_badge", "charge", "hook", "self_destruct",
            "exposed", "survived_after_exposed",
            "pregame_strength", "opponent_strength", "teammate_support", "p_good_win", "resid_camp"]
    os.makedirs("output", exist_ok=True)
    df[cols].to_csv(OUT, encoding="utf-8-sig", index=False)

    # ---- report ----
    print(f"Per player-game 成色 rows: {len(df):,}\n")
    g = df[good & (df.fw_att >= 2)]
    print("GOOD axis — find-wolf vs field:")
    print(f"  seat-games scored: {len(g):,} | above_field mean {g.above_field.mean():+.3f} std {g.above_field.std():.3f}")
    print("  top '带警徽、投票带队赢下劣势局' (won, badge, above field, low p_good_win):")
    pick = g[(g.won == 1) & (g.carried_badge == 1) & (g.above_field > 0)].nsmallest(6, "p_good_win")
    print(pick[["game_id", "player_id", "fw_hit", "fw_att", "field_fw_rate", "p_good_win", "resid_camp"]].round(3).to_string(index=False))

    w = df[wolf]
    print("\nWOLF axis — exposure & carry:")
    print(f"  hantiao got badge: {int(w.hantiao_got_badge.sum()):,} | "
          f"survived after exposure: {int(w.survived_after_exposed.sum()):,}")
    print("  top '悍跳得警徽且活到终局并赢' by opponent strength (背景标签):")
    wc = w[(w.hantiao_got_badge) & (w.won == 1) & (w.survived_to_end)].nlargest(6, "opponent_strength")
    print(wc[["game_id", "player_id", "charge", "hook", "opponent_strength", "resid_camp"]].round(3).to_string(index=False))
    print(f"\nWrote {OUT}")


if __name__ == "__main__":
    main()
