"""#2 role slices + #3 time trend."""
import pandas as pd
from db import engine


def main():
    eng = engine()

    # #2 survival & win by role (population level).
    role = pd.read_sql(
        "SELECT role_name, camp, COUNT(*) games, AVG(final_alive) survival, AVG(won) win, "
        "AVG(death_day>=2 AND death_phase='night' AND final_alive=0) d2plus_night_death "
        "FROM analysis_game_players WHERE role_name IS NOT NULL AND player_id IS NOT NULL "
        "GROUP BY role_name, camp HAVING games>=200 ORDER BY survival DESC", eng)
    print("== #2 按身份：存活/胜率/D2+夜死 ==")
    print(role.round(3).to_string(index=False))

    # #3 time trend: recent-50 vs career find-wolf per good player (rising/falling).
    car = pd.read_sql(
        "SELECT player_id, games, (good_vote_hits+find_skill_hits)/(good_vote_events+find_skill_events) fw "
        "FROM analysis_player_periods WHERE camp='good' AND period_type='career' AND period_key='all'", eng)
    rec = pd.read_sql(
        "SELECT player_id, (good_vote_hits+find_skill_hits)/(good_vote_events+find_skill_events) fw "
        "FROM analysis_player_periods WHERE camp='good' AND period_type='recent' AND period_key='50'", eng)
    names = pd.read_sql("SELECT player_id, player_name name FROM players", eng)
    m = car.merge(rec, on="player_id", suffixes=("_car", "_rec")).merge(names, on="player_id")
    m = m[m.games >= 80].dropna()
    m["delta"] = m.fw_rec - m.fw_car
    print("\n== #3 找狼率上升最多（最近50 - 生涯，>=80局）==")
    print(m.nlargest(6, "delta")[["name", "fw_car", "fw_rec", "delta"]].round(3).to_string(index=False))
    print("== 下滑最多 ==")
    print(m.nsmallest(6, "delta")[["name", "fw_car", "fw_rec", "delta"]].round(3).to_string(index=False))


if __name__ == "__main__":
    main()
