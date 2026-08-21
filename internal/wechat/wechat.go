// Package wechat 负责“从微信本地存储里找出候选登录令牌”。
// 它知道微信把数据存在哪、localStorage 值怎么编码、令牌键名叫什么；依赖 leveldb 解析层。
package wechat

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"huashanquery/internal/leveldb"
	"huashanquery/internal/logx"
)

var jwtRe = regexp.MustCompile(`eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}`)

// Store 是一个令牌来源（实现 token.Source：Candidates() []string）。
type Store struct {
	MaxAgeDays int             // 只读近 N 天改动过的文件（更旧的里面必然已过期）；0=不限
	DirsFn     func() []string // nil=默认 Dirs()（扫真实微信目录）；测试可注入临时目录
}

func (s *Store) dirs() []string {
	if s.DirsFn != nil {
		return s.DirsFn()
	}
	return Dirs()
}

// Candidates 返回从微信本地存储里扫到的所有候选令牌串（未校验）。
func (s *Store) Candidates() []string {
	seen := map[string]bool{}
	var out []string
	add := func(t string) {
		if t != "" && !seen[t] {
			seen[t] = true
			out = append(out, t)
		}
	}
	dirs := s.dirs()
	for _, d := range dirs {
		for _, t := range loginTokens(d, s.MaxAgeDays) { // 首选：leveldb 解析（处理块边界、还原最新值）
			add(t)
		}
	}
	if len(out) == 0 { // 结构化解析未命中时才裸扫兜底：避免每个文件被再整体读入内存扫一遍（常态下不触发）
		for _, d := range dirs {
			for _, t := range rawScan(d, s.MaxAgeDays) { // 兜底：裸扫连续 JWT（如未实现的压缩格式）
				add(t)
			}
		}
	}
	if len(out) == 0 {
		logx.Errorf("no candidate token from WeChat: scanned %d leveldb dir(s), none contained login_status "+
			"(not logged in on this PC / WeChat version dir not matched / files older than %d days skipped)",
			len(dirs), s.MaxAgeDays)
	}
	return out
}

// Dirs 递归查找微信各版本的 leveldb 目录。
func Dirs() []string {
	roots := []string{
		filepath.Join(os.Getenv("APPDATA"), "Tencent"),
		filepath.Join(os.Getenv("LOCALAPPDATA"), "Tencent"),
	}
	seen := map[string]bool{}
	var out []string
	for _, root := range roots {
		if st, err := os.Stat(root); err != nil || !st.IsDir() {
			continue
		}
		filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			if d.IsDir() && strings.EqualFold(d.Name(), "leveldb") && !seen[p] {
				seen[p] = true
				out = append(out, p)
			}
			return nil
		})
	}
	return out
}

func recentEnough(path string, maxAgeDays int) bool {
	if maxAgeDays <= 0 {
		return true
	}
	fi, err := os.Stat(path)
	if err != nil {
		return true
	}
	return time.Since(fi.ModTime()) <= time.Duration(maxAgeDays)*24*time.Hour
}

// decodeValue 解 Chromium LocalStorage 的值前缀：0x01=Latin-1，0x00=UTF-16LE。
func decodeValue(v []byte) string {
	if len(v) == 0 {
		return ""
	}
	switch v[0] {
	case 1:
		return string(v[1:])
	case 0:
		b := v[1:]
		var sb strings.Builder
		for i := 0; i+1 < len(b); i += 2 {
			sb.WriteRune(rune(uint16(b[i]) | uint16(b[i+1])<<8))
		}
		return sb.String()
	}
	return string(v)
}

// loginTokens 用 leveldb 解析目录里的 .ldb + .log，取出键含 login_status 的 JWT。
// 按“最高序号胜出”合并 SSTable 与 WAL 记录：更新序号更大的写入覆盖旧值，删除(tombstone)
// 压制历史写入，从而还原 LevelDB 的最新值语义（避免采用已删除/过期的旧令牌）。
func loginTokens(dir string, maxAgeDays int) []string {
	type rec struct {
		val []byte
		seq uint64
		typ uint8
	}
	latest := map[string]rec{}
	apply := func(kvs []leveldb.KV) {
		for _, e := range kvs {
			k := string(e.Key)
			if cur, ok := latest[k]; !ok || e.Seq >= cur.seq {
				latest[k] = rec{e.Val, e.Seq, e.Type}
			}
		}
	}
	collect := func(pat string, reader func(string) []leveldb.KV) {
		files, _ := filepath.Glob(filepath.Join(dir, pat))
		sort.Strings(files)
		for _, f := range files {
			if !recentEnough(f, maxAgeDays) {
				continue
			}
			apply(reader(f))
		}
	}
	collect("*.ldb", leveldb.ReadTable)
	collect("*.log", leveldb.ReadLog) // .log 序号通常更新，覆盖 .ldb
	var out []string
	for k, r := range latest {
		if r.typ == 0 { // 已删除（tombstone）→ 跳过
			continue
		}
		if strings.Contains(k, "login_status") {
			s := strings.TrimSpace(decodeValue(r.val))
			if strings.HasPrefix(s, "eyJ") && strings.Count(s, ".") == 2 {
				out = append(out, s)
			}
		}
	}
	return out
}

// rawScan 兜底：万一某块用了未实现压缩(如 zstd)或令牌以未压缩形式散落，捞连续 eyJ.. JWT。
func rawScan(dir string, maxAgeDays int) []string {
	var out []string
	files, _ := filepath.Glob(filepath.Join(dir, "*"))
	for _, f := range files {
		if !recentEnough(f, maxAgeDays) {
			continue
		}
		data, err := os.ReadFile(f)
		if err != nil {
			continue
		}
		for _, m := range jwtRe.FindAll(data, -1) {
			t := string(m)
			if looksLikeUserToken(t) {
				out = append(out, t)
			}
		}
	}
	return out
}

func looksLikeUserToken(tok string) bool {
	parts := strings.Split(tok, ".")
	if len(parts) < 2 {
		return false
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(parts[1], "="))
	if err != nil {
		return false
	}
	var pl struct {
		Jti       string `json:"jti"`
		GrantType string `json:"grant_type"`
	}
	json.Unmarshal(raw, &pl)
	return pl.Jti != "" || strings.Contains(pl.GrantType, "WEIXIN")
}
