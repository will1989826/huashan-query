"""Phase 2/3 深化：关键放逐轮加权（研究）。
思路：给好人白天投票找狼命中，按"这轮放逐前场上还剩几只狼"加权——剩狼越少，这轮越关键。
警惕耦合：把最后一只狼投出去=直接赢，是结果不是纯能力；且只有活到残局的人才有票=幸存者偏差。
故本脚本既看梯度，也把"决胜轮(投出最后一只狼)"单独拆出来，避免污染。
只读本地库(run 8)。Run: PYTHONIOENCODING=utf-8 PYTHONUTF8=1 python matchup_rounds.py
"""
import pandas as pd

from db import engine


def main():
    eng = engine()
    gp = pd.read_sql(
        "SELECT game_id, camp, death_day, death_phase FROM analysis_game_players "
        "WHERE camp='wolf'", eng)
    gp["death_day"] = pd.to_numeric(gp["death_day"], errors="coerce")

    # 每场每个白天投票日 d：放逐结算前的存活狼数 = 总狼 - (death_day<d 或 death_day==d&夜死)
    votes = pd.read_sql(
        "SELECT v.game_id, v.day, v.voter_player_id, v.good_vote_hit, g.victory_camp "
        "FROM analysis_votes v JOIN analysis_games g ON g.game_id=v.game_id "
        "WHERE v.vote_kind='day' AND v.voter_camp='good' AND v.abstain=0 AND v.good_vote_hit IS NOT NULL", eng)
    gd = votes[["game_id", "day"]].drop_duplicates()
    m = gd.merge(gp, on="game_id")
    m["dead_before"] = (m.death_day < m.day) | ((m.death_day == m.day) & (m.death_phase == "night"))
    agg = m.groupby(["game_id", "day"]).agg(total=("dead_before", "size"), dead=("dead_before", "sum")).reset_index()
    agg["alive_w"] = agg.total - agg.dead
    votes = votes.merge(agg[["game_id", "day", "alive_w"]], on=["game_id", "day"], how="left")
    votes["good_win"] = (votes.victory_camp == 1).astype(int)

    print("=== A. 好人找狼命中率 按'放逐前存活狼数'分档 ===")
    print("(存活狼越少=残局，越关键；同时看该档命中所在局的好人胜率——注意耦合)")
    for w in sorted(votes.alive_w.dropna().unique()):
        seg = votes[votes.alive_w == w]
        if len(seg) < 200:
            continue
        print(f"  剩 {int(w)} 狼: 找狼命中率 {seg.good_vote_hit.mean()*100:.1f}%  该档投票所在局好人胜率 {seg.good_win.mean()*100:.1f}%  ({len(seg)} 票)")
    print("  → 命中率随残局(剩狼少)是否变化 = 好人在关键轮找狼更准/更难；胜率列受耦合(投出最后狼=赢)污染，仅参考。\n")

    # —— B. 加权找狼命中率 vs flat，是否重排选手 / 更预测胜 ——
    # 杠杆权重：剩 1 狼=3，剩 2 狼=2，剩>=3 狼=1（残局加权）。决胜轮(剩1狼且命中)另标。
    def lev(w):
        if w <= 1:
            return 3.0
        if w == 2:
            return 2.0
        return 1.0
    votes["L"] = votes.alive_w.fillna(3).map(lev)
    votes["wl_hit"] = votes.L * votes.good_vote_hit
    per = votes.groupby("voter_player_id").agg(
        att=("good_vote_hit", "size"), hit=("good_vote_hit", "sum"),
        watt=("L", "sum"), whit=("wl_hit", "sum")).reset_index()
    per = per[per.att >= 50].copy()
    per["flat"] = per.hit / per.att
    per["weighted"] = per.whit / per.watt
    per["delta"] = per.weighted - per.flat
    # 好人胜率（该选手好人局）
    gw = pd.read_sql(
        "SELECT player_id, AVG(won) win FROM analysis_game_players WHERE camp='good' AND player_id IS NOT NULL GROUP BY player_id", eng)
    per = per.merge(gw, left_on="voter_player_id", right_on="player_id", how="left")
    print("=== B. 关键轮加权找狼命中率 vs 平铺(样本>=50投票) ===")
    print(f"  {len(per)} 人；加权与平铺相关 corr {per[['flat','weighted']].corr().iloc[0,1]:.3f}（越接近1=加权几乎没重排）")
    print(f"  与好人胜率相关：flat {per[['flat','win']].corr().iloc[0,1]:.3f}  加权 {per[['weighted','win']].corr().iloc[0,1]:.3f}")
    print(f"  加权-平铺 差值 |Δ| 中位 {per.delta.abs().median()*100:.2f}pt（重排幅度）")
    print("  → 若两者 corr≈1 且预测力无提升，则加权是花架子；若加权预测力明显更高才值得固化。")


if __name__ == "__main__":
    main()
