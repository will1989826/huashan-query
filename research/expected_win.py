"""Phase 2c/2d prototype (v0): expected win probability + result over-expectation.

Builds on pregame_strength.py. Per game we form a good-camp win model from the two
camps' pre-game strengths (leak-free, only prior games) plus season/edition controls,
then the over-expectation residual = actual - predicted. This is the decomposed
"对局成色" signal (difficulty side); it is NOT a single 含金量 score and does NOT by
itself credit an individual — that needs separate in-game execution evidence.

Round 1, revisable. Run from research/:  python expected_win.py
Writes: research/output/game_expected_win.csv  (gitignored, regenerable)
"""
import os

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import brier_score_loss

from db import engine
from pregame_strength import load_rows, pregame_strength

OUT = "output/game_expected_win.csv"


def main():
    eng = engine()

    # Per seat-game pre-game strength (leak-free), then aggregate to game x camp.
    seat = load_rows(eng)
    seat, _ = pregame_strength(seat)
    camp_str = seat.groupby(["game_id", "camp"])["pregame_strength"].mean().unstack()
    camp_str.columns = [f"{c}_str" for c in camp_str.columns]

    games = pd.read_sql(
        "SELECT g.game_id, g.victory_camp, g.season_id, g.edition_id, "
        "LEFT(g.play_date,4) AS year FROM games g "
        "WHERE g.roster_ok=1 AND g.victory_camp IN (1,2)",
        eng,
    )
    df = games.merge(camp_str, on="game_id", how="inner").dropna(subset=["good_str", "wolf_str"])
    df["y_good_win"] = (df.victory_camp == 1).astype(int)
    df["str_diff"] = df.good_str - df.wolf_str

    # Features: strengths + gap + season/edition/year controls (one-hot).
    num = df[["good_str", "wolf_str", "str_diff"]]
    cat = pd.get_dummies(df[["season_id", "edition_id", "year"]].astype("string"),
                         dummy_na=True)
    X = pd.concat([num.reset_index(drop=True), cat.reset_index(drop=True)], axis=1).astype(float)
    y = df.y_good_win.values

    model = LogisticRegression(max_iter=2000, C=1.0)
    model.fit(X, y)
    p = model.predict_proba(X)[:, 1]
    df["p_good_win"] = p
    df["resid_good"] = df.y_good_win - df.p_good_win  # >0: good won above expectation

    os.makedirs("output", exist_ok=True)
    df[["game_id", "year", "good_str", "wolf_str", "str_diff",
        "p_good_win", "y_good_win", "resid_good"]].to_csv(OUT, index=False)

    # ---- report ----
    base = y.mean()
    print(f"Games modeled: {len(df):,}  base good-win rate: {base:.4f}")
    print(f"Brier score: {brier_score_loss(y, p):.4f}  (base-rate Brier: {base*(1-base):.4f})")
    coefs = dict(zip(["good_str", "wolf_str", "str_diff"],
                     [model.coef_[0][list(X.columns).index(c)] for c in ["good_str", "wolf_str", "str_diff"]]))
    print("Key coefficients (expect good_str>0, wolf_str<0):",
          {k: round(v, 3) for k, v in coefs.items()})

    print("\nCalibration (predicted decile -> actual good-win rate):")
    df["bucket"] = pd.qcut(df.p_good_win, 10, labels=False, duplicates="drop")
    cal = df.groupby("bucket").agg(pred=("p_good_win", "mean"),
                                   actual=("y_good_win", "mean"), n=("y_good_win", "size"))
    print(cal.round(3).to_string())

    print("\nBiggest upsets — good WON with lowest predicted prob (highest 成色 for good):")
    print(df.nlargest(5, "resid_good")[["game_id", "year", "good_str", "wolf_str", "p_good_win", "y_good_win"]].round(3).to_string(index=False))
    print("\nBiggest upsets — good LOST while heavily favored (highest 成色 for wolf):")
    print(df.nsmallest(5, "resid_good")[["game_id", "year", "good_str", "wolf_str", "p_good_win", "y_good_win"]].round(3).to_string(index=False))
    print(f"\nWrote {OUT}")


if __name__ == "__main__":
    main()
