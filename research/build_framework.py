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

# T2 自算指标（Go builder 产出，analysis_label_thresholds）的可读名。
T2_LABEL = {
    "win_rate": "自算·胜率", "mvp_rate": "自算·MVP率", "survival_rate": "自算·存活率",
    "good_vote_hit_rate": "自算·白天投票找狼率", "badge_vote_hit_rate": "自算·警徽票找狼率",
    "findwolf_rate": "自算·综合找狼命中率", "badge_carry_rate": "自算·警长当选率",
    "wolf_hook_rate": "自算·倒钩占比", "hantiao_rate": "自算·悍跳率",
    "hantiao_badge_rate": "自算·悍跳得警徽率", "exposed_survival_rate": "自算·暴露后存活率",
    "self_destruct_rate": "自算·自爆率",
}
# T2 联动规则（建在自算指标上，band 用中文档位）。
T2_RULES = [
    {"id": "t2_trusted_weak", "camp": "good", "tag": "好人缘好但找不到狼（自算）",
     "when": [("findwolf_rate", "good", ["很低", "偏低"]), ("survival_rate", "good", ["偏高", "很高"])]},
    {"id": "t2_pushpit", "camp": "good", "tag": "抗推位：判断常对却被投出（自算）",
     "when": [("findwolf_rate", "good", ["偏高", "很高"]), ("survival_rate", "good", ["很低", "偏低"])]},
    {"id": "t2_strong_good", "camp": "good", "tag": "强好人：会找狼又能活（自算）",
     "when": [("findwolf_rate", "good", ["偏高", "很高"]), ("survival_rate", "good", ["偏高", "很高"])]},
    {"id": "t2_carried", "camp": "wolf", "tag": "拿狼被带赢：自己早死但队伍赢（自算）",
     "when": [("win_rate", "wolf", ["偏高", "很高"]), ("survival_rate", "wolf", ["很低", "偏低"])]},
    {"id": "t2_exposed_hardbowl", "camp": "wolf", "tag": "悍跳硬碗：暴露后仍能存活（自算）",
     "when": [("exposed_survival_rate", "wolf", ["偏高", "很高"])]},
    {"id": "t2_lurker", "camp": "wolf", "tag": "潜伏倒钩型（倒钩占比高）",
     "when": [("wolf_hook_rate", "wolf", ["偏高", "很高"])]},
    {"id": "t2_aggressive", "camp": "wolf", "tag": "激进冲锋型（倒钩占比低=多冲锋）",
     "when": [("wolf_hook_rate", "wolf", ["很低", "偏低"])]},
    {"id": "t2_selfdestruct", "camp": "wolf", "tag": "自爆偏多（战术弃子/早退）",
     "when": [("self_destruct_rate", "wolf", ["很高"])]},
    {"id": "t2_badge_climber", "camp": "wolf", "tag": "悍跳常拿警徽（上位控场强）",
     "when": [("hantiao_badge_rate", "wolf", ["偏高", "很高"])]},
    {"id": "t2_incons", "camp": "cross", "tag": "人狼不统一：拿好人能活、拿狼易死（自算）",
     "when": [("survival_rate", "good", ["偏高", "很高"]), ("survival_rate", "wolf", ["很低", "偏低"])]},
]

# 联动规则（建在官方 T0 指标上；band 用中文档位名）。cross=需要好人和狼人两组样本。
RULES = [
    # 好人：投狼率 × 站对边率（metrics.md 明确 2×2 表）
    {"id": "g_dual_stable", "camp": "good", "tag": "判断与主线双稳：核心好人",
     "when": [("好人·投狼率", ["偏高", "很高"]), ("好人·站对边率", ["偏高", "很高"])]},
    {"id": "g_point_not_line", "camp": "good", "tag": "能抓具体狼但主线偏跟错（看首站/改票）",
     "when": [("好人·投狼率", ["偏高", "很高"]), ("好人·站对边率", ["很低", "偏低"])]},
    {"id": "g_line_not_point", "camp": "good", "tag": "紧跟主线、独立找狼偏弱（跟随型）",
     "when": [("好人·投狼率", ["很低", "偏低"]), ("好人·站对边率", ["偏高", "很高"])]},
    {"id": "g_both_weak", "camp": "good", "tag": "判断与主线都偏弱",
     "when": [("好人·投狼率", ["很低", "偏低"]), ("好人·站对边率", ["很低", "偏低"])]},
    {"id": "g_right_not_trusted", "camp": "good", "tag": "站对边却存活低：判断对但取信/发言吃亏（抗推位）",
     "when": [("好人·站对边率", ["偏高", "很高"]), ("好人·存活率", ["很低", "偏低"])]},
    # 场均分 × 胜率（metrics.md 场均分段落）
    {"id": "g_carry_reward", "camp": "comprehensive", "tag": "顺风兑现强（高场均+高胜率，多来自阵营基础分）",
     "when": [("综合·场均分", ["偏高", "很高"]), ("综合·胜率", ["偏高", "很高"])]},
    {"id": "g_personal_bonus", "camp": "comprehensive", "tag": "个人附加分能力强（场均高、胜率一般）",
     "when": [("综合·场均分", ["偏高", "很高"]), ("综合·胜率", ["中等", "偏低", "很低"])]},
    {"id": "g_team_cashin", "camp": "comprehensive", "tag": "团队兑现型（胜率高但场均偏低=靠队友）",
     "when": [("综合·胜率", ["偏高", "很高"]), ("综合·场均分", ["很低", "偏低"])]},
    {"id": "g_upwind_value", "camp": "comprehensive", "tag": "逆风/败局贡献强（尽力率高）",
     "when": [("综合·尽力率", ["偏高", "很高"])]},
    {"id": "g_flashy_nowin", "camp": "comprehensive", "tag": "个人数据亮眼但赢不下（MVP高、胜率低）",
     "when": [("综合·MVP率", ["偏高", "很高"]), ("综合·胜率", ["很低", "偏低"])]},
    # 狼人（metrics.md / survival.md）
    {"id": "w_hardbowl", "camp": "wolf", "tag": "悍跳硬碗：顶得住暴露",
     "when": [("狼人·悍跳成功率", ["偏高", "很高"]), ("狼人·存活率", ["偏高", "很高"])]},
    {"id": "w_knifegod", "camp": "wolf", "tag": "狼队抿神准（刀神率高，归团队）",
     "when": [("狼人·刀神率", ["偏高", "很高"])]},
    {"id": "w_selfknife", "camp": "wolf", "tag": "自刀工具用得多（战术弃子倾向）",
     "when": [("狼人·自刀率", ["很高"])]},
    {"id": "w_frontload", "camp": "wolf", "tag": "前置工作/牺牲位或被带赢（胜率高但存活低）",
     "when": [("狼人·胜率", ["偏高", "很高"]), ("狼人·存活率", ["很低", "偏低"])]},
    {"id": "w_deepwater", "camp": "wolf", "tag": "后置经营好狼位（存活+胜率双高）",
     "when": [("狼人·存活率", ["偏高", "很高"]), ("狼人·胜率", ["偏高", "很高"])]},
    {"id": "w_weak", "camp": "wolf", "tag": "拿狼偏弱（胜率、存活双低）",
     "when": [("狼人·胜率", ["很低", "偏低"]), ("狼人·存活率", ["很低", "偏低"])]},
    # 跨阵营（人狼一致性）
    {"id": "x_only_good", "camp": "cross", "tag": "人狼不统一：拿好人能活、拿狼易死（只会当好人）",
     "when": [("好人·存活率", ["偏高", "很高"]), ("狼人·存活率", ["很低", "偏低"])]},
    {"id": "x_both_strong", "camp": "cross", "tag": "两面都强：好人主线稳、拿狼也能扛",
     "when": [("好人·站对边率", ["偏高", "很高"]), ("狼人·存活率", ["偏高", "很高"])]},
    {"id": "x_wolf_better", "camp": "cross", "tag": "拿狼比拿好人强（好人存活低、拿狼存活高）",
     "when": [("好人·存活率", ["很低", "偏低"]), ("狼人·存活率", ["偏高", "很高"])]},
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
        "version": "framework-t0t2-v1",
        "min_rounds": MIN_ROUNDS,
        "bands": BANDS,
        "confidence": CONF,
        "scope_note": "官方T0可按赛区/赛季；自算T2可按赛区/自然年/最近N场。最近N场与自然年官方无，显示—。",
        "t0_metrics": metrics,
        "t0_rules": [{"id": r["id"], "camp": r["camp"], "tag": r["tag"],
                      "when": [{"metric": m, "band_in": b} for m, b in r["when"]]} for r in RULES],
    }

    # T2 自算层：多范围阈值（Go builder 产出）。career/all + 自然年 + 最近20/50/100。
    t2 = pd.read_sql(
        "SELECT metric_key, camp, period_type, period_key, p10, p30, p70, p90, cohort_size "
        "FROM analysis_label_thresholds", eng)
    framework["t2_metrics"] = [{
        "label": T2_LABEL.get(r.metric_key, r.metric_key), "metric_key": r.metric_key,
        "camp": r.camp, "period_type": r.period_type, "period_key": r.period_key,
        "p10": float(r.p10), "p30": float(r.p30), "p70": float(r.p70), "p90": float(r.p90),
        "n": int(r.cohort_size),
    } for _, r in t2.iterrows()]
    framework["t2_rules"] = [{"id": r["id"], "camp": r["camp"], "tag": r["tag"],
                              "when": [{"metric_key": mk, "camp": c, "band_in": b}
                                       for mk, c, b in r["when"]]} for r in T2_RULES]

    os.makedirs("output", exist_ok=True)
    with open("output/framework.json", "w", encoding="utf-8") as f:
        json.dump(framework, f, ensure_ascii=False, indent=2)
    print(f"framework.json: T0 {len(metrics)}指标/{len(RULES)}规则; "
          f"T2 {len(framework['t2_metrics'])}阈值行/{len(T2_RULES)}规则")
    print("Wrote output/framework.json")


if __name__ == "__main__":
    main()
