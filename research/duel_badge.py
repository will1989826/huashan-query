"""原型：预言家 vs 悍跳「第一天对决」+ 对跳局警下警徽投票去向。

只读现有重建表（analysis_game_players / analysis_votes），验口径用；口径稳定后再固化进 Go。

Part A 第一天对决（只算第一天，对跳局=真预言家+至少一个悍跳狼同场）:
  活着进入第二天黑夜 = 熬过第一天(死亡日为空或>=2)。
  预言家胜 = 预言家活进第二天 且 悍跳(全部)第一天出局。
  悍跳胜   = 悍跳活进第二天 且 第一天有好人出局(真预言家 或 其他好人——可能中了悍跳的假查杀)。
  两人都活且无好人出局 = 平（都不计胜）。死因不限（放逐/毒/刀等），以是否熬过第一天为准。

Part B 警下警徽投票（对跳局；排除两名对跳者本人；只算真的投了票的——弃票/上警无数据）:
  目标分三类：投真预言家 / 投悍跳狼 / 投外置位(其他座位)。按投票人阵营分好人/狼人。

Run: PYTHONIOENCODING=utf-8 PYTHONUTF8=1 python duel_badge.py
"""
import pandas as pd

from db import engine


def main():
    eng = engine()
    gp = pd.read_sql(
        "SELECT game_id,seat,player_id,player_name,camp,role_name,hantiao_role_name,"
        "death_day,death_phase,final_alive FROM analysis_game_players WHERE player_id IS NOT NULL", eng)
    gp["death_day"] = pd.to_numeric(gp["death_day"], errors="coerce")
    gp["alive1"] = gp.death_day.isna() | (gp.death_day >= 2)          # 熬过第一天
    gp["died1"] = gp.death_day == 1                                    # 第一天出局
    gp["is_seer"] = (gp.camp == "good") & (gp.role_name == "预言家")
    gp["is_hantiao"] = (gp.camp == "wolf") & (gp.hantiao_role_name == "预言家")

    seer = gp[gp.is_seer].groupby("game_id")
    hant = gp[gp.is_hantiao].groupby("game_id")
    seer_seat = seer.seat.first()
    seer_alive1 = seer.alive1.first()
    hant_seats = hant.seat.apply(set)
    hant_all_removed = ~hant.alive1.any()      # 悍跳没有一个熬过第一天
    hant_any_alive1 = hant.alive1.any()
    good_died1 = gp[gp.camp == "good"].groupby("game_id").died1.any()

    duel = sorted(set(seer_seat.index) & set(hant_seats.index))
    d = pd.DataFrame(index=duel)
    d["seer_seat"] = seer_seat
    d["seer_alive1"] = seer_alive1
    d["hant_all_removed"] = hant_all_removed
    d["hant_any_alive1"] = hant_any_alive1
    d["good_died1"] = good_died1.reindex(duel).fillna(False)
    d["seer_win"] = d.seer_alive1 & d.hant_all_removed
    d["hant_win"] = d.hant_any_alive1 & d.good_died1
    d["draw"] = ~d.seer_win & ~d.hant_win

    print(f"对跳局(真预言家+悍跳同场): {len(duel)}")
    print(f"  预言家胜 {d.seer_win.mean()*100:.1f}%  悍跳胜 {d.hant_win.mean()*100:.1f}%  平/其他 {d.draw.mean()*100:.1f}%")
    print(f"  (预言家熬过第一天 {d.seer_alive1.mean()*100:.1f}%; 对跳局第一天有好人出局 {d.good_died1.mean()*100:.1f}%)")

    # Part B: 警下警徽投票去向（对跳局，排除对跳双方本人）
    bv_all = pd.read_sql(
        "SELECT game_id,voter_seat,voter_camp,target_seat FROM analysis_votes "
        "WHERE vote_kind='badge' AND abstain=0 AND target_seat IS NOT NULL", eng)
    bv = bv_all[bv_all.game_id.isin(duel)].copy()
    bv["seer_seat"] = bv.game_id.map(seer_seat)
    bv["hant_seats"] = bv.game_id.map(hant_seats)
    bv["is_duelist"] = bv.apply(lambda r: r.voter_seat == r.seer_seat or r.voter_seat in r.hant_seats, axis=1)
    bv = bv[~bv.is_duelist]                                            # 排除两名对跳者本人的票
    def tgt(r):
        if r.target_seat == r.seer_seat:
            return "投真预言家"
        if r.target_seat in r.hant_seats:
            return "投悍跳狼"
        return "投外置位"
    bv["cat"] = bv.apply(tgt, axis=1)

    print(f"\n对跳局警下警徽票(排除对跳双方): {len(bv)}")
    for camp, name in (("good", "好人"), ("wolf", "狼人")):
        sub = bv[bv.voter_camp == camp]
        if sub.empty:
            continue
        dist = sub.cat.value_counts(normalize=True) * 100
        print(f"  {name}警下({len(sub)}票): " +
              "  ".join(f"{k} {dist.get(k,0):.1f}%" for k in ("投真预言家", "投悍跳狼", "投外置位")))

    # Part C: 投警徽率（代理"爱上警"）——有警徽竞选的局里、活到竞选时、真的投了票的比例。
    #   低 = 常上警自荐 / 弃票不表态；高 = 老实在警下投票。上警/弃票无数据，用它当代理。
    badge_games = set(bv_all.game_id.unique())                        # 发生过警徽竞选的局
    voted = bv_all.groupby(["game_id", "voter_seat"]).size().rename("v").reset_index()
    voted_key = set(zip(voted.game_id, voted.voter_seat))
    elig = gp[gp.game_id.isin(badge_games)].copy()
    elig["alive_at_badge"] = ~((elig.death_day == 1) & (elig.death_phase == "night"))  # 夜1死者投不了警徽
    elig = elig[elig.alive_at_badge]
    elig["cast"] = [(g, s) in voted_key for g, s in zip(elig.game_id, elig.seat)]
    per = elig.groupby("player_id").agg(games=("cast", "size"), casts=("cast", "sum"))
    per = per[per.games >= 30]
    per["badge_vote_rate"] = per.casts / per.games
    print(f"\n投警徽率(样本>=30局的{len(per)}人): "
          f"中位 {per.badge_vote_rate.median()*100:.1f}%  "
          f"P10 {per.badge_vote_rate.quantile(.1)*100:.1f}%  P90 {per.badge_vote_rate.quantile(.9)*100:.1f}%")
    print("  低投警徽率(≈爱上警/爱弃票)Top5:")
    for pid, r in per.nsmallest(5, "badge_vote_rate").iterrows():
        nm = gp[gp.player_id == pid].player_name.iloc[0]
        print(f"    {nm}: {r.badge_vote_rate*100:.0f}% ({int(r.casts)}/{int(r.games)})")


if __name__ == "__main__":
    main()
