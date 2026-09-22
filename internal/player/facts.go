// facts.go —— 逐座 T2 事实计算（与 cmd/player-analysis-build 的 analyze() 同口径）。
// 供桌面版 live「自算画像」端点复用同一份重建+口径，不在 JS 重写。输入=单场原始 JSON。
package player

import (
	"encoding/json"
	"errors"
	"strconv"
)

// goodFindSkills / godRoles 与 builder 保持一致（docs/standards/werewolf-language.md）。
var goodFindSkills = map[string]bool{
	"预言家": true, "女巫毒": true, "猎人枪": true, "骑士骑": true,
	"侦探翻": true, "猎魔人": true, "警犬查验": true,
}
var godRoles = map[string]bool{
	"预言家": true, "女巫": true, "猎人": true, "白痴": true, "守卫": true, "骑士": true,
	"守墓人": true, "摄梦人": true, "猎魔人": true, "警犬": true, "熊": true, "侦探": true,
}

// SeatFacts 是单座在单局内的 T2 事实（分子/分母的原子），字段对齐 analysis_game_players。
type SeatFacts struct {
	Seat            int
	PlayerID        int
	PlayerName      string
	Camp            string // good / wolf
	Role            string
	Won, MVP        int
	FinalAlive      int
	DeathDay        int    // 0=存活到终局
	DeathPhase      string // night/day
	DayVoteEvents   int
	GoodVoteEvents  int
	GoodVoteHits    int
	BadgeVoteEvents int
	BadgeVoteHits   int
	WolfChargeVotes int
	WolfHookVotes   int
	FindSkillEvents int
	FindSkillHits   int
	CheckedBySeer   int
	CheckedAsWolf   int
	HantiaoGame     int
	SelfDestruct    int
	BadgeGame       int // 当选警长(day_of_jinhui)
	IsCiv           int
	CivNightDeath   int
	IsGod           int
	GodAlive        int
	NightmareAtt    int
	NightmareGod    int
	CharmAtt        int
	CharmGod        int
	ZhanbianAtt     int
	ZhanbianCorrect int
	ZhanbianExiled  int
	SeerDuel        int
	SeerDuelWin     int
	HantiaoDuel     int
	HantiaoDuelWin  int
	BadgeDuelVote   int
	BadgeSeerHit    int
	BadgeHantiaoHit int
	BadgePresent    int
	BadgeCast       int
}

// GameFacts holds every seat's facts for one reconstructed game.
type GameFacts struct {
	Victory int
	Seats   map[int]*SeatFacts
}

// ComputeGameFacts reconstructs a game and derives per-seat T2 facts, mirroring the
// offline builder so live and offline share one 口径.
func ComputeGameFacts(raw []byte) (*GameFacts, error) {
	var top map[string]json.RawMessage
	if err := json.Unmarshal(raw, &top); err != nil {
		return nil, err
	}
	an, r, ok := analyzeReplay(top)
	if !ok {
		return nil, errors.New("reconstruct game: incomplete or malformed form2")
	}

	camps := map[int]string{}
	for _, s := range an.Roster.Wolf {
		camps[s] = "wolf"
	}
	for _, s := range an.Roster.Gods {
		camps[s] = "good"
	}
	for _, s := range an.Roster.Civ {
		camps[s] = "good"
	}
	alive := map[int]bool{}
	for _, s := range an.Alive {
		alive[s] = true
	}
	deaths := map[int]Death{}
	for _, d := range an.Deaths {
		deaths[d.Seat] = d
	}

	f := make(map[int]*SeatFacts, 12)
	for s := 1; s <= 12; s++ {
		st := r.bySeat[s]
		sf := &SeatFacts{Seat: s, Camp: camps[s]}
		if st != nil {
			sf.Role = st.Role
			sf.PlayerID = st.PlayerID
			sf.PlayerName = st.Name
			if st.DayHt != 0 {
				sf.HantiaoGame = 1
			}
			if st.Zibao != 0 {
				sf.SelfDestruct = 1
			}
			if st.JinhuiDay != 0 {
				sf.BadgeGame = 1
			}
		}
		if (camps[s] == "good" && r.Victory == 1) || (camps[s] == "wolf" && r.Victory == 2) {
			sf.Won = 1
		}
		if r.MVPSeat == s {
			sf.MVP = 1
		}
		if alive[s] {
			sf.FinalAlive = 1
		}
		if d, ok := deaths[s]; ok {
			sf.DeathDay = d.Day
			sf.DeathPhase = d.Phase
		}
		f[s] = sf
	}

	// —— 投票分类（day: 找狼/冲锋/倒钩；badge: 好人投对）——
	classify := func(kind string, vote Vote) {
		sf := f[vote.Seat]
		if sf == nil {
			return
		}
		abstain := vote.Abstain || vote.Target < 1 || vote.Target > 12
		voterCamp, targetCamp := camps[vote.Seat], camps[vote.Target]
		if kind == "day" {
			sf.DayVoteEvents++
			if voterCamp == "good" && !abstain {
				sf.GoodVoteEvents++
				if targetCamp == "wolf" {
					sf.GoodVoteHits++
				}
			}
			if voterCamp == "wolf" && !abstain {
				if targetCamp == "wolf" {
					sf.WolfHookVotes++
				} else if targetCamp == "good" {
					sf.WolfChargeVotes++
				}
			}
		} else if voterCamp == "good" && !abstain {
			sf.BadgeVoteEvents++
			if targetCamp == "wolf" {
				sf.BadgeVoteHits++
			}
		}
	}
	for _, v := range an.BadgeVotes {
		classify("badge", v)
	}
	days := make([]int, 0, len(an.Votes))
	for k := range an.Votes {
		d, _ := strconv.Atoi(k)
		days = append(days, d)
	}
	sortInts(days)
	for _, d := range days {
		for _, v := range an.Votes[strconv.Itoa(d)] {
			classify("day", v)
		}
	}

	// —— 技能：找狼命中 / 被验 / 梦魇·狼美人对神 ——
	checked, checkedWolf := map[int]int{}, map[int]int{}
	for s := 1; s <= 12; s++ {
		st := r.bySeat[s]
		if st == nil {
			continue
		}
		for _, sk := range st.Skills {
			for _, t := range sk.Targets {
				if t < 1 || t > 12 {
					continue
				}
				if camps[s] == "good" && goodFindSkills[sk.Name] {
					f[s].FindSkillEvents++
					if camps[t] == "wolf" {
						f[s].FindSkillHits++
					}
				}
				if sk.Name == "预言家" {
					checked[t] = 1
					if camps[t] == "wolf" {
						checkedWolf[t] = 1
					}
				}
				if camps[s] == "wolf" {
					targetGod := camps[t] == "good" && godRoles[r.bySeat[t].Role]
					if st.Role == "梦魇" && sk.Name == "梦魇" {
						f[s].NightmareAtt++
						if targetGod {
							f[s].NightmareGod++
						}
					}
					if st.Role == "狼美人" && sk.Name == "狼美人" {
						f[s].CharmAtt++
						if targetGod {
							f[s].CharmGod++
						}
					}
				}
			}
		}
	}
	for s := 1; s <= 12; s++ {
		f[s].CheckedBySeer = checked[s]
		f[s].CheckedAsWolf = checkedWolf[s]
	}

	// —— 身份：平民夜死 / 神职存活 ——
	for s := 1; s <= 12; s++ {
		if camps[s] != "good" {
			continue
		}
		if f[s].Role == "平民" {
			f[s].IsCiv = 1
			if d, ok := deaths[s]; ok && d.Phase == "night" && d.Day >= 2 {
				f[s].CivNightDeath = 1
			}
		} else {
			f[s].IsGod = 1
			if alive[s] {
				f[s].GodAlive = 1
			}
		}
	}

	// —— 对跳 / 站对边 / 警徽（只在真预言家+悍跳同场时）——
	realSeer := 0
	for s := 1; s <= 12; s++ {
		if camps[s] == "good" && r.bySeat[s].Role == "预言家" {
			realSeer = s
			break
		}
	}
	hantiaoWolf := map[int]bool{}
	for s := 1; s <= 12; s++ {
		if camps[s] == "wolf" && r.bySeat[s].Ht == "预言家" {
			hantiaoWolf[s] = true
		}
	}
	duiTiao := realSeer != 0 && len(hantiaoWolf) > 0
	exiled := map[int]bool{}
	for _, d := range an.Deaths {
		if d.Cause == causeExile {
			exiled[d.Seat] = true
		}
	}
	badgeTgt := map[int]int{}
	for _, v := range an.BadgeVotes {
		if !v.Abstain && v.Target >= 1 && v.Target <= 12 {
			badgeTgt[v.Seat] = v.Target
		}
	}
	day1Tgt := map[int]int{}
	if len(days) > 0 {
		for _, v := range an.Votes[strconv.Itoa(days[0])] {
			if !v.Abstain && v.Target >= 1 && v.Target <= 12 {
				day1Tgt[v.Seat] = v.Target
			}
		}
	}
	for s := 1; s <= 12; s++ {
		if camps[s] == "good" && duiTiao && s != realSeer {
			decided := 0
			if t, ok := badgeTgt[s]; ok {
				if t == realSeer {
					decided = 1
				} else if hantiaoWolf[t] {
					decided = -1
				}
			}
			if decided == 0 {
				if t, ok := day1Tgt[s]; ok {
					if hantiaoWolf[t] {
						decided = 1
					} else if t == realSeer {
						decided = -1
					}
				}
			}
			if decided != 0 {
				f[s].ZhanbianAtt = 1
				if decided == 1 {
					f[s].ZhanbianCorrect = 1
					if exiled[s] {
						f[s].ZhanbianExiled = 1
					}
				}
			}
		}
	}

	badgeHeld := len(an.BadgeVotes) > 0
	for s := 1; s <= 12; s++ {
		if !badgeHeld {
			continue
		}
		if d, dead := deaths[s]; dead && d.Day == 1 && d.Phase == "night" {
			continue // 夜1死者赶不上警徽竞选
		}
		f[s].BadgePresent = 1
		if _, voted := badgeTgt[s]; voted {
			f[s].BadgeCast = 1
		}
	}

	if duiTiao {
		alive1 := func(seat int) bool { d, ok := deaths[seat]; return !ok || d.Day >= 2 }
		goodDied1 := false
		for s := 1; s <= 12; s++ {
			if camps[s] == "good" {
				if d, ok := deaths[s]; ok && d.Day == 1 {
					goodDied1 = true
					break
				}
			}
		}
		hantAllRemoved := true
		for w := range hantiaoWolf {
			if alive1(w) {
				hantAllRemoved = false
			}
		}
		f[realSeer].SeerDuel = 1
		if alive1(realSeer) && hantAllRemoved {
			f[realSeer].SeerDuelWin = 1
		}
		for w := range hantiaoWolf {
			f[w].HantiaoDuel = 1
			if alive1(w) && goodDied1 {
				f[w].HantiaoDuelWin = 1
			}
		}
		for s := 1; s <= 12; s++ {
			if s == realSeer || hantiaoWolf[s] {
				continue
			}
			if t, ok := badgeTgt[s]; ok {
				f[s].BadgeDuelVote = 1
				if t == realSeer {
					f[s].BadgeSeerHit = 1
				} else if hantiaoWolf[t] {
					f[s].BadgeHantiaoHit = 1
				}
			}
		}
	}

	return &GameFacts{Victory: r.Victory, Seats: f}, nil
}

func sortInts(a []int) {
	for i := 1; i < len(a); i++ {
		for j := i; j > 0 && a[j-1] > a[j]; j-- {
			a[j-1], a[j] = a[j], a[j-1]
		}
	}
}
