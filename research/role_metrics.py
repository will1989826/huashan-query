"""Mining: key metrics conditioned by role (beyond survival) — MVP / win / vote-find-wolf."""
import pandas as pd
from db import engine


def main():
    eng = engine()
    r = pd.read_sql(
        "SELECT role_name, camp, COUNT(*) games, AVG(won) win, AVG(mvp) mvp, "
        "SUM(good_vote_hits)/NULLIF(SUM(good_vote_events),0) vote_findwolf "
        "FROM analysis_game_players WHERE role_name IS NOT NULL AND player_id IS NOT NULL "
        "GROUP BY role_name, camp HAVING games>=200 ORDER BY mvp DESC", eng)
    print("== 按身份：胜率 / MVP率 / 白天投票找狼率(仅好人有) ==")
    print(r.round(3).to_string(index=False))


if __name__ == "__main__":
    main()
