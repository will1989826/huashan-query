"""#5 PCA: how many independent 画像 axes underlie the 12 metrics, and what they are."""
import numpy as np
import pandas as pd
from sklearn.decomposition import PCA
from sklearn.preprocessing import StandardScaler

from db import engine
from features import FEATURE_LABEL, build_player_table

FEATURES = ["g_findwolf", "g_survival", "g_win", "g_mvp", "g_badge", "g_checked",
            "w_survival", "w_win", "w_mvp", "w_hantiao", "w_selfd", "w_checked"]


def main():
    eng = engine()
    t = build_player_table(eng).dropna(subset=FEATURES)
    X = StandardScaler().fit_transform(t[FEATURES])
    p = PCA().fit(X)
    ev = p.explained_variance_ratio_
    cum = np.cumsum(ev)
    print(f"players: {len(t)}")
    print("各主成分解释方差:", " ".join(f"{v:.0%}" for v in ev[:8]))
    print("累计:", " ".join(f"{v:.0%}" for v in cum[:8]))
    n80 = int(np.argmax(cum >= 0.80)) + 1
    print(f"覆盖 80% 信息需要 {n80} 个独立轴（共 {len(FEATURES)} 指标）\n")
    for i in range(4):
        load = pd.Series(p.components_[i], index=FEATURES).sort_values()
        top = [f"{FEATURE_LABEL[m]}{'+' if load[m] > 0 else '−'}" for m in list(load.index[::-1][:3]) + list(load.index[:2])]
        print(f"PC{i+1}（{ev[i]:.0%}）主要由: {'  '.join(top)}")


if __name__ == "__main__":
    main()
