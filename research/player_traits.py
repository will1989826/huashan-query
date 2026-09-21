"""Phase 3: aggregate single-game 成色 signals into player-level traits.

Reads game_quality.csv (per player-game) and rolls each execution signal up to
(player, camp, period) with numerator/denominator and a confidence tier. Slices match
the Go builder: 全生涯(career/all), 自然年(year/YYYY), 最近N场(recent/30,50,100),
always within camp. Every trait is independent (long format) — no composite persona,
no single 含金量 score. Confidence uses each trait's own event denominator.

Run from research/:  python player_traits.py
Writes: research/output/player_traits.csv  (gitignored, regenerable)
"""
import os

import numpy as np
import pandas as pd

from db import engine

OUT = "output/player_traits.csv"

# key, camp(None=both), metric_type, direction, numerator col, denominator col ('games'=count)
METRICS = [
    ("win_rate", None, "result", "high", "won", "games"),
    ("survival_rate", None, "structure", "high", "survived", "games"),
    ("findwolf_rate", "good", "ability", "high", "fw_hit", "fw_att"),
    ("above_field_mean", "good", "ability", "high", "above_field_sum", "fw_scored"),
    ("badge_carry_rate", "good", "structure", "neutral", "carried_badge", "games"),
    ("hantiao_rate", "wolf", "tendency", "neutral", "hantiao", "games"),
    ("hantiao_badge_rate", "wolf", "ability", "high", "hantiao_got_badge", "hantiao"),
    ("exposed_survival_rate", "wolf", "ability", "high", "survived_after_exposed", "exposed"),
    ("self_destruct_rate", "wolf", "tendency", "neutral", "self_destruct", "games"),
]


def confidence(den):
    if den < 10:
        return "clue_only"
    if den < 30:
        return "low"
    if den < 80:
        return "medium"
    return "higher"


def main():
    eng = engine()
    gq = pd.read_csv("output/game_quality.csv")
    dates = pd.read_sql("SELECT game_id, play_date FROM analysis_games WHERE parsed_ok=1", eng)
    names = pd.read_sql("SELECT player_id, player_name FROM players", eng)
    gq = gq.merge(dates, on="game_id", how="left").merge(names, on="player_id", how="left")
    gq["play_date"] = gq["play_date"].astype(str)
    gq["year"] = gq["play_date"].str[:4]

    # Per-game integer signals.
    gq["won"] = gq.won.fillna(0).astype(int)
    gq["survived"] = gq.survived_to_end.astype(int)
    for c in ["carried_badge", "hantiao", "hantiao_got_badge", "self_destruct", "exposed", "survived_after_exposed"]:
        gq[c] = gq[c].astype(bool).astype(int)
    gq["fw_scored"] = (gq.fw_att >= 2).astype(int)
    gq["above_field_g"] = gq.above_field.where(gq.fw_scored == 1)  # per-game, only scored

    # Chronological rank within (player, camp), newest first, for recent-N windows.
    gq = gq.sort_values(["player_id", "camp", "play_date", "game_id"],
                        ascending=[True, True, False, False])
    gq["rank"] = gq.groupby(["player_id", "camp"]).cumcount() + 1

    def slice_labeled(sub, ptype, pkey):
        s = sub.copy()
        s["period_type"], s["period_key"] = ptype, pkey
        return s

    parts = [slice_labeled(gq, "career", "all")]
    for yr, sub in gq.groupby("year"):
        parts.append(slice_labeled(sub, "year", yr))
    for n in (30, 50, 100):
        parts.append(slice_labeled(gq[gq["rank"] <= n], "recent", str(n)))
    allp = pd.concat(parts, ignore_index=True)

    agg = allp.groupby(["player_id", "player_name", "camp", "period_type", "period_key"]).agg(
        games=("won", "size"), won=("won", "sum"), survived=("survived", "sum"),
        fw_hit=("fw_hit", "sum"), fw_att=("fw_att", "sum"), fw_scored=("fw_scored", "sum"),
        above_field_sum=("above_field_g", "sum"), carried_badge=("carried_badge", "sum"),
        hantiao=("hantiao", "sum"), hantiao_got_badge=("hantiao_got_badge", "sum"),
        self_destruct=("self_destruct", "sum"), exposed=("exposed", "sum"),
        survived_after_exposed=("survived_after_exposed", "sum"),
    ).reset_index()

    rows = []
    for _, r in agg.iterrows():
        for key, camp, mtype, direction, num_c, den_c in METRICS:
            if camp is not None and camp != r.camp:
                continue
            num = r[num_c]
            den = r["games"] if den_c == "games" else r[den_c]
            if den <= 0:
                continue
            rows.append({
                "player_id": r.player_id, "player_name": r.player_name, "camp": r.camp,
                "period_type": r.period_type, "period_key": r.period_key, "games": r.games,
                "metric_key": key, "metric_type": mtype, "direction": direction,
                "numerator": round(float(num), 4), "denominator": int(den),
                "value": round(float(num) / den, 4), "confidence": confidence(int(den)),
            })
    out = pd.DataFrame(rows)
    os.makedirs("output", exist_ok=True)
    out.to_csv(OUT, encoding="utf-8-sig", index=False)

    # ---- report ----
    print(f"Trait rows: {len(out):,} | players: {out.player_id.nunique():,}")
    print("\nMetric coverage (career/all, confidence>=medium i.e. den>=30):")
    car = out[(out.period_type == "career") & (out.confidence.isin(["medium", "higher"]))]
    print(car.groupby(["metric_key", "camp"]).size().to_string())

    # Sample: a high-volume player's career traits.
    top = out[(out.period_type == "career") & (out.metric_key == "win_rate")].nlargest(1, "denominator")
    if len(top):
        pid = top.iloc[0].player_id
        pname = top.iloc[0].player_name
        print(f"\nSample player {pid} ({pname}) — career traits:")
        samp = out[(out.player_id == pid) & (out.period_type == "career")]
        print(samp[["camp", "metric_key", "numerator", "denominator", "value", "confidence"]].to_string(index=False))
    print(f"\nWrote {OUT}")


if __name__ == "__main__":
    main()
