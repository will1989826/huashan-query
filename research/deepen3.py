"""Phase 3 深化 batch 3：站对边率的预测力验证 / 首刀目标身份。
只读本地库(run 8)。Run: PYTHONIOENCODING=utf-8 PYTHONUTF8=1 python deepen3.py
"""
import pandas as pd

from db import engine


def main():
    eng = engine()

    # —— A. 站对边率(v4 主线判断轴)是否预测好人胜率 ——
    mv = pd.read_sql(
        "SELECT player_id, metric_key, raw_value FROM analysis_metric_values "
        "WHERE camp='good' AND period_type='career' AND period_key='all' AND eligible=1 "
        "AND metric_key IN ('zhanbian_rate','findwolf_rate','survival_rate','win_rate')", eng)
    p = mv.pivot_table(index="player_id", columns="metric_key", values="raw_value")
    p = p.dropna(subset=["zhanbian_rate", "win_rate"])
    print("=== A. 站对边率 × 好人胜率（同阵营选手层面，eligible）===")
    print(f"  样本 {len(p)} 人")
    print(f"  站对边率 × 好人胜率 corr {p[['zhanbian_rate','win_rate']].corr().iloc[0,1]:.3f}")
    print(f"  找狼率   × 好人胜率 corr {p[['findwolf_rate','win_rate']].corr().iloc[0,1]:.3f}  (对照)")
    print(f"  存活率   × 好人胜率 corr {p[['survival_rate','win_rate']].corr().iloc[0,1]:.3f}  (对照)")
    print(f"  站对边率 × 找狼率   corr {p[['zhanbian_rate','findwolf_rate']].corr().iloc[0,1]:.3f}  (两轴独立性)")
    q = p.copy()
    q["zb_hi"] = q.zhanbian_rate >= q.zhanbian_rate.median()
    for hi in (True, False):
        seg = q[q.zb_hi == hi]
        print(f"  站对边率{'高' if hi else '低'}半区: 好人胜率 {seg.win_rate.mean()*100:.1f}%  ({len(seg)}人)")
    print()

    # —— B. 首刀(夜1狼刀)目标身份：狼优先刀谁 ——
    kn = pd.read_sql(
        "SELECT role_name, camp, COUNT(*) n FROM analysis_deaths "
        "WHERE cause='knife' AND day=1 GROUP BY role_name, camp ORDER BY n DESC", eng)
    tot = kn.n.sum()
    print(f"=== B. 首刀(夜1狼刀)目标身份分布 · 共 {tot} 刀 ===")
    # 与"场上身份基数"对比：每类身份在全库出现次数（=可被刀的池子），看是否被超额针对
    base = pd.read_sql("SELECT role_name, COUNT(*) n FROM analysis_game_players WHERE camp='good' GROUP BY role_name", eng)
    basemap = dict(zip(base.role_name, base.n))
    for _, r in kn[kn.camp == "good"].head(12).iterrows():
        pool = basemap.get(r.role_name, 0)
        share = r.n / tot * 100
        rate = (r.n / pool * 100) if pool else 0
        print(f"  {r.role_name}: 首刀 {int(r.n)} 次（占首刀 {share:.1f}%；该身份被首刀概率 {rate:.1f}%）")
    print("  → 被首刀概率越高=越被狼视为威胁/关键神，优先做掉。")


if __name__ == "__main__":
    main()
