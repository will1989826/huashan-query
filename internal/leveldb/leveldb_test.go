package leveldb

import (
	"encoding/binary"
	"os"
	"path/filepath"
	"testing"
)

func TestUvarint(t *testing.T) {
	if v, n, ok := uvarint([]byte{0x96, 0x01}, 0); v != 150 || n != 2 || !ok {
		t.Fatalf("uvarint 150 got %d,%d,%v", v, n, ok)
	}
	if v, _, ok := uvarint([]byte{0x7f}, 0); v != 127 || !ok {
		t.Fatalf("uvarint 127 got %d,%v", v, ok)
	}
	// 损坏：未终止（高位一直为 1 直到耗尽输入）→ ok=false
	if _, _, ok := uvarint([]byte{0x80, 0x80, 0x80}, 0); ok {
		t.Fatal("truncated varint should report ok=false")
	}
}

func TestSnappy(t *testing.T) {
	cases := []struct {
		in   []byte
		want string
	}{
		{[]byte{0x03, 0x08, 'A', 'B', 'C'}, "ABC"},           // literal
		{[]byte{0x05, 0x00, 'a', 0x0e, 0x01, 0x00}, "aaaaa"}, // copy 2-byte offset (overlap/RLE)
		{[]byte{0x05, 0x00, 'a', 0x01, 0x01}, "aaaaa"},       // copy 1-byte offset (overlap/RLE)
	}
	for i, c := range cases {
		got, err := snappyDecompress(c.in)
		if err != nil || string(got) != c.want {
			t.Fatalf("case %d: got %q err %v want %q", i, got, err, c.want)
		}
	}
}

func TestSnappyLongLiteral(t *testing.T) {
	body := make([]byte, 60)
	for i := range body {
		body[i] = 'x'
	}
	in := append([]byte{0x3c, 0xF0, 0x3b}, body...) // uvarint(60), tag(60<<2)=literal-ext, lenByte(59)
	got, err := snappyDecompress(in)
	if err != nil || len(got) != 60 {
		t.Fatalf("long literal len %d err %v", len(got), err)
	}
}

func buildBlock(entries [][2]string) []byte {
	var b []byte
	for _, e := range entries {
		b = binary.AppendUvarint(b, 0) // shared=0
		b = binary.AppendUvarint(b, uint64(len(e[0])))
		b = binary.AppendUvarint(b, uint64(len(e[1])))
		b = append(b, e[0]...)
		b = append(b, e[1]...)
	}
	b = binary.LittleEndian.AppendUint32(b, 0) // restart[0]=0
	b = binary.LittleEndian.AppendUint32(b, 1) // restart count=1
	return b
}

func TestIterEntries(t *testing.T) {
	got := iterEntries(buildBlock([][2]string{{"ab", "XY"}, {"cd", "Z"}}))
	if len(got) != 2 || string(got[0].Key) != "ab" || string(got[0].Val) != "XY" ||
		string(got[1].Key) != "cd" || string(got[1].Val) != "Z" {
		t.Fatalf("iterEntries got %+v", got)
	}
}

// internalKey 拼 SSTable 内部键：user_key + 8 字节尾部(小端 seq<<8 | type)。
func internalKey(user string, seq uint64, typ uint8) string {
	trailer := seq<<8 | uint64(typ)
	var b [8]byte
	binary.LittleEndian.PutUint64(b[:], trailer)
	return user + string(b[:])
}

// buildTableIK 用给定的内部键条目构建一个 .ldb 文件字节。
func buildTableIK(entries [][2]string) []byte {
	db := buildBlock(entries)
	file := append([]byte{}, db...)
	file = append(file, 0)          // data block compression type
	file = append(file, 0, 0, 0, 0) // data block crc
	idxOff := len(file)
	handle := binary.AppendUvarint(nil, 0)                 // data block offset
	handle = binary.AppendUvarint(handle, uint64(len(db))) // data block size
	ib := buildBlock([][2]string{{"\xff", string(handle)}})
	file = append(file, ib...)
	file = append(file, 0)                                // index compression type
	file = append(file, 0, 0, 0, 0)                       // index crc
	footer := binary.AppendUvarint(nil, 0)                // metaindex off (unused)
	footer = binary.AppendUvarint(footer, 0)              // metaindex size
	footer = binary.AppendUvarint(footer, uint64(idxOff)) // index off
	footer = binary.AppendUvarint(footer, uint64(len(ib)))
	for len(footer) < 40 {
		footer = append(footer, 0)
	}
	footer = append(footer, make([]byte, 8)...) // 8-byte magic (unchecked)
	return append(file, footer...)
}

// buildTable 构建含普通 value 条目的 .ldb（键为 user key，包一层内部键尾部）。
func buildTable(entries [][2]string) []byte {
	ik := make([][2]string, len(entries))
	for i, e := range entries {
		ik[i] = [2]string{internalKey(e[0], uint64(i+1), typeValue), e[1]}
	}
	return buildTableIK(ik)
}

func TestReadTable(t *testing.T) {
	p := filepath.Join(t.TempDir(), "000001.ldb")
	os.WriteFile(p, buildTable([][2]string{{"k1", "v1"}, {"k2", "v2"}}), 0o644)
	m := map[string]string{}
	for _, e := range ReadTable(p) {
		m[string(e.Key)] = string(e.Val)
	}
	if m["k1"] != "v1" || m["k2"] != "v2" {
		t.Fatalf("ReadTable got %+v (user keys should be stripped of trailer)", m)
	}
}

func TestReadTableSeqType(t *testing.T) {
	p := filepath.Join(t.TempDir(), "000001.ldb")
	// 键必须按内部键排序（user 升序）；此处 a<b
	os.WriteFile(p, buildTableIK([][2]string{
		{internalKey("a", 5, typeValue), "va"},
		{internalKey("b", 9, typeDeletion), ""},
	}), 0o644)
	got := ReadTable(p)
	if len(got) != 2 {
		t.Fatalf("want 2 entries, got %d", len(got))
	}
	if string(got[0].Key) != "a" || got[0].Seq != 5 || got[0].Type != typeValue {
		t.Fatalf("entry0 = %q seq=%d type=%d", got[0].Key, got[0].Seq, got[0].Type)
	}
	if string(got[1].Key) != "b" || got[1].Seq != 9 || got[1].Type != typeDeletion {
		t.Fatalf("entry1 = %q seq=%d type=%d", got[1].Key, got[1].Seq, got[1].Type)
	}
}

func TestReadTableBadHandle(t *testing.T) {
	// 索引指向越界 handle → readBlock 返回错误，忽略该项，整体不 panic、不返回垃圾。
	handle := binary.AppendUvarint(nil, 1<<40)   // 巨大 offset
	handle = binary.AppendUvarint(handle, 1<<20) // 巨大 size
	ib := buildBlock([][2]string{{"\xff", string(handle)}})
	file := append([]byte{}, ib...)
	file = append(file, 0, 0, 0, 0, 0) // index compression + crc
	footer := binary.AppendUvarint(nil, 0)
	footer = binary.AppendUvarint(footer, 0)
	footer = binary.AppendUvarint(footer, 0) // index off = start of ib
	footer = binary.AppendUvarint(footer, uint64(len(ib)))
	for len(footer) < 40 {
		footer = append(footer, 0)
	}
	footer = append(footer, make([]byte, 8)...)
	p := filepath.Join(t.TempDir(), "000009.ldb")
	os.WriteFile(p, append(file, footer...), 0o644)
	if got := ReadTable(p); len(got) != 0 {
		t.Fatalf("bad handle should yield no entries, got %+v", got)
	}
}

func buildLog(entries [][2]string) []byte {
	batch := make([]byte, 12) // seq(8)+count(4)
	for _, e := range entries {
		batch = append(batch, 1) // put
		batch = binary.AppendUvarint(batch, uint64(len(e[0])))
		batch = append(batch, e[0]...)
		batch = binary.AppendUvarint(batch, uint64(len(e[1])))
		batch = append(batch, e[1]...)
	}
	rec := make([]byte, 7) // crc(4)+len(2)+type(1)
	binary.LittleEndian.PutUint16(rec[4:6], uint16(len(batch)))
	rec[6] = 1 // full
	return append(rec, batch...)
}

func TestReadLog(t *testing.T) {
	p := filepath.Join(t.TempDir(), "000002.log")
	os.WriteFile(p, buildLog([][2]string{{"key", "val"}, {"foo", "bar"}}), 0o644)
	m := map[string]string{}
	for _, e := range ReadLog(p) {
		m[string(e.Key)] = string(e.Val)
	}
	if m["key"] != "val" || m["foo"] != "bar" {
		t.Fatalf("ReadLog got %+v", m)
	}
}

func TestReadMissingFile(t *testing.T) {
	if got := ReadTable(filepath.Join(t.TempDir(), "nope.ldb")); got != nil {
		t.Fatalf("missing table should yield nil, got %v", got)
	}
	if got := ReadLog(filepath.Join(t.TempDir(), "nope.log")); got != nil {
		t.Fatalf("missing log should yield nil, got %v", got)
	}
}

// —— WAL：序号、tombstone、跨 32KiB 分片 ——

func putOp(k, v string) []byte {
	o := []byte{typeValue}
	o = binary.AppendUvarint(o, uint64(len(k)))
	o = append(o, k...)
	o = binary.AppendUvarint(o, uint64(len(v)))
	return append(o, v...)
}

func delOp(k string) []byte {
	o := []byte{typeDeletion}
	o = binary.AppendUvarint(o, uint64(len(k)))
	return append(o, k...)
}

func batch(seq uint64, ops ...[]byte) []byte {
	b := make([]byte, 12)
	binary.LittleEndian.PutUint64(b[0:8], seq)
	binary.LittleEndian.PutUint32(b[8:12], uint32(len(ops)))
	for _, o := range ops {
		b = append(b, o...)
	}
	return b
}

// encodeLog 把若干逻辑记录(batch)编码成 WAL 文件字节，按 32KiB 块自动切分为 full/first/middle/last 物理记录。
func encodeLog(recs ...[]byte) []byte {
	const block = 32768
	var out []byte
	emit := func(typ byte, payload []byte) {
		hdr := make([]byte, 7)
		binary.LittleEndian.PutUint16(hdr[4:6], uint16(len(payload)))
		hdr[6] = typ
		out = append(out, hdr...)
		out = append(out, payload...)
	}
	for _, rec := range recs {
		first := true
		for {
			room := block - (len(out) % block)
			if room < 7 {
				out = append(out, make([]byte, room)...) // 补齐到下一块
				continue
			}
			avail := room - 7
			if avail >= len(rec) {
				if first {
					emit(1, rec) // full
				} else {
					emit(4, rec) // last
				}
				break
			}
			chunk := rec[:avail]
			if first {
				emit(2, chunk) // first
			} else {
				emit(3, chunk) // middle
			}
			rec = rec[avail:]
			first = false
		}
	}
	return out
}

func TestReadLogSeqAndDelete(t *testing.T) {
	// 一个批：seq=100 起，put a、del b、put c → 序号 100,101,102；del 保留为 tombstone。
	p := filepath.Join(t.TempDir(), "000010.log")
	os.WriteFile(p, encodeLog(batch(100, putOp("a", "1"), delOp("b"), putOp("c", "3"))), 0o644)
	got := ReadLog(p)
	if len(got) != 3 {
		t.Fatalf("want 3 records (incl. delete), got %d: %+v", len(got), got)
	}
	if string(got[0].Key) != "a" || got[0].Seq != 100 || got[0].Type != typeValue {
		t.Fatalf("rec0 %q seq=%d type=%d", got[0].Key, got[0].Seq, got[0].Type)
	}
	if string(got[1].Key) != "b" || got[1].Seq != 101 || got[1].Type != typeDeletion {
		t.Fatalf("delete not surfaced with type/seq: %q seq=%d type=%d", got[1].Key, got[1].Seq, got[1].Type)
	}
	if string(got[2].Key) != "c" || got[2].Seq != 102 {
		t.Fatalf("rec2 %q seq=%d", got[2].Key, got[2].Seq)
	}
}

func TestReadLogMultiShard(t *testing.T) {
	// 单条记录的 value 超过 32KiB，必须跨块拆成 first/middle/last，读回应完整重组。
	big := make([]byte, 40000)
	for i := range big {
		big[i] = byte('A' + i%26)
	}
	p := filepath.Join(t.TempDir(), "000011.log")
	os.WriteFile(p, encodeLog(batch(7, putOp("huge", string(big)))), 0o644)
	got := ReadLog(p)
	if len(got) != 1 || string(got[0].Key) != "huge" {
		t.Fatalf("want 1 reassembled record, got %d: %+v", len(got), keysOf(got))
	}
	if len(got[0].Val) != len(big) || string(got[0].Val) != string(big) {
		t.Fatalf("cross-shard value not reassembled: got %d bytes want %d", len(got[0].Val), len(big))
	}
}

func keysOf(kvs []KV) []string {
	var ks []string
	for _, e := range kvs {
		ks = append(ks, string(e.Key))
	}
	return ks
}
