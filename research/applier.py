"""Step 3: applier — feed a player's T0 metrics into framework.json -> 画像.

Mirrors exactly what the app would do on the detail page: take the per-zone official T0
metrics, band each against the thresholds, fire the 联动 rules, print a readable profile.
Here the T0 source is player_stats (same official shape as the live per-zone API).

Run from research/:  python applier.py [player_id]
"""
import json
import sys

import pandas as pd

from db import engine


def band_of(v, m):
    if v < m["p10"]:
        return "很低"
    if v < m["p30"]:
        return "偏低"
    if v <= m["p70"]:
        return "中等"
    if v < m["p90"]:
        return "偏高"
    return "很高"


def player_value(stats_row, m):
    d = stats_row.get(m["source"]) or {}
    if not d or (d.get("round_total") or 0) < 1:
        return None, None
    v = d.get(m["key"])
    if v is None:
        return None, None
    rt = d.get("round_total") or 0
    if m["kind"] == "rate":
        if rt == 0:
            return None, None
        v = 100.0 * float(v) / rt
    else:
        v = float(v)
    if m.get("role_conditioned") and v <= 0:
        return None, None
    return round(v, 2), int(rt)


def confidence(rounds, labels):
    if rounds < 10:
        return labels["clue_only"]
    if rounds < 30:
        return labels["low"]
    if rounds < 80:
        return labels["medium"]
    return labels["higher"]


def main():
    pid = int(sys.argv[1]) if len(sys.argv) > 1 else 748
    fw = json.load(open("output/framework.json", encoding="utf-8"))
    eng = engine()
    row = pd.read_sql("SELECT player_name, summary_json, haoren_json, langren_json "
                      "FROM player_stats WHERE player_id=%(p)s", eng, params={"p": pid})
    if row.empty:
        print(f"玩家 {pid} 无 T0 数据"); return
    r = row.iloc[0]
    stats = {src: (json.loads(r[src]) if r[src] else {}) for src in
             ("summary_json", "haoren_json", "langren_json")}

    print(f"选手画像（官方T0框架）· {r.player_name}（ID {pid}）\n")
    bands = {}
    for camp, title in [("comprehensive", "综合"), ("good", "好人"), ("wolf", "狼人")]:
        lines = []
        for m in fw["metrics"]:
            if m["camp"] != camp:
                continue
            v, rounds = player_value(stats, m)
            if v is None:
                continue
            b = band_of(v, m)
            bands[m["label"]] = b
            lines.append(f"  · {m['label'].split('·')[1]}: {v}"
                         f"（{b}｜同侪{m['n']}人）· {confidence(rounds, fw['confidence'])}")
        if lines:
            print(f"【{title}】")
            print("\n".join(lines))
            print()

    # fire 联动 rules
    fired = []
    for rule in fw["rules"]:
        if all(bands.get(c["metric"]) in c["band_in"] for c in rule["when"]):
            fired.append(rule["tag"])
    print("联动解读:")
    print("\n".join(f"  ▸ {t}" for t in fired) if fired else "  （无触发的联动规则）")


if __name__ == "__main__":
    main()
