// aggregate.go —— 把逐座事实(player.SeatFacts)按选手·阵营聚合成 T2 指标分子/分母，
// 与 cmd/player-analysis-build 的 addFact()+metricDefinitions() 同口径。框架套用(档位/排名/
// 联动)在前端复用已加载的 framework.json 完成，本包只出数值。
package analysis

import "huashanquery/internal/player"

// Agg 累加单个选手在单一阵营(good/wolf)下的逐场事实。
type Agg struct {
	Games, Wins, MVP, Alive                             int
	GoodVotes, GoodHits, FindEvents, FindHits           int
	WonFwHits, WonFwAtt, LostFwHits, LostFwAtt          int
	ZhanbianAtt, ZhanbianCorrect, ZhanbianExiled        int
	CivGames, CivNightDeaths, GodGames, GodAlive        int
	Checked, D3Alive                                    int
	Hantiao, SelfDestruct, HantiaoBadge                 int
	Exposed, ExposedSurvived                            int
	ChargeGames, ChargeSurvived, HookGames, HookSurvived int
	WolfCharge, WolfHook                                int
	SeerDuel, SeerDuelWin, HantiaoDuel, HantiaoDuelWin  int
	BadgeDuelVotes, BadgeSeerHits, BadgeHantiaoHits     int
	BadgePresent, BadgeCast                             int
	NightmareAtt, NightmareGod, CharmAtt, CharmGod      int
}

// Add folds one seat's facts into the aggregate (mirror of builder addFact).
func (a *Agg) Add(f *player.SeatFacts) {
	a.Games++
	a.Wins += f.Won
	a.MVP += f.MVP
	a.Alive += f.FinalAlive
	a.GoodVotes += f.GoodVoteEvents
	a.GoodHits += f.GoodVoteHits
	a.FindEvents += f.FindSkillEvents
	a.FindHits += f.FindSkillHits
	fwAtt, fwHit := f.GoodVoteEvents+f.FindSkillEvents, f.GoodVoteHits+f.FindSkillHits
	if f.Won == 1 {
		a.WonFwAtt += fwAtt
		a.WonFwHits += fwHit
	} else {
		a.LostFwAtt += fwAtt
		a.LostFwHits += fwHit
	}
	a.ZhanbianAtt += f.ZhanbianAtt
	a.ZhanbianCorrect += f.ZhanbianCorrect
	a.ZhanbianExiled += f.ZhanbianExiled
	a.CivGames += f.IsCiv
	a.CivNightDeaths += f.CivNightDeath
	a.GodGames += f.IsGod
	a.GodAlive += f.GodAlive
	a.Checked += f.CheckedBySeer
	if f.FinalAlive == 1 || f.DeathDay >= 3 {
		a.D3Alive++
	}
	a.Hantiao += f.HantiaoGame
	a.SelfDestruct += f.SelfDestruct
	if f.HantiaoGame == 1 && f.BadgeGame == 1 {
		a.HantiaoBadge++
	}
	if f.HantiaoGame == 1 || f.SelfDestruct == 1 || f.WolfChargeVotes > 0 {
		a.Exposed++
		if f.FinalAlive == 1 {
			a.ExposedSurvived++
		}
	}
	if f.WolfChargeVotes > 0 {
		a.ChargeGames++
		if f.FinalAlive == 1 {
			a.ChargeSurvived++
		}
	}
	if f.WolfHookVotes > 0 {
		a.HookGames++
		if f.FinalAlive == 1 {
			a.HookSurvived++
		}
	}
	a.WolfCharge += f.WolfChargeVotes
	a.WolfHook += f.WolfHookVotes
	a.SeerDuel += f.SeerDuel
	a.SeerDuelWin += f.SeerDuelWin
	a.HantiaoDuel += f.HantiaoDuel
	a.HantiaoDuelWin += f.HantiaoDuelWin
	a.BadgeDuelVotes += f.BadgeDuelVote
	a.BadgeSeerHits += f.BadgeSeerHit
	a.BadgeHantiaoHits += f.BadgeHantiaoHit
	a.BadgePresent += f.BadgePresent
	a.BadgeCast += f.BadgeCast
	a.NightmareAtt += f.NightmareAtt
	a.NightmareGod += f.NightmareGod
	a.CharmAtt += f.CharmAtt
	a.CharmGod += f.CharmGod
}

// Metric is one metric's numerator/denominator/value for a camp.
type Metric struct {
	Num   int     `json:"num"`
	Den   int     `json:"den"`
	Value float64 `json:"value"`
}

func mv(num, den int) Metric {
	m := Metric{Num: num, Den: den}
	if den > 0 {
		m.Value = float64(num) / float64(den)
	}
	return m
}

// Metrics computes every T2 metric for one camp aggregate (keys match metricDefinitions).
func (a *Agg) Metrics() map[string]Metric {
	return map[string]Metric{
		"win_rate":              mv(a.Wins, a.Games),
		"survival_rate":         mv(a.Alive, a.Games),
		"mvp_rate":              mv(a.MVP, a.Games),
		"findwolf_rate":         mv(a.GoodHits+a.FindHits, a.GoodVotes+a.FindEvents),
		"won_findwolf_rate":     mv(a.WonFwHits, a.WonFwAtt),
		"lost_findwolf_rate":    mv(a.LostFwHits, a.LostFwAtt),
		"zhanbian_rate":         mv(a.ZhanbianCorrect, a.ZhanbianAtt),
		"zhanbian_exiled_rate":  mv(a.ZhanbianExiled, a.ZhanbianCorrect),
		"civ_night_death_rate":  mv(a.CivNightDeaths, a.CivGames),
		"god_survival_rate":     mv(a.GodAlive, a.GodGames),
		"seer_duel_win_rate":    mv(a.SeerDuelWin, a.SeerDuel),
		"badge_seer_hit_rate":   mv(a.BadgeSeerHits, a.BadgeDuelVotes),
		"seer_checked_rate":     mv(a.Checked, a.Games),
		"d3_survival_rate":      mv(a.D3Alive, a.Games),
		"badge_vote_rate":       mv(a.BadgeCast, a.BadgePresent),
		"hantiao_rate":          mv(a.Hantiao, a.Games),
		"hantiao_badge_rate":    mv(a.HantiaoBadge, a.Hantiao),
		"exposed_survival_rate": mv(a.ExposedSurvived, a.Exposed),
		"charge_survival_rate":  mv(a.ChargeSurvived, a.ChargeGames),
		"hook_survival_rate":    mv(a.HookSurvived, a.HookGames),
		"wolf_hook_rate":        mv(a.WolfHook, a.WolfHook+a.WolfCharge),
		"self_destruct_rate":    mv(a.SelfDestruct, a.Games),
		"hantiao_duel_win_rate": mv(a.HantiaoDuelWin, a.HantiaoDuel),
		"badge_charge_rate":     mv(a.BadgeHantiaoHits, a.BadgeDuelVotes),
		"badge_hook_rate":       mv(a.BadgeSeerHits, a.BadgeDuelVotes),
		"nightmare_god_rate":    mv(a.NightmareGod, a.NightmareAtt),
		"charm_god_rate":        mv(a.CharmGod, a.CharmAtt),
	}
}
