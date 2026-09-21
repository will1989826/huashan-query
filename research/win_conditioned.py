"""#1 win-conditioned find-wolf: carry (finds wolves even when losing) vs passenger."""
import pandas as pd
from db import engine


def main():
    eng = engine()
    d = pd.read_sql(
        "SELECT player_id, won, SUM(good_vote_events+find_skill_events) ev, "
        "SUM(good_vote_hits+find_skill_hits) hit, COUNT(*) g "
        "FROM analysis_game_players WHERE camp='good' AND player_id IS NOT NULL "
        "GROUP BY player_id, won", eng)
    names = pd.read_sql("SELECT player_id, player_name name FROM players", eng)
    won = d[d.won == 1].set_index("player_id")
    lost = d[d.won == 0].set_index("player_id")
    t = pd.DataFrame({
        "won_g": won.g, "lost_g": lost.g,
        "won_fw": won.hit / won.ev, "lost_fw": lost.hit / lost.ev,
    }).merge(names.set_index("player_id"), left_index=True, right_index=True)
    t = t[(t.won_g >= 15) & (t.lost_g >= 15)].dropna()
    t["gap"] = t.won_fw - t.lost_fw
    print(f"players: {len(t)}")
    print(f"全体：胜局找狼 {t.won_fw.mean():.3f}  vs  败局找狼 {t.lost_fw.mean():.3f}")
    print("\n逆风carry型（败局仍高找狼，个人到位队友没兜住）:")
    print(t.nlargest(6, "lost_fw")[["name", "won_fw", "lost_fw"]].round(3).to_string(index=False))
    print("\n顺风躺赢型（胜局找狼也低，赢靠队友）:")
    print(t[t.won_g >= 30].nsmallest(6, "won_fw")[["name", "won_fw", "lost_fw"]].round(3).to_string(index=False))


if __name__ == "__main__":
    main()
