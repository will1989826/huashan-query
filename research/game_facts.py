"""Single-game A-tier fact labeling (round 1).

Every field here is computable from ONE reconstructed game — no history needed, so
these exist from the very first game (the cold-start answer). They are the raw
"numerators" that later accumulate into traits and pre-game strength.

Grain = (game_id, seat): a fact is per seat-in-game. Seats are unique within a game,
so merges never fan out. player_id is carried as an attribute (NOTE: the source has a
few games where one player_id spans multiple seats — a data defect reported below;
seat grain isolates it instead of silently double-counting).

Scope (built): identity/result, survival & death (clean cause enum), awards,
good-side find-wolf votes + skills, abstain, wolf hantiao/self-destruct/charge/hook,
being self-knifed, being seer-checked (查杀/金水).
Deferred (need true-seer identification or extra parsing): 站对边, 屠边方向, 改票.

Run from research/:  python game_facts.py
Writes: research/output/game_facts.csv  (gitignored, regenerable)
"""
import os

import numpy as np
import pandas as pd

from db import engine

# v0 good-side wolf-finding skills (target a wolf = a hit). Tunable in later rounds.
GOOD_FIND_SKILLS = ["预言家", "女巫毒", "猎人枪", "骑士骑", "侦探翻", "猎魔人", "警犬查验"]
OUT = "output/game_facts.csv"


def in_list(names):
    return "(" + ",".join("'" + n + "'" for n in names) + ")"


def main():
    eng = engine()

    base = pd.read_sql(
        "SELECT p.game_id, p.seat, g.play_date, g.total_days, p.player_id, p.camp, "
        "p.role_name, p.won, p.final_alive, p.death_day, p.death_phase, p.death_cause, "
        "p.death_doubt, p.mvp, p.svp, p.bgx, p.good_vote_events, p.good_vote_hits, "
        "p.badge_vote_events, p.badge_vote_hits, p.wolf_charge_votes, p.wolf_hook_votes, "
        "p.day_of_hantiao, p.hantiao_role_name, p.self_destruct_day "
        "FROM analysis_game_players p JOIN analysis_games g ON g.game_id=p.game_id "
        "WHERE g.parsed_ok=1 AND p.player_id IS NOT NULL",
        eng,
    )

    # Good-side find-wolf skill attempts/hits, by actor seat.
    skills = pd.read_sql(
        "SELECT game_id, actor_seat AS seat, COUNT(*) AS find_skill_attempts, "
        "SUM(target_camp='wolf') AS find_skill_hits "
        f"FROM analysis_skill_events WHERE actor_camp='good' AND skill_name IN {in_list(GOOD_FIND_SKILLS)} "
        "AND target_seat IS NOT NULL GROUP BY game_id, actor_seat",
        eng,
    )

    # Being self-knifed (wolf knife on a wolf), by target seat -> the day it happened.
    selfknife = pd.read_sql(
        "SELECT game_id, target_seat AS seat, MIN(day) AS self_knifed_day "
        "FROM analysis_skill_events WHERE skill_name='狼刀' AND target_camp='wolf' "
        "AND target_seat IS NOT NULL GROUP BY game_id, target_seat",
        eng,
    )

    # Being seer-checked, by target seat -> 查杀 if checked player is wolf else 金水.
    checked = pd.read_sql(
        "SELECT game_id, target_seat AS seat, MAX(target_camp='wolf') AS checked_as_wolf "
        "FROM analysis_skill_events WHERE skill_name='预言家' AND target_seat IS NOT NULL "
        "GROUP BY game_id, target_seat",
        eng,
    )

    # Day-vote abstains, by voter seat.
    abstain = pd.read_sql(
        "SELECT game_id, voter_seat AS seat, SUM(abstain) AS abstain_day_votes "
        "FROM analysis_votes WHERE vote_kind='day' GROUP BY game_id, voter_seat",
        eng,
    )

    df = base.merge(skills, on=["game_id", "seat"], how="left") \
             .merge(selfknife, on=["game_id", "seat"], how="left") \
             .merge(checked, on=["game_id", "seat"], how="left") \
             .merge(abstain, on=["game_id", "seat"], how="left")
    assert len(df) == len(base), "merge fan-out: a per-seat key was not unique"

    for c in ["find_skill_attempts", "find_skill_hits", "abstain_day_votes"]:
        df[c] = df[c].fillna(0).astype(int)

    # Derived single-game facts.
    df["survival_days"] = np.where(df.final_alive == 1, df.total_days, df.death_day)
    df["findwolf_attempts"] = df.good_vote_events + df.find_skill_attempts
    df["findwolf_hits"] = df.good_vote_hits + df.find_skill_hits
    df["checked_by_seer"] = df.checked_as_wolf.notna().astype(int)
    df["seer_result"] = np.where(
        df.checked_as_wolf.isna(), None,
        np.where(df.checked_as_wolf == 1, "查杀", "金水"),
    )

    os.makedirs("output", exist_ok=True)
    df.to_csv(OUT, index=False, encoding="utf-8-sig")

    # ---- report ----
    print(f"Labeled {len(df):,} seat-games across {df.game_id.nunique():,} games.\n")
    good = df[df.camp == "good"]
    wolf = df[df.camp == "wolf"]
    print("Good find-wolf (votes+skills), seat-games with >=1 attempt:",
          int((good.findwolf_attempts > 0).sum()),
          "| overall hit rate:",
          round(good.findwolf_hits.sum() / good.findwolf_attempts.sum(), 4))
    print("Seer-checked seat-games:", int(df.checked_by_seer.sum()),
          "| 查杀:", int((df.seer_result == "查杀").sum()),
          "| 金水:", int((df.seer_result == "金水").sum()))
    print("Wolf hantiao:", int(wolf.day_of_hantiao.notna().sum()),
          "| self-destruct:", int(wolf.self_destruct_day.notna().sum()),
          "| self-knifed:", int(wolf.self_knifed_day.notna().sum()))
    print("Abstain day-votes total:", int(df.abstain_day_votes.sum()))
    print("\nDeath cause distribution:")
    print(df.death_cause.value_counts(dropna=True).to_string())

    # ---- data-quality: one player_id spanning multiple seats in a game ----
    dup = df.groupby(["game_id", "player_id"]).size()
    dup = dup[dup > 1]
    print(f"\n[data quality] games where one player_id spans multiple seats: "
          f"{dup.index.get_level_values(0).nunique()} games, {len(dup)} player-pairs, "
          f"{int(dup.sum() - len(dup))} extra seat-rows.")
    print(f"\nWrote {OUT}")


if __name__ == "__main__":
    main()
