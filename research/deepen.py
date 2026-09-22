"""Phase 3 深化：普通狼(role='狼')D3+ 存活与后期推进 + 胜率-场均落差。

普通狼=版型里的"小狼"(role_name='狼')，非悍跳专属/特殊狼(狼王/梦魇/狼美人…)。
问题：普通狼熬到后期(D3+)与狼队获胜有没有关系？"后期经营型"vs"工具/牺牲型"个体差异多大？
只读本地库(run 8)。Run: PYTHONIOENCODING=utf-8 PYTHONUTF8=1 python deepen.py
"""
import pandas as pd

from db import engine


def main():
    eng = engine()

    # —— A. 普通狼后期推进 ——
    pw = pd.read_sql(
        "SELECT player_id, player_name, "
        "(final_alive=1 OR death_day>=3) AS d3, won "
        "FROM analysis_game_players WHERE role_name='狼' AND player_id IS NOT NULL", eng)
    n = len(pw)
    d3_rate = pw.d3.mean()
    win_all = pw.won.mean()
    win_d3 = pw[pw.d3 == 1].won.mean()      # 熬到 D3+ 的普通狼局，狼队胜率
    win_early = pw[pw.d3 == 0].won.mean()   # 早死(D1/D2出局)的普通狼局，狼队胜率
    print("=== A. 普通狼(role=狼)后期推进 ===")
    print(f"样本 {n} 场普通狼记录；D3+ 存活率 {d3_rate*100:.1f}%")
    print(f"狼队胜率：普通狼熬到D3+ {win_d3*100:.1f}%  vs  普通狼早死 {win_early*100:.1f}%  (全体普通狼 {win_all*100:.1f}%)")
    print(f"→ 差值 {(win_d3-win_early)*100:+.1f}pt：普通狼活到后期与狼队胜负的关联强度\n")

    # 个体：普通狼 D3+ 存活率（前后各5，样本>=30）
    g = pw.groupby(["player_id", "player_name"]).agg(games=("d3", "size"), d3=("d3", "sum"), wins=("won", "sum"))
    g = g[g.games >= 30].copy()
    g["d3_rate"] = g.d3 / g.games
    g["win_rate"] = g.wins / g.games
    print(f"普通狼样本>=30 的选手 {len(g)} 人。普通狼 D3+ 存活率 中位 {g.d3_rate.median()*100:.1f}% / P10 {g.d3_rate.quantile(.1)*100:.1f}% / P90 {g.d3_rate.quantile(.9)*100:.1f}%")
    print("  后期经营型 Top5(普通狼D3+存活率最高):")
    for (_, nm), r in g.nlargest(5, "d3_rate").iterrows():
        print(f"    {nm}: D3+ {r.d3_rate*100:.0f}%  胜率 {r.win_rate*100:.0f}% ({int(r.games)}场)")
    print("  工具/牺牲型 Bottom5(普通狼D3+存活率最低):")
    for (_, nm), r in g.nsmallest(5, "d3_rate").iterrows():
        print(f"    {nm}: D3+ {r.d3_rate*100:.0f}%  胜率 {r.win_rate*100:.0f}% ({int(r.games)}场)")
    corr = g[["d3_rate", "win_rate"]].corr().iloc[0, 1]
    print(f"  个体层面：普通狼 D3+存活率 × 普通狼胜率 corr = {corr:.3f}\n")

    # —— B. 胜率-场均落差（团队兑现 vs 个人carry），用官方综合 ——
    stats = pd.read_sql("SELECT player_id, player_name, summary_json FROM player_stats WHERE summary_json IS NOT NULL", eng)
    import json
    rows = []
    for _, r in stats.iterrows():
        d = json.loads(r.summary_json) if r.summary_json else {}
        if (d.get("round_total") or 0) < 50:
            continue
        wp, avg = d.get("win_pct"), d.get("round_point_avg")
        if wp is None or avg is None:
            continue
        rows.append((r.player_name, float(wp), float(avg), d["round_total"]))
    s = pd.DataFrame(rows, columns=["name", "win_pct", "avg", "n"])
    # 标准化后残差：win 相对 avg 的超出（团队兑现=win高avg低）
    s["wz"] = (s.win_pct - s.win_pct.mean()) / s.win_pct.std()
    s["az"] = (s.avg - s.avg.mean()) / s.avg.std()
    s["gap"] = s.wz - s.az
    print("=== B. 胜率-场均落差（样本>=50场）===")
    print(f"win_pct × round_point_avg corr = {s[['win_pct','avg']].corr().iloc[0,1]:.3f}")
    print("  团队兑现型 Top5(胜率相对场均分最超出=靠队友赢):")
    for _, r in s.nlargest(5, "gap").iterrows():
        print(f"    {r['name']}: 胜率 {r.win_pct:.0f}% 场均 {r.avg:.2f} ({int(r.n)}场)")
    print("  个人carry型 Bottom5(场均分相对胜率最超出=个人数据好但没赢下来):")
    for _, r in s.nsmallest(5, "gap").iterrows():
        print(f"    {r['name']}: 胜率 {r.win_pct:.0f}% 场均 {r.avg:.2f} ({int(r.n)}场)")

    # —— C. 警徽投对真预言家 × 对跳局胜负（验证 v5 警徽指标是否有意义）——
    gp = pd.read_sql(
        "SELECT gp.game_id, gp.camp, gp.badge_seer_hit, gp.badge_duel_vote, g.victory_camp "
        "FROM analysis_game_players gp JOIN analysis_games g ON g.game_id=gp.game_id "
        "WHERE gp.game_id IN (SELECT game_id FROM analysis_game_players WHERE seer_duel=1)", eng)
    good = gp[gp.camp == "good"].groupby("game_id").agg(
        hit=("badge_seer_hit", "sum"), votes=("badge_duel_vote", "sum"), vc=("victory_camp", "first"))
    good = good[good.votes > 0].copy()
    good["hit_rate"] = good.hit / good.votes           # 该局好人警下投对真预言家的比例
    good["good_win"] = (good.vc == 1).astype(int)
    print("\n=== C. 警徽投对真预言家率 × 对跳局好人胜负 ===")
    print(f"对跳局(好人有警下票) {len(good)} 场；整体好人胜率 {good.good_win.mean()*100:.1f}%")
    for lo, hi in [(0, 0.2), (0.2, 0.4), (0.4, 0.6), (0.6, 0.8), (0.8, 1.01)]:
        seg = good[(good.hit_rate >= lo) & (good.hit_rate < hi)]
        if len(seg):
            print(f"  投对率 [{lo:.0%},{hi:.0%}): 好人胜率 {seg.good_win.mean()*100:.1f}%  ({len(seg)}场)")
    print(f"  → 投对率 × 好人胜负 corr = {good[['hit_rate','good_win']].corr().iloc[0,1]:.3f}"
          "（正=警徽阶段就投对真预言家的局，好人赢得多）")


if __name__ == "__main__":
    main()
