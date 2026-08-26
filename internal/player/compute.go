// compute.go —— player 包的纯计算层：解析逐场战绩、阵营/门派归类、聚合统计、有序键值抽取。
// 只产出“数值+字段名”，不做任何中文标签/百分比/展示格式化——那些是页面的显示逻辑。
// 规则（阵营归类、门派归并）与前端 format.js 保持一致。
package player

import (
	"bytes"
	"encoding/json"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// —— 阵营/门派规则（与 format.js 一致）——
// 狼阵营特殊身份：无“狼”字但属狼阵营（规则见 memory:huashan-game-rules）。
var wolfside = map[string]bool{"石像鬼": true, "血月使徒": true, "梦魇": true}

func isGood(role string) bool { return !strings.Contains(role, "狼") && !wolfside[role] }

// 门派基础名：去掉尾部「（X）」赛区后缀，用于跨赛区归并同名门派（数据归并，非展示）。
// 导出供赛事聚合层(event 包)复用同一套归并规则——两侧必须产出同一基名，门派成员回连才不会错位。
var sectSuffix = regexp.MustCompile(`[（(][^（()）]*[）)]\s*$`)

func BaseName(s string) string {
	return strings.TrimSpace(sectSuffix.ReplaceAllString(strings.TrimSpace(s), ""))
}

// —— 解析后的单场（供筛选/聚合；渲染仍用对齐的原始 JSON）——
type Game struct {
	GameID        int
	PlayDate      string
	Round         int
	SectID        int
	PlayerID      int
	SeasonID      int
	HasSeason     bool
	SeasonTypeID  int
	SectRaw       string
	SectBase      string
	Edition       string
	Role          string
	Point         float64
	Win           bool
	MVP, SVP, BGX bool
	Good          bool
}

// gameIndex 是某选手某赛区的内存索引：解析结果与原始 JSON 一一对齐，trunc 表示是否触达安全上限。
type gameIndex struct {
	games []Game
	raw   []json.RawMessage
	trunc bool
}

// jsonNum 兼容 数字 / 字符串数字 / null 的数值字段（官方接口偶尔用字符串装数字）。
// 非数字内容按“未设置”容错处理，不使整条战绩解析失败（真正的截断/非法 JSON 由上层 Unmarshal 报错）。
type jsonNum struct {
	v   float64
	set bool
}

func (n *jsonNum) UnmarshalJSON(b []byte) error {
	s := strings.TrimSpace(string(b))
	if s == "" || s == "null" {
		return nil
	}
	s = strings.Trim(s, `"`)
	if s == "" {
		return nil
	}
	switch s { // 官方个别字段(win/mvp/svp/bgx)可能是 JSON 布尔，按 1/0 归一
	case "true":
		n.v, n.set = 1, true
		return nil
	case "false":
		n.v, n.set = 0, true
		return nil
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return nil
	}
	n.v, n.set = f, true
	return nil
}

// wireGame 是逐场原始 JSON 里真正会用到的 9 个字段（专用结构，避免 map[string]any 的哈希/装箱/分配开销）。
type wireGame struct {
	GameID     jsonNum `json:"game_id"`
	PlayDate   string  `json:"play_date"`
	Round      jsonNum `json:"round"`
	SectID     jsonNum `json:"sect_id"`
	PlayerID   jsonNum `json:"player_id"`
	Season     jsonNum `json:"season_id"`
	SeasonType jsonNum `json:"season_type_id"`
	Sect       string  `json:"sect_name"`
	Edition    string  `json:"edition_name"`
	Role       string  `json:"rpt_name"`
	Point      jsonNum `json:"total_point"`
	Win        jsonNum `json:"win"`
	MVP        jsonNum `json:"mvp"`
	SVP        jsonNum `json:"svp"`
	BGX        jsonNum `json:"bgx"`
}

// parseGame 解析单场；JSON 非法(如截断/字段结构异常)时返回错误，交由上层拒绝整份数据、绝不当成空场次静默缓存。
func parseGame(raw json.RawMessage) (Game, error) {
	var w wireGame
	if err := json.Unmarshal(raw, &w); err != nil {
		return Game{}, err
	}
	g := Game{
		GameID:       int(w.GameID.v),
		PlayDate:     w.PlayDate,
		Round:        int(w.Round.v),
		SectID:       int(w.SectID.v),
		PlayerID:     int(w.PlayerID.v),
		SeasonTypeID: int(w.SeasonType.v),
		Edition:      w.Edition,
		Role:         w.Role,
		SectRaw:      w.Sect,
		Point:        w.Point.v,
		Win:          w.Win.v == 1,
		MVP:          w.MVP.v == 1,
		SVP:          w.SVP.v == 1,
		BGX:          w.BGX.v == 1,
		Good:         isGood(w.Role),
	}
	g.SectBase = BaseName(w.Sect)
	if w.Season.set {
		g.SeasonID, g.HasSeason = int(w.Season.v), true
	}
	return g, nil
}

// KV 是一条“字段名 → 数值”（Val 为数字/字符串/nil 的原样值）。中文标签与百分比格式化在页面完成。
type KV struct {
	Key string `json:"key"`
	Val any    `json:"val"`
}

// —— 聚合 ——
type agg struct {
	n                  int
	tp                 float64
	win, mvp, svp, bgx int
}

func aggregate(games []Game, idx []int) agg {
	var a agg
	for _, i := range idx {
		g := games[i]
		a.n++
		a.tp += g.Point
		if g.Win {
			a.win++
		}
		if g.MVP {
			a.mvp++
		}
		if g.SVP {
			a.svp++
		}
		if g.BGX {
			a.bgx++
		}
	}
	return a
}

// Round2 四舍五入到两位小数。导出供赛事聚合层(event 包)复用同一口径。
func Round2(x float64) float64 { return math.Round(x*100) / 100 }

// kv 把聚合结果转成有序键值（键序与前端 computeAgg 期望一致）；空场次返回 nil。数值为原始数字，页面负责加“%”与标签。
func (a agg) kv() []KV {
	if a.n == 0 {
		return nil
	}
	return []KV{
		{"round_total", a.n},
		{"total_point", Round2(a.tp)},
		{"round_point_avg", Round2(a.tp / float64(a.n))},
		{"win_pct", math.Round(float64(a.win) / float64(a.n) * 100)},
		{"mvp_num", a.mvp},
		{"svp_num", a.svp},
		{"bgx_num", a.bgx},
	}
}

// RoleRow 是角色维度的一行（纯数值，默认按场次降序；排序交由页面）。
type RoleRow struct {
	Role string  `json:"role"`
	N    int     `json:"n"`
	Avg  float64 `json:"avg"`
	Win  int     `json:"win"`
	MVP  int     `json:"mvp"`
	SVP  int     `json:"svp"`
	BGX  int     `json:"bgx"`
}

// EditionRow 是版型维度的一行。Molang 为该版型下摸到狼人阵营身份的场次占比(%)——
// 狼人阵营口径同 isGood：含「狼」字或属 石像鬼/血月使徒/梦魇。
type EditionRow struct {
	Edition string  `json:"edition"`
	N       int     `json:"n"`
	Avg     float64 `json:"avg"`
	Win     int     `json:"win"`
	Molang  int     `json:"molang"`
	MVP     int     `json:"mvp"`
	SVP     int     `json:"svp"`
	BGX     int     `json:"bgx"`
}

// roleBreakdown 按身份聚合，默认按场次降序（页面可再按任意列排序）。
func roleBreakdown(games []Game, idx []int) []RoleRow {
	type acc struct {
		n, win, mvp, svp, bgx int
		tp                    float64
	}
	m := map[string]*acc{}
	var order []string
	for _, i := range idx {
		g := games[i]
		r := g.Role
		if r == "" {
			r = "—"
		}
		a := m[r]
		if a == nil {
			a = &acc{}
			m[r] = a
			order = append(order, r)
		}
		a.n++
		a.tp += g.Point
		if g.Win {
			a.win++
		}
		if g.MVP {
			a.mvp++
		}
		if g.SVP {
			a.svp++
		}
		if g.BGX {
			a.bgx++
		}
	}
	rows := make([]RoleRow, 0, len(order))
	for _, r := range order {
		a := m[r]
		rows = append(rows, RoleRow{
			Role: r, N: a.n, Avg: Round2(a.tp / float64(a.n)),
			Win: int(math.Round(float64(a.win) / float64(a.n) * 100)),
			MVP: a.mvp, SVP: a.svp, BGX: a.bgx,
		})
	}
	sort.SliceStable(rows, func(i, j int) bool { return rows[i].N > rows[j].N })
	return rows
}

// editionBreakdown 按版型聚合，缺少版型名的历史记录不参与，避免把“未知”误当成一个真实版型。
func editionBreakdown(games []Game, idx []int) []EditionRow {
	type acc struct {
		n, win, mvp, svp, bgx, wolf int
		tp                          float64
	}
	m := map[string]*acc{}
	var order []string
	for _, i := range idx {
		g := games[i]
		if g.Edition == "" {
			continue
		}
		a := m[g.Edition]
		if a == nil {
			a = &acc{}
			m[g.Edition] = a
			order = append(order, g.Edition)
		}
		a.n++
		a.tp += g.Point
		if !g.Good { // 狼人阵营场次（含石像鬼/血月使徒/梦魇），用于摸狼率
			a.wolf++
		}
		if g.Win {
			a.win++
		}
		if g.MVP {
			a.mvp++
		}
		if g.SVP {
			a.svp++
		}
		if g.BGX {
			a.bgx++
		}
	}
	rows := make([]EditionRow, 0, len(order))
	for _, edition := range order {
		a := m[edition]
		rows = append(rows, EditionRow{
			Edition: edition, N: a.n, Avg: Round2(a.tp / float64(a.n)),
			Win:    int(math.Round(float64(a.win) / float64(a.n) * 100)),
			Molang: int(math.Round(float64(a.wolf) / float64(a.n) * 100)),
			MVP:    a.mvp, SVP: a.svp, BGX: a.bgx,
		})
	}
	sort.SliceStable(rows, func(i, j int) bool { return rows[i].N > rows[j].N })
	return rows
}

// orderedKV 按 JSON 原始键序把统计对象转成键值列表（保留接口给出的字段顺序，跳过空键）；不翻译、不隐藏。
func orderedKV(raw json.RawMessage) []KV {
	if len(raw) == 0 {
		return nil
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	t, err := dec.Token()
	if err != nil {
		return nil
	}
	if d, ok := t.(json.Delim); !ok || d != '{' {
		return nil
	}
	var out []KV
	for dec.More() {
		kt, err := dec.Token()
		if err != nil {
			break
		}
		key, _ := kt.(string)
		var val any
		if dec.Decode(&val) != nil {
			break
		}
		if key == "" {
			continue
		}
		out = append(out, KV{key, val})
	}
	return out
}

// —— 去重工具（保留首见顺序）——
func uniqStr(in []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, s := range in {
		if s != "" && !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}
