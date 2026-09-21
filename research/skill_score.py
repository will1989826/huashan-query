"""#6 contribution score: reward individual contribution (not just team wins),
separate 躺赢 (win high, contribution low) from 被拖累 (contribution high, win low)."""
import pandas as pd
from sklearn.preprocessing import StandardScaler

from db import engine
from features import build_player_table


def z(s):
    return (s - s.mean()) / s.std()


def main():
    eng = engine()
    t = build_player_table(eng).dropna(subset=["g_findwolf", "g_mvp", "w_survival", "w_mvp"])
    # Good contribution = individual signals that drive wins (findwolf, mvp), NOT survival.
    t["good_contrib"] = (z(t.g_findwolf) + z(t.g_mvp)) / 2
    t["wolf_contrib"] = (z(t.w_survival) + z(t.w_mvp)) / 2
    t["good_luck"] = z(t.g_win) - t.good_contrib   # >0: wins above contribution = 躺赢
    t["wolf_luck"] = z(t.w_win) - t.wolf_contrib

    print("== 好人：贡献型实力分 Top ==")
    print(t.nlargest(6, "good_contrib")[["name", "g_findwolf", "g_mvp", "g_win"]].round(3).to_string(index=False))
    print("\n躺赢型（胜率高于个人贡献最多）:")
    print(t.nlargest(6, "good_luck")[["name", "g_findwolf", "g_mvp", "g_win"]].round(3).to_string(index=False))
    print("\n被拖累型（个人贡献高但胜率低）:")
    print(t.nsmallest(6, "good_luck")[["name", "g_findwolf", "g_mvp", "g_win"]].round(3).to_string(index=False))
    print(f"\ncorr(good_contrib, g_win) = {t.good_contrib.corr(t.g_win):+.3f}")
    print(f"corr(wolf_contrib, w_win) = {t.wolf_contrib.corr(t.w_win):+.3f}")


if __name__ == "__main__":
    main()
