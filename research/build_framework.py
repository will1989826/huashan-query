"""Step 2: build the shippable interpretation framework (framework.json).

Combines official-T0 thresholds (reusing t0_thresholds.METRICS) with the validated
联动 rules (encoded on official T0 metrics) and band/confidence labels. This JSON is
what the app would embed: feed a player's per-zone T0 metrics -> bands + fired rules.

Run from research/:  python build_framework.py   ->  output/framework.json
"""
import json
import os

import pandas as pd

from db import engine
from t0_thresholds import METRICS, MIN_ROUNDS

BANDS = ["很低", "偏低", "中等", "偏高", "很高"]        # <p10 / <p30 / <=p70 / <p90 / >=p90
CONF = {"clue_only": "样本极少", "low": "样本较少", "medium": "样本适中", "higher": "样本充足"}

# 联动规则（建在官方 T0 指标上；band 用中文档位名）。cross=需要好人和狼人两组样本。
RULES = [
    {"id": "good_trusted_weak", "camp": "good", "tag": "好人缘好但找不到狼：被队友信任、自己判断偏弱",
     "when": [("好人·投狼率", ["很低", "偏低"]), ("好人·存活率", ["偏高", "很高"])]},
    {"id": "good_pushpit", "camp": "good", "tag": "抗推位：判断常对却被投出（发言取信偏弱）",
     "when": [("好人·投狼率", ["偏高", "很高"]), ("好人·存活率", ["很低", "偏低"])]},
    {"id": "good_strong", "camp": "good", "tag": "强好人：会找狼又能活",
     "when": [("好人·投狼率", ["偏高", "很高"]), ("好人·存活率", ["偏高", "很高"])]},
    {"id": "good_mainline", "camp": "good", "tag": "紧跟主线、认真预言家能力强",
     "when": [("好人·站对边率", ["很高"])]},
    {"id": "wolf_discard", "camp": "wolf", "tag": "战术弃子/早退型狼（自刀偏多）",
     "when": [("狼人·自刀率", ["很高"])]},
    {"id": "wolf_hardbowl", "camp": "wolf", "tag": "悍跳硬碗：暴露立场仍顶得住",
     "when": [("狼人·悍跳成功率", ["偏高", "很高"]), ("狼人·存活率", ["偏高", "很高"])]},
    {"id": "hunlang_incons", "camp": "cross", "tag": "人狼不统一：拿好人能活、拿狼易死（偏‘只会当好人’）",
     "when": [("好人·存活率", ["偏高", "很高"]), ("狼人·存活率", ["很低", "偏低"])]},
    {"id": "wolf_carried", "camp": "cross", "tag": "拿狼被带赢：自己早死但队伍赢",
     "when": [("狼人·胜率", ["偏高", "很高"]), ("狼人·存活率", ["很低", "偏低"])]},
]


def camp_of(src):
    return {"summary_json": "comprehensive", "haoren_json": "good", "langren_json": "wolf"}[src]


def main():
    eng = engine()
    stats = pd.read_sql("SELECT summary_json, haoren_json, langren_json FROM player_stats", eng)
    parsed = {c: [json.loads(x) if x else {} for x in stats[c]] for c in
              ("summary_json", "haoren_json", "langren_json")}

    metrics = []
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
        metrics.append({
            "label": label, "source": src, "key": key, "kind": kind, "camp": camp_of(src),
            "role_conditioned": role_cond, "n": len(s),
            "p10": round(s.quantile(.10), 3), "p30": round(s.quantile(.30), 3),
            "p70": round(s.quantile(.70), 3), "p90": round(s.quantile(.90), 3),
        })

    framework = {
        "version": "framework-t0-v1",
        "min_rounds": MIN_ROUNDS,
        "bands": BANDS,
        "confidence": CONF,
        "metrics": metrics,
        "rules": [{"id": r["id"], "camp": r["camp"], "tag": r["tag"],
                   "when": [{"metric": m, "band_in": b} for m, b in r["when"]]} for r in RULES],
    }
    os.makedirs("output", exist_ok=True)
    with open("output/framework.json", "w", encoding="utf-8") as f:
        json.dump(framework, f, ensure_ascii=False, indent=2)
    print(f"framework.json: {len(metrics)} 指标, {len(RULES)} 联动规则")
    print("Wrote output/framework.json")


if __name__ == "__main__":
    main()
