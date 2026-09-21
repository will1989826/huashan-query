"""Step 3: applier — 联动为主 + 同侪百分位排名。

联动画像打头（跨阵营优先），关键指标只列偏离中等的、并用「同侪前 X~Y%」表达
排名（每 10% 一档）而非高/低词。T0 官方层 + T2 自算层多范围（生涯/最近50/最近20/
自然年）同级。live app parity：T0<-per-zone stats API；T2<-per-zone 逐场重建。

Run from research/:  python applier.py [名字或ID]
"""
import json
import sys

import pandas as pd

from db import engine

GROUP_ORDER = ["跨阵营", "跨阵营·自算", "好人面", "好人面·自算", "狼人面", "狼人面·自算", "总体"]


def band5(v, t):
    """5-档（供规则/筛选用）。"""
    if v < t["p10"]:
        return "很低"
    if v < t["p30"]:
        return "偏低"
    if v <= t["p70"]:
        return "中等"
    if v < t["p90"]:
        return "偏高"
    return "很高"


def rank_label(v, t, deciles):
    """同侪百分位排名，每 10% 一档：上位用「前X%」，下位用「后X%」（按数值）。"""
    b = sum(1 for k in deciles if v >= t[f"p{k}"])   # 0..len(deciles)
    if b >= 5:                                        # 上位（数值偏高）
        lo, hi = 100 - (b + 1) * 10, 100 - b * 10
        return "前10%" if lo <= 0 else f"前{lo}~{hi}%"
    lo, hi = b * 10, (b + 1) * 10                     # 下位（数值偏低）
    return "后10%" if lo <= 0 else f"后{lo}~{hi}%"


def t0_value(stats, m):
    d = stats.get(m["source"]) or {}
    rt = d.get("round_total") or 0
    v = d.get(m["key"])
    if not d or rt < 1 or v is None:
        return None
    v = 100.0 * float(v) / rt if m["kind"] == "rate" else float(v)
    if m.get("role_conditioned") and v <= 0:
        return None
    return round(v, 2)


def resolve(eng, arg):
    arg = arg.strip()
    if arg.isdigit():
        return int(arg)
    m = pd.read_sql("SELECT player_id, player_name FROM player_stats WHERE player_name LIKE %(n)s",
                    eng, params={"n": f"%{arg}%"})
    if m.empty:
        print(f"没找到选手『{arg}』，换个名字或用 ID 试试。"); return None
    exact = m[m.player_name == arg]
    if len(exact) == 1:
        return int(exact.iloc[0].player_id)
    if len(m) == 1:
        return int(m.iloc[0].player_id)
    print(f"『{arg}』匹配到多个选手，请用 ID 或更精确的名字："); print(m.head(15).to_string(index=False))
    return None


def main():
    fw = json.load(open("output/framework.json", encoding="utf-8"))
    dec = fw["deciles"]
    eng = engine()
    pid = resolve(eng, sys.argv[1] if len(sys.argv) > 1 else "林杰")
    if pid is None:
        return
    row = pd.read_sql("SELECT player_name, summary_json, haoren_json, langren_json "
                      "FROM player_stats WHERE player_id=%(p)s", eng, params={"p": pid})
    name = row.iloc[0].player_name if not row.empty else str(pid)
    stats = {s: (json.loads(row.iloc[0][s]) if not row.empty and row.iloc[0][s] else {})
             for s in ("summary_json", "haoren_json", "langren_json")}

    # T0 bands + notable(非中等，显示排名)
    campname = {"comprehensive": "综合", "good": "好人", "wolf": "狼人"}
    t0_bands, t0_notable = {}, {"综合": [], "好人": [], "狼人": []}
    for m in fw["t0_metrics"]:
        v = t0_value(stats, m)
        if v is None:
            continue
        t0_bands[m["label"]] = band5(v, m)
        if band5(v, m) != "中等":
            t0_notable[campname[m["camp"]]].append(f"{m['label'].split('·')[1]} {v}（{rank_label(v, m, dec)}）")
    fired = [(r["group"], r["tag"]) for r in fw["t0_rules"]
             if all(t0_bands.get(c["metric"]) in c["band_in"] for c in r["when"])]

    # T2 多范围
    mv = pd.read_sql("SELECT metric_key,camp,period_type,period_key,raw_value,smoothed_value,eligible "
                     "FROM analysis_metric_values WHERE player_id=%(p)s", eng, params={"p": pid})
    thr = {(t["metric_key"], t["camp"], t["period_type"], t["period_key"]): t for t in fw["t2_metrics"]}
    labels = {t["metric_key"]: t["label"] for t in fw["t2_metrics"]}
    cbands = {}
    for _, r in mv[(mv.period_type == "career") & (mv.period_key == "all")].iterrows():
        t = thr.get((r.metric_key, r.camp, "career", "all"))
        if t is not None and r.smoothed_value is not None and r.eligible:
            cbands[(r.metric_key, r.camp)] = band5(float(r.smoothed_value), t)
    fired += [(r["group"], r["tag"]) for r in fw["t2_rules"]
              if all(cbands.get((c["metric_key"], c["camp"])) in c["band_in"] for c in r["when"])]

    scopes = [("career", "all", "生涯"), ("recent", "50", "最近50"), ("recent", "20", "最近20")]
    years = sorted({r.period_key for _, r in mv.iterrows() if r.period_type == "year"}, reverse=True)
    if years:
        scopes.append(("year", years[0], years[0] + "年"))
    HEAD = [("good", "findwolf_rate"), ("good", "zhanbian_rate"), ("good", "badge_seer_hit_rate"),
            ("good", "seer_duel_win_rate"), ("good", "survival_rate"), ("good", "god_survival_rate"),
            ("good", "badge_vote_rate"),
            ("wolf", "survival_rate"), ("wolf", "win_rate"), ("wolf", "hantiao_duel_win_rate"),
            ("wolf", "exposed_survival_rate"), ("wolf", "charge_survival_rate"), ("wolf", "hook_survival_rate")]
    ms = []
    for camp, mk in HEAD:
        cells = []
        for pt, pk, sl in scopes:
            r = mv[(mv.metric_key == mk) & (mv.camp == camp) & (mv.period_type == pt) & (mv.period_key == pk)]
            t = thr.get((mk, camp, pt, pk))
            if r.empty or t is None or r.iloc[0].smoothed_value is None or not r.iloc[0].eligible:
                cells.append(f"{sl}:—")
            else:
                rr = r.iloc[0]
                cells.append(f"{sl}:{round(float(rr.raw_value)*100,1)}%({rank_label(float(rr.smoothed_value), t, dec)})")
        ms.append(f"{labels.get(mk, mk)}[{'好' if camp=='good' else '狼'}]  " + "  ".join(cells))

    # ---- 输出：联动为主 ----
    print(f"选手画像 · {name}（ID {pid}）\n")
    print("◆ 联动画像（重点，跨阵营优先）")
    if fired:
        for grp in GROUP_ORDER:
            tags = [t for g, t in fired if g == grp]
            if tags:
                print(f"  〔{grp}〕")
                for t in tags:
                    print(f"    ▸ {t}")
    else:
        print("  （各项接近中等，无明显联动特征）")

    print("\n· 关键指标（只列偏离中等；同侪排名每10%一档；实时可切赛区/赛季/场次）")
    for title in ("综合", "好人", "狼人"):
        if t0_notable[title]:
            print(f"  【{title}·官方】" + "，".join(t0_notable[title]))
    print("  【自算·多范围】")
    for line in ms:
        print("   " + line)


if __name__ == "__main__":
    main()
