"""Mining: 读感 — 狼相 (被查杀 as wolf) vs 好人相/存在感 (被验 as good), and its cost."""
import pandas as pd
from db import engine
from features import build_player_table


def main():
    eng = engine()
    t = build_player_table(eng).dropna(subset=["w_checked", "g_checked", "w_survival", "w_win"])
    print(f"players: {len(t)}")
    print(f"作狼被查杀率 均值 {t.w_checked.mean():.3f} | 作好人被验率 均值 {t.g_checked.mean():.3f}")
    print(f"corr(狼被查杀, 狼存活) = {t.w_checked.corr(t.w_survival):+.3f}  (负=狼相重更易被清)")
    print(f"corr(狼被查杀, 狼胜率) = {t.w_checked.corr(t.w_win):+.3f}")
    print(f"corr(好被验, 狼被查杀) = {t.g_checked.corr(t.w_checked):+.3f}  (正=两阵营都被盯=存在感)")
    print("\n狼相最重(拿狼最常被查杀):")
    print(t.nlargest(8, "w_checked")[["name", "w_checked", "w_survival", "w_win"]].round(3).to_string(index=False))
    print("\n最隐身(拿狼最少被查杀):")
    print(t.nsmallest(8, "w_checked")[["name", "w_checked", "w_survival", "w_win"]].round(3).to_string(index=False))


if __name__ == "__main__":
    main()
