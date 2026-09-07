package player

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func loadAnalysis(t *testing.T, name string) *Analysis {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Skipf("fixture %s missing: %v", name, err)
	}
	var top map[string]json.RawMessage
	if err := json.Unmarshal(raw, &top); err != nil {
		t.Fatalf("bad fixture json: %v", err)
	}
	an, ok := analyze(top)
	if !ok {
		t.Fatalf("analyze(%s) failed", name)
	}
	return an
}

// death 查找某座位的出局记录。
func death(an *Analysis, seat int) *Death {
	for i := range an.Deaths {
		if an.Deaths[i].Seat == seat {
			return &an.Deaths[i]
		}
	}
	return nil
}

func hasDeath(an *Analysis, seat, day int, phase, cause string) bool {
	d := death(an, seat)
	return d != nil && d.Day == day && d.Phase == phase && d.Cause == cause
}

func alive(an *Analysis, seat int) bool {
	for _, s := range an.Alive {
		if s == seat {
			return true
		}
	}
	return false
}

// golden：预女猎白 44268（狼胜），完整死亡序列与放逐已手工复盘。
func TestReplay_Golden44268(t *testing.T) {
	an := loadAnalysis(t, "game_44268.json")

	if got := an.Roster.Wolf; len(got) != 4 || got[0] != 1 || got[3] != 12 {
		t.Errorf("wolf roster = %v, want [1 3 8 12]", got)
	}
	// 放逐：D1=8, D2=12, D3=1, D4 平安白天
	if ex := an.Exile["1"]; ex.Seat != 8 {
		t.Errorf("D1 exile=%d, want 8", ex.Seat)
	}
	if ex := an.Exile["2"]; ex.Seat != 12 {
		t.Errorf("D2 exile=%d, want 12", ex.Seat)
	}
	if ex := an.Exile["3"]; ex.Seat != 1 {
		t.Errorf("D3 exile=%d, want 1", ex.Seat)
	}
	if ex := an.Exile["4"]; !ex.Peaceful {
		t.Errorf("D4 should be peaceful, got exile=%d", ex.Seat)
	}

	// 死亡序列（含 N1 狼刀9 被女巫救 → 无夜1死亡）
	wantDeaths := []struct {
		seat, day    int
		phase, cause string
	}{
		{8, 1, "day", causeExile},
		{4, 2, "night", causeKnife},
		{12, 2, "day", causeExile},
		{2, 3, "night", causeKnife},
		{11, 3, "night", causePoison},
		{1, 3, "day", causeExile},
		{9, 4, "night", causeKnife},
	}
	for _, w := range wantDeaths {
		if !hasDeath(an, w.seat, w.day, w.phase, w.cause) {
			t.Errorf("missing death seat%d D%d %s %s; got %+v", w.seat, w.day, w.phase, w.cause, death(an, w.seat))
		}
	}
	if death(an, 9) == nil || death(an, 9).Cause != causeKnife {
		t.Errorf("seat9 should die by knife N4 (was saved N1)")
	}
	// N1 平安夜：无第1天夜间死亡
	for _, d := range an.Deaths {
		if d.Day == 1 && d.Phase == "night" {
			t.Errorf("N1 should be peaceful, got death %+v", d)
		}
	}
	// 最终存活：3(狼) 5 6 7 10
	for _, s := range []int{3, 5, 6, 7, 10} {
		if !alive(an, s) {
			t.Errorf("seat%d should be alive_final", s)
		}
	}
	if alive(an, 1) || alive(an, 9) {
		t.Errorf("dead seats leaked into alive_final")
	}
	for _, d := range an.Deaths {
		if d.Doubt {
			t.Errorf("unexpected doubt on %+v", d)
		}
	}
}

// 投票归一：警长 * = 1.5票；-1 = 弃票。
func TestReplay_VoteNormalize(t *testing.T) {
	an := loadAnalysis(t, "game_44268.json")
	find := func(day, seat int) *Vote {
		for i, v := range an.Votes[itoa(day)] {
			if v.Seat == seat {
				return &an.Votes[itoa(day)][i]
			}
		}
		return nil
	}
	if v := find(1, 4); v == nil || v.Target != 8 || v.Weight != 1.5 || !v.Badge {
		t.Errorf("D1 seat4 vote = %+v, want target8 weight1.5 badge", v)
	}
	if v := find(4, 6); v == nil || !v.Abstain {
		t.Errorf("D4 seat6 should be abstain(-1), got %+v", v)
	}
}

// 各版型关键结算点。
func TestReplay_HunterShot(t *testing.T) { // 石像鬼守墓人：猎人D3开枪带走4号狼
	an := loadAnalysis(t, "game_42420.json")
	if !hasDeath(an, 4, 3, "day", causeHunterShot) {
		t.Errorf("seat4 should die by hunter_shot D3; got %+v", death(an, 4))
	}
	if death(an, 3) == nil || death(an, 3).Cause != causeExile { // 石像鬼被放逐、未开刀
		t.Errorf("gargoyle seat3 should be exiled, got %+v", death(an, 3))
	}
}

func TestReplay_KnightDuel(t *testing.T) { // 狼美骑士：骑士决斗好人自死；狼美人连人
	an := loadAnalysis(t, "game_42388.json")
	if !hasDeath(an, 10, 1, "day", causeDuel) {
		t.Errorf("knight seat10 should self-die by duel D1; got %+v", death(an, 10))
	}
	if !hasDeath(an, 1, 5, "day", causeWolfBeauty) {
		t.Errorf("seat1 should die by wolfbeauty_link D5; got %+v", death(an, 1))
	}
}

func TestReplay_Detective(t *testing.T) { // 侦探怪盗：侦探D1指定9号、当天无常规放逐
	an := loadAnalysis(t, "game_44297.json")
	if !hasDeath(an, 9, 1, "day", causeDetective) {
		t.Errorf("seat9 should die by detective D1; got %+v", death(an, 9))
	}
	if _, ok := an.Exile["1"]; ok {
		t.Errorf("D1 should have no regular exile (detective replaced it)")
	}
}

func TestReplay_DreamNoChainOnDayDeath(t *testing.T) { // 狼王摄梦：摄梦人白天被放逐→梦游者不连带死
	an := loadAnalysis(t, "game_42411.json")
	if !hasDeath(an, 9, 1, "day", causeExile) {
		t.Errorf("dreamer seat9 should be exiled D1; got %+v", death(an, 9))
	}
	if !alive(an, 10) { // seat10 是被摄目标，摄梦人非夜死，故存活
		t.Errorf("dream target seat10 should survive (nightmare died by day)")
	}
}

func TestReplay_DemonHunter(t *testing.T) { // 血月猎魔人：猎魔D2狩猎中狼(3号)
	an := loadAnalysis(t, "game_44286.json")
	if !hasDeath(an, 3, 2, "night", causeDemonHunter) {
		t.Errorf("seat3(wolf) should die by demon_hunter D2; got %+v", death(an, 3))
	}
}

// 回退：非法/无 form2 的输入，withAnalysis 原样返回，不注入 analysis。
func TestWithAnalysis_Fallback(t *testing.T) {
	for _, raw := range []string{`not json`, `{"id":1}`, `{"form2":"garbage"}`} {
		out := withAnalysis([]byte(raw))
		if string(out) != raw {
			t.Errorf("fallback for %q returned %q", raw, out)
		}
	}
}

// withAnalysis 对真实局应注入 analysis 字段。
func TestWithAnalysis_Injects(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("testdata", "game_44268.json"))
	if err != nil {
		t.Skip("fixture missing")
	}
	out := withAnalysis(raw)
	var m map[string]json.RawMessage
	if json.Unmarshal(out, &m) != nil || m["analysis"] == nil {
		t.Fatalf("analysis not injected")
	}
}

func itoa(n int) string { return string(rune('0' + n)) } // 仅测试用，天数 1..9

// mkTop：用 rows JSON 造一个带双重编码 form2 的顶层对象（无 fixture 的合成用例）。
func mkTop(rowsJSON string) map[string]json.RawMessage {
	inner := `{"rows":` + rowsJSON + `}`
	b, _ := json.Marshal(inner) // 双重编码成字符串
	return map[string]json.RawMessage{"form2": json.RawMessage(b), "victory_camp": json.RawMessage("1")}
}

// mk12：造完整 12 座牌局（P1 要求座位恰为 1..12）。overrides[seat]=该座字段(不含 seat)，未覆盖填平民。
func mk12(overrides map[int]string) map[string]json.RawMessage {
	parts := make([]string, 0, 12)
	for s := 1; s <= 12; s++ {
		body := overrides[s]
		if body == "" {
			body = `"rpt_name":"平民","skills":[]`
		}
		parts = append(parts, fmt.Sprintf(`{"seat":%d,%s}`, s, body))
	}
	return mkTop("[" + strings.Join(parts, ",") + "]")
}

// P1：行结构损坏/座位重复/座位集合不完整 → 放弃分析（回退），绝不产出残缺复盘。
func TestReplay_ParseFallbackOnBadRow(t *testing.T) {
	if _, ok := analyze(mkTop(`[{"seat":1,"rpt_name":"狼","skills":[]},{"seat":1,"rpt_name":"平民","skills":[]}]`)); ok {
		t.Error("duplicate seats should abort analysis (fallback)")
	}
	if _, ok := analyze(mkTop(`[{"seat":1,"rpt_name":"狼","skills":{"oops":true}}]`)); ok {
		t.Error("malformed skills should abort analysis (fallback)")
	}
	if _, ok := analyze(mkTop(`[{"seat":0,"rpt_name":"狼","skills":[]}]`)); ok {
		t.Error("seat 0 should abort analysis (fallback)")
	}
	// 仅 3 座（不足 12）→ 回退
	if _, ok := analyze(mkTop(`[{"seat":1,"rpt_name":"狼","skills":[]},{"seat":2,"rpt_name":"平民","skills":[]},{"seat":3,"rpt_name":"预言家","skills":[]}]`)); ok {
		t.Error("incomplete seat set (3) should abort analysis (fallback)")
	}
	// 座位越界（13）→ 回退
	if _, ok := analyze(mkTop(`[{"seat":13,"rpt_name":"狼","skills":[]}]`)); ok {
		t.Error("out-of-range seat should abort analysis (fallback)")
	}
	// 完整 12 座 → 正常分析
	if _, ok := analyze(mk12(nil)); !ok {
		t.Error("complete 12-seat game should analyze")
	}
}

// P2：旧格式 form2 无 light 字段时，白天技能(猎人枪)应按技能名判为白天并结算开枪。
func TestReplay_DaySkillWithoutLight(t *testing.T) {
	an, ok := analyze(mk12(map[int]string{
		1: `"rpt_name":"狼","skills":[{"day":1,"name":"狼刀","target_seats":[2]}]`,
		2: `"rpt_name":"猎人","skills":[{"day":1,"name":"猎人枪","target_seats":[1]}]`,
	}))
	if !ok {
		t.Fatal("analyze failed")
	}
	if !hasDeath(an, 2, 1, "night", causeKnife) {
		t.Errorf("hunter(2) should die by knife N1; deaths=%+v", an.Deaths)
	}
	if !hasDeath(an, 1, 1, "day", causeHunterShot) {
		t.Errorf("hunter should shoot seat1 on day1 (name-based classification, no light); deaths=%+v", an.Deaths)
	}
}

// P2：狼美人夜里被杀 → 连人记在“当夜”，且死亡序列按天/阶段排序（连人不排到后面天之后）。
func TestReplay_WolfBeautyNightDeathOrdered(t *testing.T) {
	an, ok := analyze(mk12(map[int]string{
		1: `"rpt_name":"狼美人","skills":[{"day":1,"name":"狼美人","target_seats":[3]}]`,
		2: `"rpt_name":"女巫","skills":[{"day":1,"name":"女巫毒","target_seats":[1]}]`,
		4: `"rpt_name":"狼","skills":[{"day":2,"name":"狼刀","target_seats":[5]}]`,
	}))
	if !ok {
		t.Fatal("analyze failed")
	}
	if !hasDeath(an, 1, 1, "night", causePoison) {
		t.Errorf("wolfbeauty(1) poisoned N1; deaths=%+v", an.Deaths)
	}
	if !hasDeath(an, 3, 1, "night", causeWolfBeauty) {
		t.Errorf("link(3) should die at NIGHT1; deaths=%+v", an.Deaths)
	}
	// 序列有序：连人(第1夜)必须排在第2夜狼刀死亡之前
	iLink, iLater := -1, -1
	for i, d := range an.Deaths {
		if d.Seat == 3 {
			iLink = i
		}
		if d.Seat == 5 {
			iLater = i
		}
	}
	if iLink < 0 || iLater < 0 || iLink > iLater {
		t.Errorf("deaths not chronologically ordered: link idx=%d later idx=%d; %+v", iLink, iLater, an.Deaths)
	}
}

// P2：狼王除自爆/毒外出局带走一人；被毒/自爆不带。
func TestReplay_WolfKingTake(t *testing.T) {
	// 放逐带人
	an, ok := analyze(mk12(map[int]string{
		1: `"rpt_name":"狼王","skills":[{"day":1,"name":"狼王","target_seats":[3]}],"vote_day1":"2"`,
		2: `"rpt_name":"平民","skills":[],"vote_day1":"1"`,
		3: `"rpt_name":"平民","skills":[],"vote_day1":"1"`,
		4: `"rpt_name":"预言家","skills":[],"vote_day1":"1"`,
	}))
	if !ok {
		t.Fatal("analyze failed")
	}
	if !hasDeath(an, 1, 1, "day", causeExile) || !hasDeath(an, 3, 1, "day", causeWolfKing) {
		t.Errorf("exiled wolfking should take seat3; deaths=%+v", an.Deaths)
	}
	// 被毒 → 不带人
	an2, _ := analyze(mk12(map[int]string{
		1: `"rpt_name":"狼王","skills":[{"day":1,"name":"狼王","target_seats":[3]}]`,
		2: `"rpt_name":"女巫","skills":[{"day":1,"name":"女巫毒","target_seats":[1]}]`,
	}))
	if death(an2, 3) != nil {
		t.Errorf("poisoned wolfking must NOT take anyone; got %+v", death(an2, 3))
	}
}

// P3：夜间死亡与“同日投票”冲突应标 doubt；白天出局后同日投票则合理，不标。
func TestReplay_DoubtNightSameDay(t *testing.T) {
	an, ok := analyze(mk12(map[int]string{
		1: `"rpt_name":"狼","skills":[{"day":1,"name":"狼刀","target_seats":[2]}]`,
		2: `"rpt_name":"平民","skills":[],"vote_day1":"1"`, // 第1夜被刀却在第1天投了票 → 冲突
	}))
	if !ok {
		t.Fatal("analyze failed")
	}
	d := death(an, 2)
	if d == nil || d.Phase != "night" || !d.Doubt {
		t.Errorf("seat2 night death with same-day vote should be doubt; got %+v", d)
	}
}
