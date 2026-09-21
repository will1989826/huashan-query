"""#4 conditional: does hantiao pay off (win) only when the wolf survives exposure?"""
import pandas as pd
from db import engine
from features import build_player_table


def main():
    eng = engine()
    t = build_player_table(eng)
    # exposed-survival needs the raw column; recompute from periods.
    w = pd.read_sql(
        "SELECT player_id, exposed_survived_games/NULLIF(exposed_games,0) expsv "
        "FROM analysis_player_periods WHERE camp='wolf' AND period_type='career' AND period_key='all'", eng)
    t = t.merge(w, on="player_id", how="left").dropna(subset=["w_hantiao", "w_win", "expsv"])
    med = t.expsv.median()
    print(f"wolves: {len(t)}  暴露后存活中位数 {med:.3f}\n")
    print("在不同『暴露后存活』分层内，悍跳率 与 狼胜率 的相关性:")
    for name, sub in [("暴露后存活 高", t[t.expsv >= med]), ("暴露后存活 低", t[t.expsv < med])]:
        r = sub.w_hantiao.corr(sub.w_win)
        print(f"  {name} (n={len(sub)}): corr(悍跳率, 狼胜率) = {r:+.3f}")
    print("\n解读：若高存活组相关性明显更正，说明『悍跳只有扛得住暴露时才划算』。")


if __name__ == "__main__":
    main()
