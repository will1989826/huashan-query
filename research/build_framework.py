"""Step 2: build the shippable interpretation framework (framework.json).

Official-T0 + self-computed-T2 thresholds stored as DECILES (p10..p90, 每10%一档) so
the app can show a player's 同侪百分位排名 instead of a coarse 高/低 word. Plus the
联动 rules (grouped; 跨阵营 rules are the headline) that turn raw metrics into meaning.

Run from research/:  python build_framework.py   ->  output/framework.json
"""
import json
import os

import pandas as pd

from db import engine
from t0_thresholds import METRICS, MIN_ROUNDS

DECILES = [10, 20, 30, 40, 50, 60, 70, 80, 90]

def _load_rules():
    """规则/文案的单一事实源，Python 研究台与 Go 产品共读同一份 JSON（解耦：改文案不动阈值/不重建库）。"""
    path = os.path.join(os.path.dirname(__file__), "..", "internal", "analysis", "framework_rules.json")
    with open(path, encoding="utf-8") as f:
        r = json.load(f)
    return r["confidence"], r["t2_labels"], r["t0_rules"], r["t2_rules"]
CONF, T2_LABEL, RULES, T2_RULES = _load_rules()  # 单一事实源：见 internal/analysis/framework_rules.json



def camp_of(src):
    return {"summary_json": "comprehensive", "haoren_json": "good", "langren_json": "wolf"}[src]


def deciles(s):
    return {f"p{k}": round(float(s.quantile(k / 100)), 4) for k in DECILES}


def main():
    eng = engine()
    stats = pd.read_sql("SELECT summary_json, haoren_json, langren_json FROM player_stats", eng)
    parsed = {c: [json.loads(x) if x else {} for x in stats[c]] for c in
              ("summary_json", "haoren_json", "langren_json")}

    t0_metrics = []
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
            if role_cond and v <= 0:
                continue
            vals.append(v)
        s = pd.Series(vals)
        if len(s) < 30:
            continue
        m = {"label": label, "source": src, "key": key, "kind": kind, "camp": camp_of(src),
             "role_conditioned": role_cond, "n": len(s)}
        m.update(deciles(s))
        t0_metrics.append(m)

    # T2 自算：从 analysis_metric_values 直接算 deciles（eligible，smoothed_value），多范围。
    # 同时带出 baseline_value（同 cohort 内一致），供 live 端小样本收缩用同一基线。
    mv = pd.read_sql(
        "SELECT metric_key, camp, period_type, period_key, smoothed_value, baseline_value "
        "FROM analysis_metric_values WHERE eligible=1 AND smoothed_value IS NOT NULL", eng)
    t2_metrics = []
    for (mk, camp, pt, pk), g in mv.groupby(["metric_key", "camp", "period_type", "period_key"]):
        if len(g) < 30:
            continue
        m = {"label": T2_LABEL.get(mk, mk), "metric_key": mk, "camp": camp,
             "period_type": pt, "period_key": pk, "n": len(g),
             "baseline": round(float(g.baseline_value.iloc[0]), 4)}
        m.update(deciles(g.smoothed_value.astype(float)))
        t2_metrics.append(m)

    framework = {
        "version": "framework-t0t2-v2",
        "min_rounds": MIN_ROUNDS, "deciles": DECILES, "confidence": CONF,
        "prior_weight": 20.0, "min_denominator": 10,
        "scope_note": "官方T0可按赛区/赛季；自算T2可按赛区/自然年/最近N场。",
        "t0_metrics": t0_metrics,
        "t0_rules": [{"id": r["id"], "group": r["group"], "tag": r["tag"],
                      "when": [{"metric": m, "band_in": b} for m, b in r["when"]]} for r in RULES],
        "t2_metrics": t2_metrics,
        "t2_rules": [{"id": r["id"], "group": r["group"], "tag": r["tag"],
                      "when": [{"metric_key": mk, "camp": c, "band_in": b} for mk, c, b in r["when"]]}
                     for r in T2_RULES],
    }
    os.makedirs("output", exist_ok=True)
    with open("output/framework.json", "w", encoding="utf-8") as f:
        json.dump(framework, f, ensure_ascii=False, indent=2)
    ncross = sum(1 for r in RULES if r["group"] == "跨阵营") + sum(1 for r in T2_RULES if "跨阵营" in r["group"])
    print(f"framework.json: T0 {len(t0_metrics)}指标 + {len(RULES)}规则; T2 {len(t2_metrics)}阈值行 + {len(T2_RULES)}规则; 跨阵营规则 {ncross}")
    print("Wrote output/framework.json")


if __name__ == "__main__":
    main()
