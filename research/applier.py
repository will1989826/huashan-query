"""Step 3 (extended): applier — range × source 画像 matrix.

T0 (official) tier: bands each official metric (career/all here; live app would pass
zone/season). T2 (self-computed) tier: bands our reconstructed metrics across multiple
scopes (career / 最近50 / 最近20 / 自然年) against our offline per-period thresholds.
Both sources shown 同级, each with 档位/置信/同侪数. Fires 联动 rules per tier.

Live app parity: T0 = per-zone/season stats API; T2 = per-zone 逐场 reconstruction.
Here T0 <- player_stats, T2 <- analysis_metric_values (our offline reconstruction).

Run from research/:  python applier.py [player_id]
"""
import json
import sys

import pandas as pd

from db import engine

CONF = {"clue_only": "样本极少", "low": "样本较少", "medium": "样本适中", "higher": "样本充足"}


def band_of(v, t):
    if v < t["p10"]:
        return "很低"
    if v < t["p30"]:
        return "偏低"
    if v <= t["p70"]:
        return "中等"
    if v < t["p90"]:
        return "偏高"
    return "很高"


def confidence(n):
    return CONF["clue_only"] if n < 10 else CONF["low"] if n < 30 else CONF["medium"] if n < 80 else CONF["higher"]


def t0_value(stats, m):
    d = stats.get(m["source"]) or {}
    rt = d.get("round_total") or 0
    v = d.get(m["key"])
    if not d or rt < 1 or v is None:
        return None, 0
    v = 100.0 * float(v) / rt if m["kind"] == "rate" else float(v)
    if m.get("role_conditioned") and v <= 0:
        return None, 0
    return round(v, 2), int(rt)


def resolve(eng, arg):
    """Accept a player id (digits) or a name (substring); return player_id or None."""
    arg = arg.strip()
    if arg.isdigit():
        return int(arg)
    m = pd.read_sql("SELECT player_id, player_name FROM player_stats WHERE player_name LIKE %(n)s",
                    eng, params={"n": f"%{arg}%"})
    if m.empty:
        print(f"没找到选手『{arg}』，换个名字或用 ID 试试。")
        return None
    exact = m[m.player_name == arg]
    if len(exact) == 1:
        return int(exact.iloc[0].player_id)
    if len(m) == 1:
        return int(m.iloc[0].player_id)
    print(f"『{arg}』匹配到多个选手，请用 ID 或更精确的名字：")
    print(m.head(15).to_string(index=False))
    return None


def main():
    fw = json.load(open("output/framework.json", encoding="utf-8"))
    eng = engine()
    arg = sys.argv[1] if len(sys.argv) > 1 else "小红人"
    pid = resolve(eng, arg)
    if pid is None:
        return
    row = pd.read_sql("SELECT player_name, summary_json, haoren_json, langren_json "
                      "FROM player_stats WHERE player_id=%(p)s", eng, params={"p": pid})
    name = row.iloc[0].player_name if not row.empty else str(pid)
    stats = {s: (json.loads(row.iloc[0][s]) if not row.empty and row.iloc[0][s] else {})
             for s in ("summary_json", "haoren_json", "langren_json")}

    # ---- compute T0 bands + notable (非中等) ----
    campname = {"comprehensive": "综合", "good": "好人", "wolf": "狼人"}
    t0_bands = {}
    t0_notable = {"综合": [], "好人": [], "狼人": []}
    for m in fw["t0_metrics"]:
        v, rt = t0_value(stats, m)
        if v is None:
            continue
        b = band_of(v, m)
        t0_bands[m["label"]] = b
        if b != "中等":
            t0_notable[campname[m["camp"]]].append(f"{m['label'].split('·')[1]}{b}")
    fired0 = [r["tag"] for r in fw["t0_rules"]
              if all(t0_bands.get(c["metric"]) in c["band_in"] for c in r["when"])]

    # ---- compute T2 bands (多范围) + fired ----
    mv = pd.read_sql(
        "SELECT metric_key, camp, period_type, period_key, raw_value, smoothed_value, denominator, eligible "
        "FROM analysis_metric_values WHERE player_id=%(p)s", eng, params={"p": pid})
    thr = {(t["metric_key"], t["camp"], t["period_type"], t["period_key"]): t for t in fw["t2_metrics"]}
    labels = {t["metric_key"]: t["label"] for t in fw["t2_metrics"]}

    def band_row(r):
        t = thr.get((r.metric_key, r.camp, r.period_type, r.period_key))
        if t is None or r.smoothed_value is None or not r.eligible:
            return None
        return band_of(float(r.smoothed_value), t)

    scopes = [("career", "all", "生涯"), ("recent", "50", "最近50"), ("recent", "20", "最近20")]
    years = sorted({r.period_key for _, r in mv.iterrows() if r.period_type == "year"}, reverse=True)
    if years:
        scopes.append(("year", years[0], years[0] + "年"))
    HEADLINE = [("good", "findwolf_rate"), ("good", "survival_rate"), ("wolf", "survival_rate"),
                ("wolf", "win_rate"), ("wolf", "exposed_survival_rate")]
    ms_lines = []
    for camp, mk in HEADLINE:
        cells = []
        for pt, pkk, sl in scopes:
            r = mv[(mv.metric_key == mk) & (mv.camp == camp) & (mv.period_type == pt) & (mv.period_key == pkk)]
            if r.empty or band_row(r.iloc[0]) is None:
                cells.append(f"{sl}:—")
            else:
                cells.append(f"{sl}:{round(float(r.iloc[0].raw_value)*100,1)}%({band_row(r.iloc[0])})")
        ms_lines.append(f"{labels.get(mk, mk)}[{'好' if camp=='good' else '狼'}]  " + "  ".join(cells))

    cbands = {}
    for _, r in mv[(mv.period_type == "career") & (mv.period_key == "all")].iterrows():
        b = band_row(r)
        if b:
            cbands[(r.metric_key, r.camp)] = b
    fired2 = [r["tag"] for r in fw["t2_rules"]
              if all(cbands.get((c["metric_key"], c["camp"])) in c["band_in"] for c in r["when"])]

    # ---- print: 联动为主，指标为辅 ----
    print(f"选手画像 · {name}（ID {pid}）\n")
    print("◆ 联动画像（重点）")
    if fired0 or fired2:
        for t in fired0:
            print(f"  ▸ {t} 〔官方〕")
        for t in fired2:
            print(f"  ▸ {t} 〔自算〕")
    else:
        print("  （各项接近中等，无明显联动特征）")

    print("\n· 关键指标（只列偏离中等；实时可切赛区/赛季/场次）")
    for title in ("综合", "好人", "狼人"):
        if t0_notable[title]:
            print(f"  【{title}·官方】" + "，".join(t0_notable[title]))
    print("  【自算·多范围】")
    for line in ms_lines:
        print("   " + line)


if __name__ == "__main__":
    main()
