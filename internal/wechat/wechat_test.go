package wechat

import (
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDecodeValue(t *testing.T) {
	if decodeValue([]byte{1, 'a', 'b'}) != "ab" {
		t.Fatal("latin1 decode")
	}
	if decodeValue([]byte{0, 'a', 0, 'b', 0}) != "ab" {
		t.Fatal("utf16le decode")
	}
	if decodeValue(nil) != "" {
		t.Fatal("empty")
	}
}

func makeTok(payload map[string]any) string {
	b, _ := json.Marshal(payload)
	// HS256 签名段为 32 字节 HMAC 的 base64url，长度 43 字符（贴近真实令牌，且满足 jwtRe >=20）
	sig := strings.Repeat("a", 43)
	return "eyJhbGciOiJIUzI1NiJ9." + base64.RawURLEncoding.EncodeToString(b) + "." + sig
}

func TestLooksLikeUserToken(t *testing.T) {
	if !looksLikeUserToken(makeTok(map[string]any{"grant_type": "U_WEIXIN_WEB_CODE"})) {
		t.Fatal("weixin grant should match")
	}
	if !looksLikeUserToken(makeTok(map[string]any{"jti": "225"})) {
		t.Fatal("jti should match")
	}
	if looksLikeUserToken(makeTok(map[string]any{"foo": 1})) {
		t.Fatal("unrelated should not match")
	}
}

func TestRecentEnough(t *testing.T) {
	p := filepath.Join(t.TempDir(), "f")
	os.WriteFile(p, []byte("x"), 0o644)
	if !recentEnough(p, 3) {
		t.Fatal("fresh file should be recent")
	}
	old := time.Now().Add(-10 * 24 * time.Hour)
	os.Chtimes(p, old, old)
	if recentEnough(p, 3) {
		t.Fatal("10-day-old file should be skipped")
	}
	if !recentEnough(p, 0) {
		t.Fatal("maxAge 0 means no limit")
	}
}

func buildLog(entries [][2]string) []byte {
	batch := make([]byte, 12)
	for _, e := range entries {
		batch = append(batch, 1)
		batch = binary.AppendUvarint(batch, uint64(len(e[0])))
		batch = append(batch, e[0]...)
		batch = binary.AppendUvarint(batch, uint64(len(e[1])))
		batch = append(batch, e[1]...)
	}
	rec := make([]byte, 7)
	binary.LittleEndian.PutUint16(rec[4:6], uint16(len(batch)))
	rec[6] = 1
	return append(rec, batch...)
}

func TestLoginTokens(t *testing.T) {
	dir := t.TempDir()
	tok := "eyJx.y.z" // startsWith eyJ 且 2 个点即可（loginTokens 不走 jwtRe）
	key := "_https://h5.huashan.tv\x00\x01login_status"
	val := append([]byte{1}, tok...) // 0x01 = Latin-1 前缀
	os.WriteFile(filepath.Join(dir, "000003.log"), buildLog([][2]string{{key, string(val)}}), 0o644)
	got := loginTokens(dir, 0)
	if len(got) != 1 || got[0] != tok {
		t.Fatalf("loginTokens got %v", got)
	}
}

func TestRawScan(t *testing.T) {
	dir := t.TempDir()
	tok := makeTok(map[string]any{"grant_type": "U_WEIXIN_WEB_CODE"})
	os.WriteFile(filepath.Join(dir, "blob"), []byte("junk "+tok+" junk"), 0o644)
	found := false
	for _, x := range rawScan(dir, 0) {
		if x == tok {
			found = true
		}
	}
	if !found {
		t.Fatal("rawScan should recover the embedded token")
	}
}

func TestRawScanAdjacentBoundary(t *testing.T) {
	// JWT 后紧跟合法 base64url 字符（无分隔符）时，贪婪正则会把邻接字节并入签名段。
	// 记录当前行为：签名段被拉长，但仍是三段结构、payload 完好，故仍能识别为用户令牌。
	dir := t.TempDir()
	tok := makeTok(map[string]any{"grant_type": "U_WEIXIN_WEB_CODE"})
	os.WriteFile(filepath.Join(dir, "blob"), []byte(tok+"ZZZZ tail"), 0o644)
	got := rawScan(dir, 0)
	if len(got) == 0 {
		t.Fatal("expected a token even when followed by adjacent base64url chars")
	}
	// 识别为用户令牌（payload 段不受尾部污染影响）
	if !looksLikeUserToken(got[0]) {
		t.Fatalf("recovered token not recognized: %q", got[0])
	}
}

// —— WAL 构造助手：受控 seq + put/delete，验证“最高序号胜出”合并语义 ——

func putB(k, v string) []byte {
	o := []byte{1}
	o = binary.AppendUvarint(o, uint64(len(k)))
	o = append(o, k...)
	o = binary.AppendUvarint(o, uint64(len(v)))
	return append(o, v...)
}

func delB(k string) []byte {
	o := []byte{0}
	o = binary.AppendUvarint(o, uint64(len(k)))
	return append(o, k...)
}

func logFile(seq uint64, ops ...[]byte) []byte {
	b := make([]byte, 12)
	binary.LittleEndian.PutUint64(b[0:8], seq)
	binary.LittleEndian.PutUint32(b[8:12], uint32(len(ops)))
	for _, o := range ops {
		b = append(b, o...)
	}
	rec := make([]byte, 7)
	binary.LittleEndian.PutUint16(rec[4:6], uint16(len(b)))
	rec[6] = 1 // full
	return append(rec, b...)
}

func latin1(tok string) string { return string(append([]byte{1}, tok...)) }

func TestLoginTokensHighestSeqWins(t *testing.T) {
	dir := t.TempDir()
	key := "_https://h5.huashan.tv\x00\x01login_status"
	old, cur := "eyJold.y.z", "eyJnew.y.z"
	// 同一键先后两次写入：seq 更高的应胜出
	os.WriteFile(filepath.Join(dir, "000003.log"),
		logFile(10, putB(key, latin1(old)), putB(key, latin1(cur))), 0o644)
	got := loginTokens(dir, 0)
	if len(got) != 1 || got[0] != cur {
		t.Fatalf("highest-seq put should win, got %v", got)
	}
}

func TestLoginTokensTombstoneHides(t *testing.T) {
	dir := t.TempDir()
	key := "_https://h5.huashan.tv\x00\x01login_status"
	tok := "eyJx.y.z"
	// 写入后又删除（seq 更高）：删除应压制历史写入，令牌不再作为候选
	os.WriteFile(filepath.Join(dir, "000004.log"),
		logFile(20, putB(key, latin1(tok)), delB(key)), 0o644)
	if got := loginTokens(dir, 0); len(got) != 0 {
		t.Fatalf("tombstone should hide deleted login_status, got %v", got)
	}
}

func TestStoreCandidatesEmpty(t *testing.T) {
	// 空目录场景：注入临时空目录（不依赖真实微信目录），Candidates 应返回 nil 且不 panic。
	s := &Store{MaxAgeDays: 3, DirsFn: func() []string { return []string{t.TempDir()} }}
	if got := s.Candidates(); got != nil {
		t.Fatalf("empty dir should yield nil candidates, got %v", got)
	}
}

func TestCandidatesSkipRawScanWhenParsed(t *testing.T) {
	// 结构化解析命中时不应再裸扫：裸文件里的另一枚 JWT 不应出现在候选里（避免整目录重复读盘）。
	dir := t.TempDir()
	key := "_https://h5.huashan.tv\x00\x01login_status"
	parsed := "eyJparsed.y.z"
	os.WriteFile(filepath.Join(dir, "000003.log"), logFile(1, putB(key, latin1(parsed))), 0o644)
	raw := makeTok(map[string]any{"grant_type": "U_WEIXIN_WEB_CODE"}) // 仅存在于裸文件
	os.WriteFile(filepath.Join(dir, "blob"), []byte("junk "+raw+" junk"), 0o644)
	s := &Store{MaxAgeDays: 0, DirsFn: func() []string { return []string{dir} }}
	got := s.Candidates()
	if len(got) != 1 || got[0] != parsed {
		t.Fatalf("structured parse hit should skip raw scan; got %v", got)
	}
}
