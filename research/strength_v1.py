"""Phase 2 round 2 (A): richer leak-free pre-game strength, retest expected win.

v0 used only prior camp win rate and barely beat the base rate (Brier 0.2188 vs
0.2206). Round 2 adds two leak-free prior signals that should be more skill-stable:
prior find-wolf accuracy (good) and prior survival rate. We feed all of them into the
game-level win model and compare Brier to v0 — an honest test of whether "difficulty"
is predictable at all from history.

Run from research/:  python strength_v1.py
"""
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import brier_score_loss

from db import engine

K = 20.0


def prior_shrunk(df, group_cols, order_col, num, den, base):
    """Leak-free expanding prior rate = (prior_num + base*K)/(prior_den + K)."""
    d = df.sort_values(group_cols + [order_col])
    g = d.groupby(group_cols, sort=False)
    prior_num = g[num].cumsum() - d[num]
    if den is None:
        prior_den = g.cumcount()
    else:
        prior_den = g[den].cumsum() - d[den]
    return ((prior_num + base * K) / (prior_den + K)).reindex(df.index)


def main():
    eng = engine()
    seat = pd.read_sql(
        "SELECT p.game_id, p.player_id, p.camp, p.won, p.final_alive, "
        "p.good_vote_events AS gve, p.good_vote_hits AS gvh "
        "FROM analysis_game_players p JOIN analysis_games g ON g.game_id=p.game_id "
        "WHERE g.parsed_ok=1 AND p.player_id IS NOT NULL",
        eng,
    )
    order = pd.read_sql(
        "SELECT p.game_id, g.play_date FROM analysis_game_players p "
        "JOIN analysis_games g ON g.game_id=p.game_id WHERE g.parsed_ok=1 "
        "GROUP BY p.game_id, g.play_date", eng,
    ).sort_values(["play_date", "game_id"]).reset_index(drop=True)
    order["order_idx"] = np.arange(len(order))
    seat = seat.merge(order[["game_id", "order_idx"]], on="game_id", how="left")

    base_win = seat.groupby("camp")["won"].mean().to_dict()
    base_surv = seat.groupby("camp")["final_alive"].mean().to_dict()
    base_fw = seat.gvh.sum() / seat.gve.sum()

    seat["pw"] = prior_shrunk(seat, ["player_id", "camp"], "order_idx", "won", None,
                              seat["camp"].map(base_win))
    seat["ps"] = prior_shrunk(seat, ["player_id", "camp"], "order_idx", "final_alive", None,
                              seat["camp"].map(base_surv))
    seat["pf"] = prior_shrunk(seat, ["player_id", "camp"], "order_idx", "gvh", "gve", base_fw)

    # Aggregate to game x camp, pivot to good_*/wolf_* feature columns.
    agg = seat.groupby(["game_id", "camp"])[["pw", "ps", "pf"]].mean().unstack("camp")
    agg.columns = [f"{camp}_{feat}" for feat, camp in agg.columns]
    agg = agg.reset_index()

    games = pd.read_sql(
        "SELECT game_id, victory_camp, season_id, edition_id, LEFT(play_date,4) AS year "
        "FROM games WHERE roster_ok=1 AND victory_camp IN (1,2)", eng,
    )
    df = games.merge(agg, on="game_id", how="inner").dropna()
    df["y"] = (df.victory_camp == 1).astype(int)
    y = df.y.values

    feat_cols = ["good_pw", "wolf_pw", "good_ps", "wolf_ps", "good_pf", "wolf_pf"]
    ctrl = pd.get_dummies(df[["season_id", "edition_id", "year"]].astype("string"), dummy_na=True)

    def fit(cols):
        X = pd.concat([df[cols].reset_index(drop=True), ctrl.reset_index(drop=True)], axis=1).astype(float)
        m = LogisticRegression(max_iter=3000).fit(X, y)
        return brier_score_loss(y, m.predict_proba(X)[:, 1]), m, X

    base = y.mean()
    print(f"Games: {len(df):,}  base good-win: {base:.4f}  base-rate Brier: {base*(1-base):.4f}")
    b_v0, _, _ = fit(["good_pw", "wolf_pw"])
    b_v1, m1, X1 = fit(feat_cols)
    print(f"v0 (win rate only)     Brier: {b_v0:.4f}")
    print(f"v1 (+ findwolf + surv) Brier: {b_v1:.4f}")
    print(f"improvement vs v0: {b_v0 - b_v1:+.4f}  | vs base rate: {base*(1-base) - b_v1:+.4f}")
    coefs = {c: round(m1.coef_[0][list(X1.columns).index(c)], 3) for c in feat_cols}
    print("v1 coefficients:", coefs)

    p = m1.predict_proba(X1)[:, 1]
    print(f"\nv1 predicted-prob range: {p.min():.3f}–{p.max():.3f} (wider = more resolving power)")


if __name__ == "__main__":
    main()
