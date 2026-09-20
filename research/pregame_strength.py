"""Phase 2a/2b prototype (v0): leak-free pre-game strength snapshots + opponent/teammate aggregates.

v0 strength scalar = a player's camp win rate using ONLY games strictly before the
current one, shrunk toward the camp base win rate with priorWeight K (same K as the
Go builder). Leak-free by construction: a player's first game gets the pure camp base.

This is round 1 of an iterative process — the strength definition is expected to be
refined in later rounds (see docs/player-analysis-roadmap.md, Phase 2).

Run from research/:  python pregame_strength.py
Writes: research/output/pregame_strength.csv  (gitignored, regenerable)
"""
import os

import numpy as np
import pandas as pd

from db import engine

K = 20.0  # prior weight, matches the Go builder's priorWeight
OUT_DIR = "output"
VERSION = "v0"


def load_rows(eng):
    """One row per identified player per reconstructed game, chronologically ordered."""
    sql = (
        "SELECT p.game_id, g.play_date, p.player_id, p.camp, p.won "
        "FROM analysis_game_players p "
        "JOIN analysis_games g ON g.game_id = p.game_id "
        "WHERE g.parsed_ok = 1 AND p.player_id IS NOT NULL AND p.won IS NOT NULL "
        "ORDER BY g.play_date, p.game_id, p.seat"
    )
    df = pd.read_sql(sql, eng)
    df["play_date"] = df["play_date"].astype(str)
    # Stable chronological order index (same-day ties broken by game_id — approximate).
    order = df[["game_id", "play_date"]].drop_duplicates().sort_values(
        ["play_date", "game_id"]
    ).reset_index(drop=True)
    order["order_idx"] = np.arange(len(order))
    df = df.merge(order[["game_id", "order_idx"]], on="game_id", how="left")
    return df


def pregame_strength(df):
    """Add prior_games and leak-free pregame_strength (v0) per (player, camp)."""
    camp_base = df.groupby("camp")["won"].mean().to_dict()
    df = df.sort_values(["player_id", "camp", "order_idx"]).reset_index(drop=True)
    grp = df.groupby(["player_id", "camp"], sort=False)
    df["prior_games"] = grp.cumcount()  # games strictly before this one
    df["prior_wins"] = grp["won"].cumsum() - df["won"]  # exclude current outcome
    base = df["camp"].map(camp_base)
    df["pregame_strength"] = (df["prior_wins"] + base * K) / (df["prior_games"] + K)
    return df, camp_base


def game_aggregates(df):
    """Add opponent_strength and teammate_support per row (two camps only)."""
    agg = df.groupby(["game_id", "camp"]).agg(
        camp_sum=("pregame_strength", "sum"), camp_cnt=("pregame_strength", "size")
    ).reset_index()
    total = df.groupby("game_id")["pregame_strength"].agg(
        total_sum="sum", total_cnt="size"
    ).reset_index()
    df = df.merge(agg, on=["game_id", "camp"], how="left").merge(total, on="game_id", how="left")
    # opponent = the other camp's mean = (game total - own camp) / (game cnt - camp cnt)
    opp_sum = df["total_sum"] - df["camp_sum"]
    opp_cnt = df["total_cnt"] - df["camp_cnt"]
    df["opponent_strength"] = opp_sum / opp_cnt.replace(0, np.nan)
    # teammate = same camp mean excluding self
    df["teammate_support"] = (df["camp_sum"] - df["pregame_strength"]) / (
        df["camp_cnt"] - 1
    ).replace(0, np.nan)
    return df


def sanity(df, camp_base):
    print(f"=== pregame_strength {VERSION} ===")
    print("Camp base win rate:", {k: round(v, 4) for k, v in camp_base.items()})
    print(f"Rows: {len(df):,}  players: {df.player_id.nunique():,}  games: {df.game_id.nunique():,}")

    first = df[df.prior_games == 0]
    base = first["camp"].map(camp_base)
    max_leak = (first["pregame_strength"] - base).abs().max()
    print(f"\nLeak check — first-appearance strength vs camp base, max abs diff: {max_leak:.2e}")
    print("  (should be ~0: a debut game carries no prior info)")

    print("\npregame_strength distribution by camp:")
    print(df.groupby("camp")["pregame_strength"].describe()[["mean", "std", "min", "max"]].to_string())

    # Endpoint check: for high-volume players, does final pregame_strength track career win rate?
    vol = df.groupby(["player_id", "camp"]).agg(
        games=("won", "size"), career_wr=("won", "mean"),
        final_strength=("pregame_strength", "last"),
    ).reset_index()
    vol = vol[vol.games >= 50]
    corr = vol[["career_wr", "final_strength"]].corr().iloc[0, 1]
    print(f"\nPlayers with >=50 games/camp: {len(vol)}  corr(final_strength, career_wr) = {corr:.3f}")
    print("Top 5 by career win rate (>=50 games):")
    print(vol.sort_values("career_wr", ascending=False).head(5).to_string(index=False))
    print("Bottom 5 by career win rate (>=50 games):")
    print(vol.sort_values("career_wr").head(5).to_string(index=False))


def main():
    eng = engine()
    df = load_rows(eng)
    df, camp_base = pregame_strength(df)
    df = game_aggregates(df)
    sanity(df, camp_base)
    os.makedirs(OUT_DIR, exist_ok=True)
    cols = ["game_id", "play_date", "order_idx", "player_id", "camp", "won",
            "prior_games", "pregame_strength", "opponent_strength", "teammate_support"]
    out = os.path.join(OUT_DIR, "pregame_strength.csv")
    df.sort_values(["order_idx", "game_id", "camp"])[cols].to_csv(out, index=False)
    print(f"\nWrote {out}")


if __name__ == "__main__":
    main()
