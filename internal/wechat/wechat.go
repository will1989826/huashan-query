// Package wechat 负责“从微信本地存储里找出候选登录令牌”。
// 它知道微信把数据存在哪、localStorage 值怎么编码、令牌键名叫什么；依赖 leveldb 解析层。
package wechat

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
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
		parsed := loginTokens(d, s.MaxAgeDays) // 首选：leveldb 解析（处理块边界、还原最新值）
		for _, t := range parsed {
			add(t)
		}
		// 每个目录独立兜底。一个旧目录即使还能解析出过期记录，也不能阻止新版微信目录被扫描。
		if len(parsed) == 0 {
			for _, t := range rawScan(d, s.MaxAgeDays) { // 兜底：裸扫连续 JWT（如未实现的压缩格式）
				add(t)
			}
		}
	}
	if len(out) == 0 {
		logx.Errorf("no candidate token from WeChat: searched %d local storage dir(s) "+
			"(max file age: %d days; 0 disables age filtering)",
			len(dirs), s.MaxAgeDays)
	}
	return out
}

// Dirs 查找微信各版本的 Chromium LevelDB 与 macOS WebKit LocalStorage 目录。
func Dirs() []string {
	var roots []string
	var skipDir func(string) bool
	switch runtime.GOOS {
	case "windows":
		roots = windowsRoots(os.Getenv("APPDATA"), os.Getenv("LOCALAPPDATA"))
	case "darwin":
		skipDir = skipDarwinStorageDir
		home, err := os.UserHomeDir()
		if err == nil {
			roots = darwinRoots(home)
		}
	}
	return storageDirs(roots, skipDir)
}

func windowsRoots(appData, localAppData string) []string {
	return []string{
		filepath.Join(appData, "Tencent"),
		filepath.Join(localAppData, "Tencent"),
	}
}

func darwinRoots(home string) []string {
	library := filepath.Join(home, "Library")
	containerData := filepath.Join(library, "Containers", "com.tencent.xinWeChat", "Data")
	containerLibraries := []string{
		filepath.Join(containerData, "Library"),
		filepath.Join(library, "Containers", "com.tencent.xinWeChat.WeChatAppEx", "Data", "Library"),
	}
	return []string{
		filepath.Join(containerData, ".wxapplet"),
		filepath.Join(containerData, "Documents", "app_data"),
		filepath.Join(containerLibraries[0], "Application Support", "com.tencent.xinWeChat"),
		filepath.Join(containerLibraries[0], "Caches", "com.tencent.xinWeChat"),
		filepath.Join(containerLibraries[0], "WebKit"),
		filepath.Join(containerLibraries[1], "Application Support"),
		filepath.Join(containerLibraries[1], "Caches"),
		filepath.Join(containerLibraries[1], "WebKit"),
		filepath.Join(library, "Application Support", "com.tencent.xinWeChat"),
		filepath.Join(library, "Application Support", "WeChat"),
		filepath.Join(library, "Group Containers", "5A4RE8SF68.com.tencent.xinWeChat"),
	}
}

// skipDarwinStorageDir excludes known chat data and resource caches by directory name.
// Keep Caches, Storage and WebKit traversable: they can contain login storage.
func skipDarwinStorageDir(name string) bool {
	switch strings.ToLower(name) {
	case "message", "messagetemp", "msgattach", "filestorage", "file_storage", "db_storage",
		"cache", "code cache", "gpucache", "dawncache", "networkcache":
		return true
	}
	return false
}

func storageDirs(roots []string, skipDir func(string) bool) []string {
	seen := map[string]bool{}
	var out []string
	add := func(path string) {
		path = filepath.Clean(path)
		if !seen[path] {
			seen[path] = true
			out = append(out, path)
		}
	}
	for _, root := range roots {
		if st, err := os.Stat(root); err != nil || !st.IsDir() {
			continue
		}
		filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			name := strings.ToLower(d.Name())
			if d.IsDir() {
				if skipDir != nil && skipDir(name) {
					return filepath.SkipDir
				}
				if name == "leveldb" || name == "localstorage" {
					add(p)
				}
				return nil
			}
			if strings.HasSuffix(name, ".localstorage") || name == "localstorage.db" || name == "localstorage.sqlite3" {
				add(filepath.Dir(p))
			}
			return nil
		})
	}
	sort.Strings(out)
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
			out = append(out, tokensFromLoginValue(decodeValue(r.val))...)
		}
	}
	return out
}

// tokensFromLoginValue 兼容 login_status 从纯 JWT 变为带引号或 JSON 包装的写法。
// 只有已确认的 login_status 键走此提取，因此无需依赖 JWT payload 里的历史字段名。
func tokensFromLoginValue(value string) []string {
	s := strings.TrimSpace(value)
	if strings.HasPrefix(s, "eyJ") && strings.Count(s, ".") == 2 && !strings.ContainsAny(s, " \t\r\n\"") {
		return []string{s}
	}
	matches := jwtRe.FindAllString(s, -1)
	seen := map[string]bool{}
	out := make([]string, 0, len(matches))
	for _, tok := range matches {
		if !seen[tok] {
			seen[tok] = true
			out = append(out, tok)
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
		for _, t := range rawTokens(data) {
			if looksLikeUserToken(t) {
				out = append(out, t)
			}
		}
	}
	return out
}

// rawTokens 同时识别 ASCII/UTF-8 和 SQLite 可能使用的 UTF-16 JWT 文本。
func rawTokens(data []byte) []string {
	seen := map[string]bool{}
	var out []string
	addMatches := func(text []byte) {
		for _, match := range jwtRe.FindAll(text, -1) {
			token := string(match)
			if !seen[token] {
				seen[token] = true
				out = append(out, token)
			}
		}
	}
	addMatches(data)
	for i := 0; i+5 < len(data); i++ {
		if data[i] == 'e' && data[i+1] == 0 && data[i+2] == 'y' && data[i+3] == 0 && data[i+4] == 'J' && data[i+5] == 0 {
			addMatches(utf16ASCIIRun(data, i, false))
		}
		if data[i] == 0 && data[i+1] == 'e' && data[i+2] == 0 && data[i+3] == 'y' && data[i+4] == 0 && data[i+5] == 'J' {
			addMatches(utf16ASCIIRun(data, i, true))
		}
	}
	filtered := make([]string, 0, len(out))
	for _, token := range out {
		prefixOfLonger := false
		for _, other := range out {
			if len(other) > len(token) && strings.HasPrefix(other, token) {
				prefixOfLonger = true
				break
			}
		}
		if !prefixOfLonger {
			filtered = append(filtered, token)
		}
	}
	return filtered
}

func utf16ASCIIRun(data []byte, start int, bigEndian bool) []byte {
	var out []byte
	for i := start; i+1 < len(data); i += 2 {
		ascii, zero := data[i], data[i+1]
		if bigEndian {
			zero, ascii = ascii, zero
		}
		if zero != 0 || !isJWTByte(ascii) {
			break
		}
		out = append(out, ascii)
	}
	return out
}

func isJWTByte(b byte) bool {
	return b >= 'a' && b <= 'z' || b >= 'A' && b <= 'Z' || b >= '0' && b <= '9' || b == '_' || b == '-' || b == '.'
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
