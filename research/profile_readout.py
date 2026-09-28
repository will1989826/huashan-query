"""#3 sample: render a player's Go-produced labels as a human-readable 画像.

Reads v_player_ability_labels (the production view, current ready run) and prints a
werewolf-language profile grouped by camp and trait family. Also the concrete source
for the band/confidence/metric-name translation discussion (maps at top — TUNE THESE).

Run from research/:  python profile_readout.py [player_id]
"""
import sys

import pandas as pd

from db import engine

# ---- PROPOSED translations (to discuss / tune) ----
METRIC_NAME = {
    "win_rate": "胜率", "mvp_rate": "MVP 率", "survival_rate": "存活率",
    "good_vote_hit_rate": "白天投票找狼命中率", "badge_vote_hit_rate": "警徽票找狼命中率",
    "findwolf_rate": "综合找狼命中率(投票+技能)", "badge_carry_rate": "警长当选率",
    "wolf_hook_rate": "投狼队友率", "hantiao_hook_rate": "倒钩率", "hantiao_rate": "悍跳率",
    "hantiao_badge_rate": "悍跳得警徽率",
    "self_destruct_rate": "自爆率",
}
BAND = {"very_high": "很高", "high": "偏高", "middle": "中等", "low": "偏低", "very_low": "很低"}
CONF = {"clue_only": "样本极少", "low": "样本较少", "medium": "样本适中", "higher": "样本充足"}
FAMILY = {"ability": "能力", "result": "结果", "structure": "结构", "tendency": "倾向"}
CAMP = {"good": "好人", "wolf": "狼人"}


def main():
    pid = int(sys.argv[1]) if len(sys.argv) > 1 else 748
    eng = engine()
    df = pd.read_sql(
        "SELECT camp, metric_key, metric_type, direction, numerator, denominator, "
        "raw_value, percentile, distribution_band, cohort_size, confidence "
        "FROM v_player_ability_labels WHERE player_id=%(p)s AND period_type='career' "
        "AND period_key='all'",
        eng, params={"p": pid},
    )
    name = pd.read_sql("SELECT player_name FROM players WHERE player_id=%(p)s", eng,
                       params={"p": pid})
    pname = name.iloc[0, 0] if len(name) else "?"
    if df.empty:
        print(f"玩家 {pid}（{pname}）暂无可展示的生涯特性标签。")
        return

    print(f"选手画像 · {pname}（ID {pid}）· 全生涯\n")
    for camp in ("good", "wolf"):
        sub = df[df.camp == camp]
        if sub.empty:
            continue
        print(f"【{CAMP[camp]}】")
        for fam in ("result", "ability", "structure", "tendency"):
            fs = sub[sub.metric_type == fam]
            for _, r in fs.iterrows():
                tag = "(倾向)" if fam == "tendency" else ""
                pct = f"{r.raw_value * 100:.1f}%" if pd.notna(r.raw_value) else "—"
                band = BAND.get(r.distribution_band, r.distribution_band)
                conf = CONF.get(r.confidence, r.confidence)
                print(f"  · {METRIC_NAME.get(r.metric_key, r.metric_key)}{tag}: {pct}"
                      f"（{int(r.numerator)}/{int(r.denominator)}）"
                      f" — {band}（同侪第 {r.percentile*100:.0f} 百分位 / {int(r.cohort_size)}人）"
                      f" · {conf}")
        print()


if __name__ == "__main__":
    main()
