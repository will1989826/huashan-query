"""Mining: wolf teammate synergy (1+1>2 or <2), controlling for individual win rate.

Confound caveat (matchup-impact.md): same sect/region/continuous schedule cluster
teammates, so synergy residuals are associations, not proof one lifts the other.
"""
from itertools import combinations

import pandas as pd
from db import engine


def main():
    eng = engine()
    w = pd.read_sql(
        "SELECT p.game_id, p.player_id, p.won FROM analysis_game_players p "
        "JOIN analysis_games g ON g.game_id=p.game_id "
        "WHERE g.parsed_ok=1 AND p.camp='wolf' AND p.player_id IS NOT NULL", eng)
    names = pd.read_sql("SELECT player_id, player_name FROM players", eng).set_index("player_id").player_name
    solo = w.groupby("player_id").won.mean()   # individual wolf win rate

    rows = []
    for gid, grp in w.groupby("game_id"):
        ids = sorted(grp.player_id.tolist())
        won = grp.won.iloc[0]
        for a, b in combinations(ids, 2):
            rows.append((a, b, won))
    pairs = pd.DataFrame(rows, columns=["a", "b", "won"])
    agg = pairs.groupby(["a", "b"]).won.agg(co_games="size", co_win="mean").reset_index()
    agg = agg[agg.co_games >= 10]
    agg["exp"] = (agg.a.map(solo) + agg.b.map(solo)) / 2
    agg["synergy"] = agg.co_win - agg.exp
    agg["na"], agg["nb"] = agg.a.map(names), agg.b.map(names)

    print(f"狼搭档对(共同>=10局): {len(agg):,}")
    print("\n最强协同(一起赢得比各自平均更多):")
    print(agg.nlargest(8, "synergy")[["na", "nb", "co_games", "co_win", "exp", "synergy"]].round(3).to_string(index=False))
    print("\n最负协同(一起反而更差):")
    print(agg.nsmallest(8, "synergy")[["na", "nb", "co_games", "co_win", "exp", "synergy"]].round(3).to_string(index=False))


if __name__ == "__main__":
    main()
