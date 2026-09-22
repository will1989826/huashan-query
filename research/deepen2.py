"""Phase 3 深化 batch 2：神职存活按身份 / 得分波动 / 自爆时机。
只读本地库(run 8)。Run: PYTHONIOENCODING=utf-8 PYTHONUTF8=1 python deepen2.py
"""
import json

import pandas as pd

from db import engine


def main():
    eng = engine()

    # —— A. 神职存活按身份（god_survival_rate 是否被身份构成混淆）——
    god = pd.read_sql(
        "SELECT role_name, COUNT(*) n, AVG(final_alive) surv "
        "FROM analysis_game_players WHERE camp='good' AND role_name<>'平民' AND player_id IS NOT NULL "
        "GROUP BY role_name HAVING n>=200 ORDER BY surv", eng)
    print("=== A. 神职存活率按身份 ===")
    for _, r in god.iterrows():
        print(f"  {r.role_name}: 存活 {r.surv*100:.1f}%  ({int(r.n)}局)")
    print("  → 各神职存活率跨度极大：pooled god_survival_rate 受身份构成混淆，"
          "常拿预言家的人天然偏低。解读时应注明或按身份条件化。\n")

    # 对比平民
    civ = pd.read_sql("SELECT AVG(final_alive) s, COUNT(*) n FROM analysis_game_players WHERE camp='good' AND role_name='平民'", eng)
    print(f"  (平民存活 {civ.s.iloc[0]*100:.1f}%，{int(civ.n.iloc[0])}局，作参照)\n")

    # —— B. 得分波动：MVP+背锅占比 = 高光/背锅两头跑（boom/bust） ——
    stats = pd.read_sql("SELECT player_name, summary_json FROM player_stats WHERE summary_json IS NOT NULL", eng)
    rows = []
    for _, r in stats.iterrows():
        d = json.loads(r.summary_json) if r.summary_json else {}
        rt = d.get("round_total") or 0
        if rt < 80:
            continue
        mvp, bgx = d.get("mvp_num") or 0, d.get("bgx_num") or 0
        wp = d.get("win_pct")
        rows.append((r.player_name, (mvp + bgx) / rt, mvp / rt, bgx / rt, float(wp) if wp is not None else None, rt))
    v = pd.DataFrame(rows, columns=["name", "vol", "mvp_r", "bgx_r", "win", "n"]).dropna()
    print("=== B. 得分波动（(MVP+背锅)/场次，样本>=80场）===")
    print(f"  波动 中位 {v.vol.median()*100:.1f}% / P90 {v.vol.quantile(.9)*100:.1f}%；波动×胜率 corr {v[['vol','win']].corr().iloc[0,1]:.3f}")
    print("  最 boom/bust Top5(高光+背锅都多):")
    for _, r in v.nlargest(5, "vol").iterrows():
        print(f"    {r['name']}: MVP {r.mvp_r*100:.0f}% 背锅 {r.bgx_r*100:.0f}% 胜率 {r.win:.0f}% ({int(r.n)}场)")
    print("  最稳(高光+背锅都少)Top5:")
    for _, r in v.nsmallest(5, "vol").iterrows():
        print(f"    {r['name']}: MVP {r.mvp_r*100:.0f}% 背锅 {r.bgx_r*100:.0f}% 胜率 {r.win:.0f}% ({int(r.n)}场)")
    print()

    # —— C. 自爆时机 × 狼队胜负 ——
    sd = pd.read_sql(
        "SELECT gp.self_destruct_day d, g.victory_camp vc FROM analysis_game_players gp "
        "JOIN analysis_games g ON g.game_id=gp.game_id WHERE gp.self_destruct_day IS NOT NULL AND gp.camp='wolf'", eng)
    sd["wolf_win"] = (sd.vc == 2).astype(int)
    base = pd.read_sql("SELECT AVG(victory_camp=2) w FROM analysis_games WHERE parsed_ok=1", eng).w.iloc[0]
    print("=== C. 自爆时机 × 狼队胜负 ===")
    print(f"  全体狼队胜率基线 {base*100:.1f}%；有自爆的局 {len(sd)} 例，狼胜 {sd.wolf_win.mean()*100:.1f}%")
    for day in sorted(sd.d.unique()):
        seg = sd[sd.d == day]
        if len(seg) >= 30:
            print(f"    第{int(day)}天自爆: 狼胜 {seg.wolf_win.mean()*100:.1f}%  ({len(seg)}例)")


if __name__ == "__main__":
    main()
