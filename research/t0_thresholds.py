"""Framework foundation (step 1, extended): official-T0 distribution thresholds.

Full official metric set from player_stats, using the app's own labels (format.js).
pct fields are thresholded directly; count fields become per-game rates (count/round_total
*100). Role-specific skill rates (女巫毒狼/侦探翻狼/预言家验狼/猎人带狼) are role-conditioned
— thresholded among players who actually have that sample (value present & >0), flagged.

These align with the per-zone T0 values the app fetches live, so a player's value drops
straight into a band. Run from research/:  python t0_thresholds.py
Writes: research/output/t0_thresholds.csv
"""
import json
import os

import pandas as pd

from db import engine

# 单一事实源：官方 T0 指标定义与 min_rounds 与规则/文案同放 framework_rules.json，
# Python 研究台与 Go 产品共读（解耦：改定义不散落两处）。
_RULES = json.load(open(os.path.join(os.path.dirname(__file__), "..", "internal", "analysis",
                                     "framework_rules.json"), encoding="utf-8"))
MIN_ROUNDS = _RULES["min_rounds"]
# source, key, label, kind: pct=direct value / rate=count/round_total*100 / raw=as-is; role_cond flag
METRICS = [tuple(m) for m in _RULES["t0_metric_defs"]]


def main():
    eng = engine()
    stats = pd.read_sql("SELECT summary_json, haoren_json, langren_json FROM player_stats", eng)
    parsed = {c: [json.loads(x) if x else {} for x in stats[c]] for c in
              ("summary_json", "haoren_json", "langren_json")}

    out = []
    for src, key, label, kind, role_cond in METRICS:
        vals = []
        for d in parsed[src]:
            if not d or (d.get("round_total") or 0) < MIN_ROUNDS:
                continue
            v = d.get(key)
            if v is None:
                continue
            if kind == "rate":
                rt = d.get("round_total") or 0
                if rt == 0:
                    continue
                v = 100.0 * float(v) / rt
            else:
                v = float(v)
            if role_cond and v <= 0:   # only players who actually have that role sample
                continue
            vals.append(v)
        s = pd.Series(vals)
        if len(s) < 30:
            continue
        out.append({
            "metric": label, "kind": kind, "role_conditioned": role_cond, "n": len(s),
            "p10": round(s.quantile(.10), 2), "p30": round(s.quantile(.30), 2),
            "median": round(s.quantile(.50), 2), "p70": round(s.quantile(.70), 2),
            "p90": round(s.quantile(.90), 2),
        })
    res = pd.DataFrame(out)
    os.makedirs("output", exist_ok=True)
    res.to_csv("output/t0_thresholds.csv", index=False, encoding="utf-8-sig")
    print("官方 T0 指标分布阈值（很低<p10 / 偏低<p30 / 中等 / 偏高>p70 / 很高>p90）:\n")
    print(res.to_string(index=False))
    print(f"\n共 {len(res)} 个指标。rate=次数/场次×100；role_conditioned=只在有该身份样本的选手中取分布。")
    print("Wrote output/t0_thresholds.csv")


if __name__ == "__main__":
    main()
