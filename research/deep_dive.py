"""Phase 3e: deeper mining — data-driven archetypes + win drivers.

(1) Cluster players on their standardized both-camp metric vector to discover natural
    player types, then describe each by its most distinctive metrics.
(2) Rank which traits most associate with winning, separately for good and wolf.

Run from research/:  python deep_dive.py
"""
import numpy as np
import pandas as pd
from sklearn.cluster import KMeans
from sklearn.preprocessing import StandardScaler

from db import engine
from features import FEATURE_LABEL, build_player_table

FEATURES = ["g_findwolf", "g_survival", "g_win", "g_mvp", "g_badge", "g_checked",
            "w_survival", "w_win", "w_mvp", "w_hantiao", "w_selfd", "w_checked"]


def main():
    eng = engine()
    tbl = build_player_table(eng).dropna(subset=FEATURES)
    print(f"Players (>=30 both camps, complete): {len(tbl):,}\n")

    X = StandardScaler().fit_transform(tbl[FEATURES])
    z = pd.DataFrame(X, columns=FEATURES, index=tbl.index)

    # (1) Archetype clustering.
    k = 5
    tbl["cluster"] = KMeans(n_clusters=k, n_init=10, random_state=0).fit_predict(X)
    print(f"== 数据驱动 archetype（k={k}）==")
    for c in range(k):
        idx = tbl.cluster == c
        zc = z[idx.values].mean().sort_values()
        lows = [f"{FEATURE_LABEL[m]}低" for m in zc.index[:3] if zc[m] < -0.4]
        highs = [f"{FEATURE_LABEL[m]}高" for m in zc.index[::-1][:3] if zc[m] > 0.4]
        egs = "、".join(tbl[idx].nlargest(3, "g_games").name.tolist())
        print(f"\n  类{c}  n={idx.sum()}  特征: {'，'.join(highs) or '—'}"
              f"{' / ' + '，'.join(lows) if lows else ''}")
        print(f"        代表: {egs}")

    # (2) Win drivers: correlation of each trait with win rate, per camp.
    print("\n== 胜利驱动因子（与胜率的相关性，越高越带来胜利）==")
    good_feats = ["g_findwolf", "g_survival", "g_mvp", "g_badge", "g_checked"]
    wolf_feats = ["w_survival", "w_mvp", "w_hantiao", "w_selfd", "w_checked"]
    print("  好人：")
    for f in sorted(good_feats, key=lambda f: -tbl[f].corr(tbl.g_win)):
        print(f"    {FEATURE_LABEL[f]:<8} r(→好胜率) = {tbl[f].corr(tbl.g_win):+.3f}")
    print("  狼人：")
    for f in sorted(wolf_feats, key=lambda f: -tbl[f].corr(tbl.w_win)):
        print(f"    {FEATURE_LABEL[f]:<8} r(→狼胜率) = {tbl[f].corr(tbl.w_win):+.3f}")


if __name__ == "__main__":
    main()
