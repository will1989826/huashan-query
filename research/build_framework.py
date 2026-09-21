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
CONF = {"clue_only": "样本极少", "low": "样本较少", "medium": "样本适中", "higher": "样本充足"}

T2_LABEL = {
    "win_rate": "自算·胜率", "mvp_rate": "自算·MVP率", "survival_rate": "自算·存活率",
    "good_vote_hit_rate": "自算·白天投票找狼率", "badge_vote_hit_rate": "自算·警徽票找狼率",
    "findwolf_rate": "自算·综合找狼命中率", "badge_carry_rate": "自算·警长当选率",
    "wolf_hook_rate": "自算·倒钩占比", "hantiao_rate": "自算·悍跳率",
    "hantiao_badge_rate": "自算·悍跳得警徽率", "exposed_survival_rate": "自算·暴露后存活率",
    "self_destruct_rate": "自算·自爆率",
    "charge_survival_rate": "自算·冲锋后存活率", "hook_survival_rate": "自算·倒钩后存活率",
    "d3_survival_rate": "自算·D3+存活率", "won_findwolf_rate": "自算·胜局找狼率",
    "lost_findwolf_rate": "自算·败局找狼率", "seer_checked_rate": "自算·被验率",
}

# 联动规则。group: 跨阵营 / 好人面 / 狼人面 / 总体。band_in 用 5 档词（很低/偏低/中等/偏高/很高）。
RULES = [
    # ===== 跨阵营（最重要，放最前）=====
    {"id": "x_only_good", "group": "跨阵营", "tag": "人狼不统一：拿好人能活、拿狼易死（只会当好人）",
     "when": [("好人·存活率", ["偏高", "很高"]), ("狼人·存活率", ["很低", "偏低"])]},
    {"id": "x_wolf_better", "group": "跨阵营", "tag": "拿狼比拿好人强（好人存活低、拿狼存活高）",
     "when": [("好人·存活率", ["很低", "偏低"]), ("狼人·存活率", ["偏高", "很高"])]},
    {"id": "x_good_spec", "group": "跨阵营", "tag": "偏科好人：拿好人赢、拿狼吃力",
     "when": [("好人·胜率", ["偏高", "很高"]), ("狼人·胜率", ["很低", "偏低"])]},
    {"id": "x_wolf_spec", "group": "跨阵营", "tag": "偏科狼人：拿狼赢、拿好人吃力",
     "when": [("好人·胜率", ["很低", "偏低"]), ("狼人·胜率", ["偏高", "很高"])]},
    {"id": "x_allround", "group": "跨阵营", "tag": "全能：两阵营都赢",
     "when": [("好人·胜率", ["偏高", "很高"]), ("狼人·胜率", ["偏高", "很高"])]},
    {"id": "x_both_struggle", "group": "跨阵营", "tag": "两阵营都吃力",
     "when": [("好人·胜率", ["很低", "偏低"]), ("狼人·胜率", ["很低", "偏低"])]},
    {"id": "x_speech_both", "group": "跨阵营", "tag": "两面发言/取信都强（好人站对边稳、拿狼悍跳能成）",
     "when": [("好人·站对边率", ["偏高", "很高"]), ("狼人·悍跳成功率", ["偏高", "很高"])]},
    {"id": "x_face_wolf", "group": "跨阵营", "tag": "好人相→拿狼借信用赢（好人靠人缘活、拿狼胜率高）",
     "when": [("好人·存活率", ["偏高", "很高"]), ("好人·投狼率", ["很低", "偏低"]), ("狼人·胜率", ["偏高", "很高"])]},
    {"id": "x_read_both", "group": "跨阵营", "tag": "读牌跨阵营：找狼准、抿神也准",
     "when": [("好人·投狼率", ["偏高", "很高"]), ("狼人·刀神率", ["偏高", "很高"])]},
    {"id": "x_star", "group": "跨阵营", "tag": "两阵营都高光（MVP 双高）",
     "when": [("好人·MVP率", ["偏高", "很高"]), ("狼人·MVP率", ["偏高", "很高"])]},
    {"id": "x_both_strong", "group": "跨阵营", "tag": "两面都强：好人主线稳、拿狼也能扛",
     "when": [("好人·站对边率", ["偏高", "很高"]), ("狼人·存活率", ["偏高", "很高"])]},
    # ===== 好人面 =====
    {"id": "g_dual_stable", "group": "好人面", "tag": "判断与主线双稳：核心好人",
     "when": [("好人·投狼率", ["偏高", "很高"]), ("好人·站对边率", ["偏高", "很高"])]},
    {"id": "g_point_not_line", "group": "好人面", "tag": "能抓具体狼但主线偏跟错（看首站/改票）",
     "when": [("好人·投狼率", ["偏高", "很高"]), ("好人·站对边率", ["很低", "偏低"])]},
    {"id": "g_line_not_point", "group": "好人面", "tag": "紧跟主线、独立找狼偏弱（跟随型）",
     "when": [("好人·投狼率", ["很低", "偏低"]), ("好人·站对边率", ["偏高", "很高"])]},
    {"id": "g_both_weak", "group": "好人面", "tag": "判断与主线都偏弱",
     "when": [("好人·投狼率", ["很低", "偏低"]), ("好人·站对边率", ["很低", "偏低"])]},
    {"id": "g_right_not_trusted", "group": "好人面", "tag": "站对边却存活低：判断对但取信/发言吃亏（抗推位）",
     "when": [("好人·站对边率", ["偏高", "很高"]), ("好人·存活率", ["很低", "偏低"])]},
    {"id": "g_personal_bonus", "group": "好人面", "tag": "个人附加分能力强（场均高、胜率一般）",
     "when": [("综合·场均分", ["偏高", "很高"]), ("综合·胜率", ["中等", "偏低", "很低"])]},
    {"id": "g_team_cashin", "group": "好人面", "tag": "团队兑现型（胜率高但场均偏低=靠队友）",
     "when": [("综合·胜率", ["偏高", "很高"]), ("综合·场均分", ["很低", "偏低"])]},
    {"id": "g_upwind_value", "group": "好人面", "tag": "逆风/败局贡献强（尽力率高）",
     "when": [("综合·尽力率", ["偏高", "很高"])]},
    # ===== 狼人面 =====
    {"id": "w_hardbowl", "group": "狼人面", "tag": "悍跳硬碗：顶得住暴露",
     "when": [("狼人·悍跳成功率", ["偏高", "很高"]), ("狼人·存活率", ["偏高", "很高"])]},
    {"id": "w_knifegod", "group": "狼人面", "tag": "狼队抿神准（刀神率高，归团队）",
     "when": [("狼人·刀神率", ["偏高", "很高"])]},
    {"id": "w_selfknife", "group": "狼人面", "tag": "自刀工具用得多（战术弃子倾向）",
     "when": [("狼人·自刀率", ["很高"])]},
    {"id": "w_frontload", "group": "狼人面", "tag": "前置工作/牺牲位或被带赢（胜率高但存活低）",
     "when": [("狼人·胜率", ["偏高", "很高"]), ("狼人·存活率", ["很低", "偏低"])]},
    {"id": "w_deepwater", "group": "狼人面", "tag": "后置经营好狼位（存活+胜率双高）",
     "when": [("狼人·存活率", ["偏高", "很高"]), ("狼人·胜率", ["偏高", "很高"])]},
]

# T2 自算联动（metric_key, camp, 5档 band）。
T2_RULES = [
    {"id": "t2_incons", "group": "跨阵营·自算", "tag": "人狼不统一：拿好人能活、拿狼易死（自算）",
     "when": [("survival_rate", "good", ["偏高", "很高"]), ("survival_rate", "wolf", ["很低", "偏低"])]},
    {"id": "t2_wolf_better", "group": "跨阵营·自算", "tag": "拿狼比拿好人强（自算）",
     "when": [("survival_rate", "good", ["很低", "偏低"]), ("survival_rate", "wolf", ["偏高", "很高"])]},
    {"id": "t2_pushpit", "group": "好人面·自算", "tag": "抗推位：判断常对却被投出（自算）",
     "when": [("findwolf_rate", "good", ["偏高", "很高"]), ("survival_rate", "good", ["很低", "偏低"])]},
    {"id": "t2_trusted_weak", "group": "好人面·自算", "tag": "好人缘好但找不到狼（自算）",
     "when": [("findwolf_rate", "good", ["很低", "偏低"]), ("survival_rate", "good", ["偏高", "很高"])]},
    {"id": "t2_strong_good", "group": "好人面·自算", "tag": "强好人：会找狼又能活（自算）",
     "when": [("findwolf_rate", "good", ["偏高", "很高"]), ("survival_rate", "good", ["偏高", "很高"])]},
    {"id": "t2_carried", "group": "狼人面·自算", "tag": "拿狼被带赢：自己早死但队伍赢（自算）",
     "when": [("win_rate", "wolf", ["偏高", "很高"]), ("survival_rate", "wolf", ["很低", "偏低"])]},
    {"id": "t2_exposed_hardbowl", "group": "狼人面·自算", "tag": "悍跳硬碗：暴露后仍能存活（自算）",
     "when": [("exposed_survival_rate", "wolf", ["偏高", "很高"])]},
    {"id": "t2_lurker", "group": "狼人面·自算", "tag": "潜伏倒钩型（倒钩占比高）",
     "when": [("wolf_hook_rate", "wolf", ["偏高", "很高"])]},
    {"id": "t2_aggressive", "group": "狼人面·自算", "tag": "激进冲锋型（倒钩占比低=多冲锋）",
     "when": [("wolf_hook_rate", "wolf", ["很低", "偏低"])]},
    {"id": "t2_badge_climber", "group": "狼人面·自算", "tag": "悍跳常拿警徽（上位控场强）",
     "when": [("hantiao_badge_rate", "wolf", ["偏高", "很高"])]},
    {"id": "t2_charge_survive", "group": "狼人面·自算", "tag": "冲锋后仍能活：暴露立场也能洗清=发言好",
     "when": [("charge_survival_rate", "wolf", ["偏高", "很高"])]},
    {"id": "t2_hook_survive", "group": "狼人面·自算", "tag": "倒钩取信成功：投队友后活得久",
     "when": [("hook_survival_rate", "wolf", ["偏高", "很高"])]},
    {"id": "t2_hook_die", "group": "狼人面·自算", "tag": "倒钩被清：投对了也没留住=取信失败",
     "when": [("hook_survival_rate", "wolf", ["很低", "偏低"])]},
    {"id": "t2_upwind_carry", "group": "好人面·自算", "tag": "逆风carry：败局仍能找到狼（个人到位、队友没兜住）",
     "when": [("lost_findwolf_rate", "good", ["偏高", "很高"])]},
    {"id": "t2_passenger", "group": "好人面·自算", "tag": "顺风躺赢：赢的局自己也没怎么找狼",
     "when": [("won_findwolf_rate", "good", ["很低", "偏低"])]},
    {"id": "t2_wolfface", "group": "狼人面·自算", "tag": "狼相重：拿狼常被预言家查杀",
     "when": [("seer_checked_rate", "wolf", ["偏高", "很高"])]},
    {"id": "t2_goodface", "group": "好人面·自算", "tag": "存在感/好人相：常被预言家验（金水）",
     "when": [("seer_checked_rate", "good", ["偏高", "很高"])]},
    {"id": "t2_endgame", "group": "好人面·自算", "tag": "残局生存力强（D3+ 存活高）",
     "when": [("d3_survival_rate", "good", ["偏高", "很高"])]},
]


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
    mv = pd.read_sql(
        "SELECT metric_key, camp, period_type, period_key, smoothed_value FROM analysis_metric_values "
        "WHERE eligible=1 AND smoothed_value IS NOT NULL", eng)
    t2_metrics = []
    for (mk, camp, pt, pk), g in mv.groupby(["metric_key", "camp", "period_type", "period_key"]):
        if len(g) < 30:
            continue
        m = {"label": T2_LABEL.get(mk, mk), "metric_key": mk, "camp": camp,
             "period_type": pt, "period_key": pk, "n": len(g)}
        m.update(deciles(g.smoothed_value.astype(float)))
        t2_metrics.append(m)

    framework = {
        "version": "framework-t0t2-v2",
        "min_rounds": MIN_ROUNDS, "deciles": DECILES, "confidence": CONF,
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
