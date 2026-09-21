"""Framework foundation: official-T0 distribution thresholds (what value = what level).

Built from player_stats (T0 官方聚合). These thresholds align with the per-zone T0
metrics the app already fetches live on the detail page, so a player's live value can
be dropped straight into the band. T2 self-computed metrics stay in the deep layer.

Run from research/:  python t0_thresholds.py
Writes: research/output/t0_thresholds.csv
"""
import json
import os

import numpy as np
import pandas as pd

from db import engine

# official key -> (readable, camp). pct fields are 0-100 as returned by the API.
GOOD = {"win_pct": "好·胜率", "cunhuo_pct": "好·存活率", "toulang_pct": "好·投狼率",
        "zhanbian_pct": "好·站对边率"}
WOLF = {"win_pct": "狼·胜率", "cunhuo_pct": "狼·存活率", "hantiao_pct": "狼·悍跳率",
        "molang_pct": "狼·摸狼率"}
MIN_ROUNDS = 30


def rows_for(stats, camp_json, mapping, camp):
    out = []
    for _, r in stats.iterrows():
        try:
            d = json.loads(r[camp_json]) if r[camp_json] else {}
        except Exception:
            continue
        if not d or (d.get("round_total") or 0) < MIN_ROUNDS:
            continue
        for k, name in mapping.items():
            v = d.get(k)
            if v is None:
                continue
            out.append((name, camp, float(v)))
    return out


def main():
    eng = engine()
    stats = pd.read_sql("SELECT haoren_json, langren_json FROM player_stats", eng)
    recs = rows_for(stats, "haoren_json", GOOD, "good") + rows_for(stats, "langren_json", WOLF, "wolf")
    df = pd.DataFrame(recs, columns=["metric", "camp", "value"])

    out = []
    for (metric, camp), g in df.groupby(["metric", "camp"]):
        v = g.value
        out.append({
            "metric": metric, "camp": camp, "n": len(v),
            "p10": round(v.quantile(.10), 2), "p30": round(v.quantile(.30), 2),
            "median": round(v.quantile(.50), 2),
            "p70": round(v.quantile(.70), 2), "p90": round(v.quantile(.90), 2),
        })
    res = pd.DataFrame(out)
    os.makedirs("output", exist_ok=True)
    res.to_csv("output/t0_thresholds.csv", index=False, encoding="utf-8-sig")
    print("官方 T0 指标分布阈值（很低<p10 / 偏低<p30 / 中等 / 偏高>p70 / 很高>p90）:\n")
    print(res.to_string(index=False))
    print(f"\n（n = 该指标有效样本选手数，round_total>= {MIN_ROUNDS}）")
    print("Wrote output/t0_thresholds.csv")


if __name__ == "__main__":
    main()
