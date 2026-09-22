package main

// framework.go —— 从 internal/analysis/framework_rules.json（规则/文案单一事实源）+ 已建库的分布，
// 产出 internal/analysis/framework.json（阈值+规则合并），供桌面版 embed.FS 嵌入。
// 与 research/build_framework.py 同口径；-framework 可只重算 framework.json 而不重建全库（解耦）。

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"sort"
	"strconv"
)

var fwDeciles = []int{10, 20, 30, 40, 50, 60, 70, 80, 90}

const (
	fwVersion   = "framework-t0t2-v2"
	fwScopeNote = "官方T0可按赛区/赛季；自算T2可按赛区/自然年/最近N场。"
)

type rulesDoc struct {
	MinRounds    int                 `json:"min_rounds"`
	Confidence   map[string]string   `json:"confidence"`
	T0MetricDefs [][]json.RawMessage `json:"t0_metric_defs"`
	T2Labels     map[string]string   `json:"t2_labels"`
	T0Rules      []rawRule           `json:"t0_rules"`
	T2Rules      []rawRule           `json:"t2_rules"`
}

type rawRule struct {
	ID    string              `json:"id"`
	Group string              `json:"group"`
	Tag   string              `json:"tag"`
	When  [][]json.RawMessage `json:"when"`
}

func emitFramework(db *sql.DB, rulesPath, outPath string) error {
	raw, err := os.ReadFile(rulesPath)
	if err != nil {
		return fmt.Errorf("read framework rules %s: %w", rulesPath, err)
	}
	var rules rulesDoc
	if err := json.Unmarshal(raw, &rules); err != nil {
		return fmt.Errorf("parse framework rules: %w", err)
	}
	t0, err := frameworkT0(db, rules.MinRounds, rules.T0MetricDefs)
	if err != nil {
		return err
	}
	t2, err := frameworkT2(db, rules.T2Labels)
	if err != nil {
		return err
	}
	out := map[string]any{
		"version":         fwVersion,
		"min_rounds":      rules.MinRounds,
		"deciles":         fwDeciles,
		"confidence":      rules.Confidence,
		"prior_weight":    20.0,
		"min_denominator": 10,
		"scope_note":      fwScopeNote,
		"t0_metrics":      t0,
		"t0_rules":        transformRules(rules.T0Rules, false),
		"t2_metrics":      t2,
		"t2_rules":        transformRules(rules.T2Rules, true),
	}
	// 数据源截止日/局数：画像页顶部要写清"数据算到哪一天"。
	var srcDate sql.NullString
	var srcGames sql.NullInt64
	if err := db.QueryRow(`SELECT source_max_play_date, source_game_count FROM v_analysis_coverage`).Scan(&srcDate, &srcGames); err == nil {
		out["source_max_date"] = srcDate.String
		out["source_games"] = srcGames.Int64
	}
	b, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(outPath, b, 0o644); err != nil {
		return fmt.Errorf("write framework.json: %w", err)
	}
	fmt.Printf("framework.json: T0 %d指标 + %d规则; T2 %d阈值行 + %d规则 -> %s\n",
		len(t0), len(rules.T0Rules), len(t2), len(rules.T2Rules), outPath)
	return nil
}

// frameworkT0 mirrors research/build_framework.py deciles(): official-stats distribution
// per metric, round_total>=min_rounds, rate=count/round_total*100, role-conditioned skips <=0.
func frameworkT0(db *sql.DB, minRounds int, defs [][]json.RawMessage) ([]map[string]any, error) {
	rows, err := db.Query(`SELECT summary_json, haoren_json, langren_json FROM player_stats`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	src := map[string][]map[string]any{"summary_json": nil, "haoren_json": nil, "langren_json": nil}
	for rows.Next() {
		var s, h, l sql.NullString
		if err := rows.Scan(&s, &h, &l); err != nil {
			return nil, err
		}
		src["summary_json"] = append(src["summary_json"], parseStatJSON(s))
		src["haoren_json"] = append(src["haoren_json"], parseStatJSON(h))
		src["langren_json"] = append(src["langren_json"], parseStatJSON(l))
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	campOf := map[string]string{"summary_json": "comprehensive", "haoren_json": "good", "langren_json": "wolf"}
	out := []map[string]any{}
	for _, def := range defs {
		source, key, label, kind := jsonStr(def[0]), jsonStr(def[1]), jsonStr(def[2]), jsonStr(def[3])
		var roleCond bool
		_ = json.Unmarshal(def[4], &roleCond)
		var vals []float64
		for _, d := range src[source] {
			if d == nil {
				continue
			}
			rt := toFloat(d["round_total"])
			if rt < float64(minRounds) {
				continue
			}
			v, ok := d[key]
			if !ok || v == nil {
				continue
			}
			f := toFloat(v)
			if kind == "rate" {
				if rt == 0 {
					continue
				}
				f = 100.0 * f / rt
			}
			if roleCond && f <= 0 {
				continue
			}
			vals = append(vals, f)
		}
		if len(vals) < 30 {
			continue
		}
		sort.Float64s(vals)
		m := map[string]any{"label": label, "source": source, "key": key, "kind": kind,
			"camp": campOf[source], "role_conditioned": roleCond, "n": len(vals)}
		addDeciles(m, vals)
		out = append(out, m)
	}
	return out, nil
}

// frameworkT2 mirrors build_framework.py: deciles over eligible smoothed_value per
// (metric_key, camp, period_type, period_key) group with >=30 players.
func frameworkT2(db *sql.DB, labels map[string]string) ([]map[string]any, error) {
	rows, err := db.Query(`SELECT metric_key,camp,period_type,period_key,smoothed_value,baseline_value FROM analysis_metric_values WHERE eligible=1 AND smoothed_value IS NOT NULL`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	type gkey struct{ mk, camp, pt, pk string }
	groups := map[gkey][]float64{}
	baselines := map[gkey]float64{}
	for rows.Next() {
		var mk, camp, pt, pk string
		var sv float64
		var bv sql.NullFloat64
		if err := rows.Scan(&mk, &camp, &pt, &pk, &sv, &bv); err != nil {
			return nil, err
		}
		k := gkey{mk, camp, pt, pk}
		groups[k] = append(groups[k], sv)
		baselines[k] = bv.Float64 // 同 cohort 内一致
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	keys := make([]gkey, 0, len(groups))
	for k := range groups {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		a, b := keys[i], keys[j]
		if a.mk != b.mk {
			return a.mk < b.mk
		}
		if a.camp != b.camp {
			return a.camp < b.camp
		}
		if a.pt != b.pt {
			return a.pt < b.pt
		}
		return a.pk < b.pk
	})
	out := []map[string]any{}
	for _, k := range keys {
		vals := groups[k]
		if len(vals) < 30 {
			continue
		}
		sort.Float64s(vals)
		label := labels[k.mk]
		if label == "" {
			label = k.mk
		}
		m := map[string]any{"label": label, "metric_key": k.mk, "camp": k.camp,
			"period_type": k.pt, "period_key": k.pk, "n": len(vals), "baseline": round4(baselines[k])}
		addDeciles(m, vals)
		out = append(out, m)
	}
	return out, nil
}

func transformRules(rules []rawRule, t2 bool) []map[string]any {
	out := []map[string]any{}
	for _, r := range rules {
		when := []map[string]any{}
		for _, w := range r.When {
			var bands []string
			if t2 {
				_ = json.Unmarshal(w[2], &bands)
				when = append(when, map[string]any{"metric_key": jsonStr(w[0]), "camp": jsonStr(w[1]), "band_in": bands})
			} else {
				_ = json.Unmarshal(w[1], &bands)
				when = append(when, map[string]any{"metric": jsonStr(w[0]), "band_in": bands})
			}
		}
		out = append(out, map[string]any{"id": r.ID, "group": r.Group, "tag": r.Tag, "when": when})
	}
	return out
}

func addDeciles(m map[string]any, sorted []float64) {
	for _, k := range fwDeciles {
		m["p"+strconv.Itoa(k)] = round4(quantile(sorted, float64(k)/100))
	}
}

func round4(v float64) float64 { return math.Round(v*1e4) / 1e4 }

func parseStatJSON(s sql.NullString) map[string]any {
	if !s.Valid || s.String == "" {
		return nil
	}
	var m map[string]any
	if json.Unmarshal([]byte(s.String), &m) != nil {
		return nil
	}
	return m
}

func jsonStr(raw json.RawMessage) string {
	var s string
	_ = json.Unmarshal(raw, &s)
	return s
}

// toFloat accepts numbers or numeric strings (player_stats fields vary).
func toFloat(v any) float64 {
	switch x := v.(type) {
	case float64:
		return x
	case json.Number:
		f, _ := x.Float64()
		return f
	case string:
		f, _ := strconv.ParseFloat(x, 64)
		return f
	default:
		return 0
	}
}
