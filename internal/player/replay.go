// replay.go —— player 包的单局复盘计算层：解析双重编码 form2，基于“身份全公开”推算
// 客观事实（花名册/每日加权放逐/死亡序列/最终存活），只产出数字与 key，中文/配色由页面负责。
// 规则依据：官方《华山论剑选手执行手册2026》七套版型 + memory:huashan-game-rules。
// 数据事实（真实对局核实）：form2 无出局字段；vote "*N"=警长1.5票、"-1"=弃票；
// 技能 {day,name,target_seats}(旧局无 light)，昼夜按技能名判定：猎人枪/侦探翻/骑士骑=白天，其余=夜间。
package player

import (
	"encoding/json"
	"errors"
	"sort"
	"strconv"
	"strings"
)

// —— 输出模型（analysis：只含数字/key）——

type Analysis struct {
	Roster Roster            `json:"roster"`
	Votes  map[string][]Vote `json:"votes"` // 天 → 归一后的投票
	Exile  map[string]Exile  `json:"exile"` // 天 → 放逐结果
	Deaths []Death           `json:"deaths"`
	Alive  []int             `json:"alive_final"`
}

type Roster struct {
	Wolf []int `json:"wolf"`
	Gods []int `json:"gods"`
	Civ  []int `json:"civ"`
}

// Vote：seat 投给 target(座位号，0=无)；weight 权重(警长1.5)；abstain 弃票。
type Vote struct {
	Seat    int     `json:"seat"`
	Target  int     `json:"target"`
	Weight  float64 `json:"weight"`
	Abstain bool    `json:"abstain"`
	Badge   bool    `json:"badge"` // 是否警长票(1.5)
}

type Exile struct {
	Seat     int     `json:"seat"`     // 放逐座位；0=无(平安白天/未结算)
	Peaceful bool    `json:"peaceful"` // 平安白天(加权平票或无票)
	Tally    []Tally `json:"tally"`    // 得票统计(降序)
}
type Tally struct {
	Seat  int     `json:"seat"`
	Votes float64 `json:"votes"`
}

// Death：一次出局。phase night/day；cause 见下方常量；doubt=与投票在场信号冲突时置真。
type Death struct {
	Seat  int    `json:"seat"`
	Day   int    `json:"day"`
	Phase string `json:"phase"`
	Cause string `json:"cause"`
	Doubt bool   `json:"doubt"`
}

const (
	causeKnife       = "knife"           // 狼刀
	causePoison      = "poison"          // 女巫毒
	causeGuardWitch  = "guard_witch"     // 同守同救
	causeExile       = "exile"           // 放逐
	causeSelfDestr   = "self_destruct"   // 自爆
	causeHunterShot  = "hunter_shot"     // 猎人开枪带走
	causeDuel        = "duel"            // 骑士决斗
	causeDemonHunter = "demon_hunter"    // 猎魔人狩猎(反噬)
	causeDetective   = "detective"       // 侦探指定
	causeDogBite     = "dog_bite"        // 警犬撕咬
	causeGargoyle    = "gargoyle"        // 石像鬼猎杀
	causeDream       = "dream"           // 摄梦致死/连带
	causeWolfKing    = "wolfking_take"   // 狼王带人
	causeWolfBeauty  = "wolfbeauty_link" // 狼美人连人
)

// —— 解析后的单局模型 ——

type replay struct {
	Day     int
	Victory int
	MVPSeat int
	SVPSeat int
	Seats   []*seat
	bySeat  map[int]*seat
}

type seat struct {
	Seat   int
	Role   string
	Name   string
	Sect   string
	Skills []skill
	Votes  map[int]Vote // day → vote(已归一)
	Jinhui int          // vote_jinhui 目标(警徽竞选投票)，0 无
	DayHt  int          // day_of_hantiao
	Ht     string       // hantiao_rpt_name
	Zibao  int          // 自爆的天(0 无)
	Good   bool
	Wolf   bool
}

type skill struct {
	Day     int
	Name    string
	Targets []int
}

// isDaySkill：白天主动技能(猎人开枪/侦探指定/骑士决斗)按技能名判定阶段，
// 不依赖 light 字段——旧赛季 form2 无 light，缺失会被误判为夜间而漏结算。
func isDaySkill(name string) bool {
	return strings.Contains(name, "猎人") || strings.Contains(name, "侦探") || strings.Contains(name, "骑士")
}

// —— 解析 form2 ——

func parseReplay(top map[string]json.RawMessage) (*replay, bool) {
	f2raw, ok := top["form2"]
	if !ok {
		return nil, false
	}
	// form2 可能是“双重编码的 JSON 字符串”，也可能已是对象；两种都兼容。
	var inner []byte
	var s string
	if json.Unmarshal(f2raw, &s) == nil {
		inner = []byte(s)
	} else {
		inner = f2raw
	}
	var f2 struct {
		Rows []map[string]json.RawMessage `json:"rows"`
	}
	if err := json.Unmarshal(inner, &f2); err != nil || len(f2.Rows) == 0 {
		return nil, false
	}
	r := &replay{
		Day:     jnum(top["day"]),
		Victory: jnum(top["victory_camp"]),
		MVPSeat: jnum(top["mvp_seat"]),
		SVPSeat: jnum(top["svp_seat"]),
		bySeat:  map[int]*seat{},
	}
	maxDay := r.Day
	seen := map[int]bool{}
	for _, row := range f2.Rows {
		st, err := parseSeat(row)
		if err != nil || seen[st.Seat] {
			// 任一行结构损坏 / 座位号重复 → 整局放弃分析、回退原始渲染，
			// 绝不用残缺数据产出“看似可信”的错误花名册/死亡/存活。
			return nil, false
		}
		seen[st.Seat] = true
		r.Seats = append(r.Seats, st)
		r.bySeat[st.Seat] = st
		for d := range st.Votes {
			if d > maxDay {
				maxDay = d
			}
		}
		for _, k := range st.Skills {
			if k.Day > maxDay {
				maxDay = k.Day
			}
		}
	}
	// 必须是完整且唯一的 12 座（WME 各版型均为 12 人）；座位缺失/越界/不足 → 放弃分析、回退。
	if len(r.Seats) != 12 {
		return nil, false
	}
	for s := 1; s <= 12; s++ {
		if !seen[s] {
			return nil, false
		}
	}
	if r.Day <= 0 {
		r.Day = maxDay
	}
	return r, true
}

var errBadSeat = errors.New("replay: malformed seat row")

func parseSeat(row map[string]json.RawMessage) (*seat, error) {
	st := &seat{
		Seat:   jnum(row["seat"]),
		Role:   jstr(row["rpt_name"]),
		Name:   jstr(row["player_name"]),
		Sect:   jstr(row["sect_name"]),
		Jinhui: jnum(row["vote_jinhui"]),
		DayHt:  jnum(row["day_of_hantiao"]),
		Ht:     jstr(row["hantiao_rpt_name"]),
		Votes:  map[int]Vote{},
	}
	if st.Seat == 0 || st.Role == "" {
		return nil, errBadSeat // 无座位号/身份：数据损坏
	}
	st.Good = isGood(st.Role)
	st.Wolf = !st.Good
	// 技能（结构异常即报错 → 整局回退，不静默吞掉）
	if sr, ok := row["skills"]; ok && len(sr) > 0 {
		var sk []struct {
			Day     int               `json:"day"`
			Name    string            `json:"name"`
			Targets []json.RawMessage `json:"target_seats"`
		}
		if err := json.Unmarshal(sr, &sk); err != nil {
			return nil, err
		}
		for _, k := range sk {
			var ts []int
			for _, t := range k.Targets {
				if n := jnum(t); n != 0 {
					ts = append(ts, n)
				}
			}
			if len(ts) == 0 || k.Name == "" {
				continue
			}
			st.Skills = append(st.Skills, skill{Day: k.Day, Name: k.Name, Targets: ts})
		}
	}
	// 投票 vote_dayN（"*N"=警长1.5、"-1"=弃票、""/0/缺失=未投）
	for d := 1; d <= 8; d++ {
		v, ok := row["vote_day"+strconv.Itoa(d)]
		if !ok {
			continue
		}
		raw := strings.Trim(jstr(v), " ")
		if raw == "" || raw == "0" {
			continue
		}
		vote := Vote{Seat: st.Seat, Weight: 1}
		if strings.HasPrefix(raw, "*") {
			vote.Weight, vote.Badge = 1.5, true
			raw = strings.TrimPrefix(raw, "*")
		}
		if raw == "-1" {
			vote.Abstain = true
		} else if n, err := strconv.Atoi(raw); err == nil && n > 0 {
			vote.Target = n
		} else {
			continue
		}
		st.Votes[d] = vote
	}
	// 自爆
	for d := 1; d <= 8; d++ {
		if b, ok := row["zibao"+strconv.Itoa(d)]; ok {
			var flag bool
			json.Unmarshal(b, &flag)
			if flag {
				st.Zibao = d
				break
			}
		}
	}
	return st, nil
}

// —— 结算 ——

// withAnalysis 在原始牌局 JSON 上附加 analysis 字段；任何解析失败都原样返回原始字节(页面回退旧渲染)。
func withAnalysis(raw []byte) []byte {
	var top map[string]json.RawMessage
	if err := json.Unmarshal(raw, &top); err != nil {
		return raw
	}
	an, ok := analyze(top)
	if !ok {
		return raw
	}
	b, err := json.Marshal(an)
	if err != nil {
		return raw
	}
	top["analysis"] = b
	out, err := json.Marshal(top)
	if err != nil {
		return raw
	}
	return out
}

func analyze(top map[string]json.RawMessage) (*Analysis, bool) {
	r, ok := parseReplay(top)
	if !ok {
		return nil, false
	}
	an := &Analysis{
		Votes: map[string][]Vote{},
		Exile: map[string]Exile{},
	}
	an.Roster = r.roster()
	r.fillVotes(an)
	dead := r.resolveDeaths(an) // 内部同时填 Exile；返回死亡座位集合
	// 最终存活
	for _, st := range r.Seats {
		if !dead[st.Seat] {
			an.Alive = append(an.Alive, st.Seat)
		}
	}
	sort.Ints(an.Alive)
	return an, true
}

func (r *replay) roster() Roster {
	var ro Roster
	for _, st := range r.Seats {
		switch {
		case st.Wolf:
			ro.Wolf = append(ro.Wolf, st.Seat)
		case st.Role == "平民":
			ro.Civ = append(ro.Civ, st.Seat)
		default:
			ro.Gods = append(ro.Gods, st.Seat)
		}
	}
	sort.Ints(ro.Wolf)
	sort.Ints(ro.Gods)
	sort.Ints(ro.Civ)
	return ro
}

func (r *replay) fillVotes(an *Analysis) {
	for d := 1; d <= r.Day; d++ {
		var vs []Vote
		for _, st := range r.Seats {
			if v, ok := st.Votes[d]; ok {
				vs = append(vs, v)
			}
		}
		if len(vs) == 0 {
			continue
		}
		sort.Slice(vs, func(i, j int) bool { return vs[i].Seat < vs[j].Seat })
		an.Votes[strconv.Itoa(d)] = vs
	}
}

// 加权计票 → 放逐座位(唯一最高)或平安白天(平票)。
func (r *replay) exileOf(d int) Exile {
	sum := map[int]float64{}
	for _, st := range r.Seats {
		if v, ok := st.Votes[d]; ok && !v.Abstain && v.Target != 0 {
			sum[v.Target] += v.Weight
		}
	}
	var tally []Tally
	for s, w := range sum {
		tally = append(tally, Tally{Seat: s, Votes: w})
	}
	sort.Slice(tally, func(i, j int) bool {
		if tally[i].Votes != tally[j].Votes {
			return tally[i].Votes > tally[j].Votes
		}
		return tally[i].Seat < tally[j].Seat
	})
	ex := Exile{Tally: tally}
	if len(tally) == 0 {
		ex.Peaceful = true
		return ex
	}
	if len(tally) == 1 || tally[0].Votes > tally[1].Votes {
		ex.Seat = tally[0].Seat
	} else {
		ex.Peaceful = true // 加权最高票并列 → 平安白天
	}
	return ex
}

// resolveDeaths：按天推进(先夜后昼)，产出死亡时间线并回填 Exile；返回死亡座位集合。
func (r *replay) resolveDeaths(an *Analysis) map[int]bool {
	dead := map[int]bool{}
	kill := func(seat, day int, phase, cause string) {
		if seat == 0 || dead[seat] {
			return
		}
		dead[seat] = true
		an.Deaths = append(an.Deaths, Death{Seat: seat, Day: day, Phase: phase, Cause: cause})
	}
	smallWolvesDead := func() bool { // 三只小狼(纯"狼")是否全出局(石像鬼开刀条件)
		for _, st := range r.Seats {
			if st.Role == "狼" && !dead[st.Seat] {
				return false
			}
		}
		return true
	}
	prevDream := 0 // 摄梦人上一晚目标(判双摄致死)

	for d := 1; d <= r.Day; d++ {
		// —— 夜 d ——
		var knifeTargets []int
		saves, guards := map[int]bool{}, map[int]bool{}
		var poison []int
		dream := 0
		dreamSeat := 0
		nightmareBlocks := false // 梦魇恐惧到狼队友 → 当晚狼不能杀人
		type special struct {
			role    string
			seat    int
			targets []int
		}
		var specials []special
		for _, st := range r.Seats {
			for _, k := range st.Skills {
				if k.Day != d || isDaySkill(k.Name) {
					continue
				}
				switch {
				case k.Name == "狼刀":
					knifeTargets = append(knifeTargets, k.Targets...)
				case k.Name == "女巫解":
					for _, t := range k.Targets {
						saves[t] = true
					}
				case k.Name == "女巫毒":
					poison = append(poison, k.Targets...)
				case k.Name == "守卫":
					for _, t := range k.Targets {
						guards[t] = true
					}
				case k.Name == "摄梦人":
					dream, dreamSeat = k.Targets[0], st.Seat
				case k.Name == "梦魇":
					if tgt := r.bySeat[k.Targets[0]]; tgt != nil && tgt.Wolf {
						nightmareBlocks = true
					}
				case k.Name == "预言家":
					// 查验，无出局
				default:
					specials = append(specials, special{role: st.Role, seat: st.Seat, targets: k.Targets})
				}
			}
		}
		// 狼刀合并：号码统一才成刀，否则掰刀/空刀；梦魇封狼则本晚无刀
		knife := consensus(knifeTargets)
		if nightmareBlocks {
			knife = 0
		}
		immune := func(t int) bool { return t == dream } // 梦游者免疫夜伤

		// 狼刀结算
		if knife != 0 && !immune(knife) {
			switch {
			case saves[knife] && guards[knife]:
				kill(knife, d, "night", causeGuardWitch) // 同守同救 → 死
			case saves[knife] || guards[knife]:
				// 救回/守回 → 平安
			default:
				kill(knife, d, "night", causeKnife)
			}
		}
		// 女巫毒(无视守卫；梦游者免疫)
		for _, t := range poison {
			if !immune(t) {
				kill(t, d, "night", causePoison)
			}
		}
		// 版型特殊夜间击杀
		for _, sp := range specials {
			t := sp.targets[0]
			switch sp.role {
			case "猎魔人": // 中狼→狼死；中好人→猎魔人自死
				if tgt := r.bySeat[t]; tgt != nil && tgt.Wolf {
					kill(t, d, "night", causeDemonHunter)
				} else {
					kill(sp.seat, d, "night", causeDemonHunter)
				}
			case "石像鬼": // 三小狼全死后才是猎杀，否则查验
				if smallWolvesDead() && !immune(t) {
					kill(t, d, "night", causeGargoyle)
				}
				// 警犬撕咬在下方按技能 name 单独扫描；查验/狼美人连人/梦魇恐惧无直接夜间出局
			}
		}
		// 警犬撕咬需按技能 name 判断（撕咬=杀、查验=无）；撕咬恒为夜间行为
		for _, st := range r.Seats {
			for _, k := range st.Skills {
				if k.Day == d && strings.Contains(k.Name, "撕咬") {
					kill(k.Targets[0], d, "night", causeDogBite)
				}
			}
		}
		// 摄梦致死：连续两晚摄同一人
		if dream != 0 && dream == prevDream {
			kill(dream, d, "night", causeDream)
		}
		// 摄梦人夜里死亡 → 梦游者同死
		if dreamSeat != 0 && dead[dreamSeat] && dream != 0 {
			kill(dream, d, "night", causeDream)
		}
		prevDream = dream

		// —— 昼 d ——
		// 白天主动技能：侦探翻(替代放逐)、骑士决斗、猎人开枪
		detectiveKill, knightKilledWolf, hunterShots := 0, false, []int(nil)
		var knightSelf int
		for _, st := range r.Seats {
			for _, k := range st.Skills {
				if k.Day != d || !isDaySkill(k.Name) {
					continue
				}
				switch {
				case strings.Contains(k.Name, "侦探"):
					detectiveKill = k.Targets[0]
				case strings.Contains(k.Name, "骑士"):
					if tgt := r.bySeat[k.Targets[0]]; tgt != nil && tgt.Wolf {
						kill(k.Targets[0], d, "day", causeDuel)
						knightKilledWolf = true
					} else {
						knightSelf = st.Seat
					}
				case strings.Contains(k.Name, "猎人"):
					hunterShots = append(hunterShots, k.Targets...)
				}
			}
		}
		if knightSelf != 0 {
			kill(knightSelf, d, "day", causeDuel) // 决斗到好人 → 骑士白天死
		}

		// 自爆(直接入夜，无放逐)
		zibaoThisDay := false
		for _, st := range r.Seats {
			if st.Zibao == d {
				kill(st.Seat, d, "day", causeSelfDestr)
				zibaoThisDay = true
			}
		}

		// 放逐：侦探指定 / 骑士杀狼 / 自爆 任一发生则当天无常规放逐
		switch {
		case detectiveKill != 0:
			// 怪盗狼王技能态免疫侦探指定——无 fixture 判据，暂直接结算
			kill(detectiveKill, d, "day", causeDetective)
		case knightKilledWolf || zibaoThisDay:
			// 直接入夜，无放逐
		default:
			ex := r.exileOf(d)
			an.Exile[strconv.Itoa(d)] = ex
			if ex.Seat != 0 {
				if st := r.bySeat[ex.Seat]; st != nil && st.Role == "白痴" {
					// 白痴被放逐：翻牌不死、失投票权，不计入死亡
				} else {
					kill(ex.Seat, d, "day", causeExile)
				}
			}
		}

		// 猎人开枪带走(白天技能，死者可选开枪)
		for _, t := range hunterShots {
			kill(t, d, "day", causeHunterShot)
		}
	}

	// —— 死亡连带（狼美人连人 / 狼王·白狼王带人）：在本人出局的“同一天同一阶段”结算，
	// 目标取其在死亡日之前(含当天)最近一次指定。狼美人夜里被杀时连人也应记在当夜。——
	deathOf := func(seat int) *Death {
		for i := range an.Deaths {
			if an.Deaths[i].Seat == seat {
				return &an.Deaths[i]
			}
		}
		return nil
	}
	// canTake：本人以该死因出局时是否触发连带。狼美人任意出局都连；狼王除自爆/毒外可带；
	// 白狼王为主动技能，被放逐不能发动，被毒/自爆亦不带。
	settleLinked := func(role, cause string, isLink func(skill) bool, canTake func(string) bool) {
		for _, st := range r.Seats {
			if st.Role != role {
				continue
			}
			dth := deathOf(st.Seat)
			if dth == nil || !canTake(dth.Cause) { // 未出局 / 该死因不触发带人
				continue
			}
			link, linkDay := 0, 0
			for _, k := range st.Skills {
				if isLink(k) && len(k.Targets) > 0 && k.Day <= dth.Day && k.Day >= linkDay {
					link, linkDay = k.Targets[0], k.Day
				}
			}
			if link != 0 {
				kill(link, dth.Day, dth.Phase, cause)
			}
		}
	}
	always := func(string) bool { return true }
	wolfKingTake := func(c string) bool { return c != causeSelfDestr && c != causePoison }
	whiteWolfKingTake := func(c string) bool { return c != causeSelfDestr && c != causePoison && c != causeExile }
	notKnife := func(k skill) bool { return k.Name != "狼刀" }
	settleLinked("狼美人", causeWolfBeauty, func(k skill) bool { return k.Name == "狼美人" }, always)
	// 狼王/白狼王“带人”无 fixture 佐证编码：本人出局且有非狼刀的指定技能即视为带人（受死因限制）。
	settleLinked("狼王", causeWolfKing, notKnife, wolfKingTake)
	settleLinked("白狼王", causeWolfKing, notKnife, whiteWolfKingTake)

	// 死亡序列按 天 → 阶段(夜先于昼) 稳定排序：连带死亡是全程模拟后统一追加的，
	// 若不排序，早于当前天的连带会排到后面，前端按数组顺序渲染时间线就会乱序。
	sort.SliceStable(an.Deaths, func(i, j int) bool {
		a, b := an.Deaths[i], an.Deaths[j]
		if a.Day != b.Day {
			return a.Day < b.Day
		}
		return phaseRank(a.Phase) < phaseRank(b.Phase)
	})

	// —— 投票在场交叉校验：某座在第 d 天投过票=经历了当天白天(存活至放逐)。
	// 冲突判定按阶段：投票日 > 死亡日 必冲突；投票日 == 死亡日且死于当夜也冲突(夜死无法当天投票)。——
	voteDays := map[int]map[int]bool{}
	for _, st := range r.Seats {
		for d := range st.Votes {
			if voteDays[st.Seat] == nil {
				voteDays[st.Seat] = map[int]bool{}
			}
			voteDays[st.Seat][d] = true
		}
	}
	for i := range an.Deaths {
		dth := &an.Deaths[i]
		for vd := range voteDays[dth.Seat] {
			if vd > dth.Day || (vd == dth.Day && dth.Phase == "night") {
				dth.Doubt = true
				break
			}
		}
	}
	return dead
}

// phaseRank：同一天内夜先于昼（用于死亡序列稳定排序）。
func phaseRank(p string) int {
	if p == "night" {
		return 0
	}
	return 1
}

// consensus：狼刀号码统一才成刀；不统一(掰刀)或空 → 0。
func consensus(ts []int) int {
	if len(ts) == 0 {
		return 0
	}
	first := ts[0]
	for _, t := range ts {
		if t != first {
			return 0
		}
	}
	return first
}

// —— 小工具：从 RawMessage 取数字/字符串（容错 数字/字符串/null）——

func jnum(raw json.RawMessage) int {
	if len(raw) == 0 {
		return 0
	}
	var n jsonNum
	if n.UnmarshalJSON(raw); n.set {
		return int(n.v)
	}
	return 0
}

func jstr(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var n json.Number
	if json.Unmarshal(raw, &n) == nil {
		return n.String()
	}
	return ""
}
