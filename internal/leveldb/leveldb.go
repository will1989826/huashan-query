// Package leveldb 是一个最小的、只读的 Chromium LocalStorage leveldb 解析器。
// 只依赖标准库；不"打开"数据库（微信运行时持有锁），而是直接只读解析原始文件，
// 支持 SSTable(.ldb) + WAL(.log) + Snappy 压缩块。此层与业务无关，最稳定、最该被评审。
package leveldb

import (
	"encoding/binary"
	"os"
)

// KV 是一条已归一化的键值记录：Key 一律为 user key（SSTable 已剥离 8 字节内部尾部），
// Seq 为全局递增序号（越大越新），Type 为 1=写入(value) / 0=删除(tombstone)。
// 上层据此按最高 Seq 合并、并让删除记录压制历史写入，还原“最新值”语义。
type KV struct {
	Key, Val []byte
	Seq      uint64
	Type     uint8 // 1=value(put) 0=deletion(tombstone)
}

const (
	typeDeletion = 0
	typeValue    = 1
)

// parseInternalKey 拆分 SSTable 内部键：user_key + 8 字节尾部(小端 uint64 = seq<<8 | type)。
func parseInternalKey(ik []byte) (userKey []byte, seq uint64, typ uint8, ok bool) {
	n := len(ik)
	if n < 8 {
		return nil, 0, 0, false
	}
	trailer := binary.LittleEndian.Uint64(ik[n-8:])
	return ik[:n-8], trailer >> 8, uint8(trailer & 0xff), true
}

// uvarint 读一个 LEB128 变长整数；越界或未终止(损坏)时 ok=false。
func uvarint(b []byte, pos int) (val uint64, next int, ok bool) {
	var r uint64
	var s uint
	for pos < len(b) {
		x := b[pos]
		pos++
		r |= uint64(x&0x7f) << s
		if x&0x80 == 0 {
			return r, pos, true
		}
		s += 7
		if s >= 64 { // 超过 uint64 位宽 → 损坏
			return 0, pos, false
		}
	}
	return 0, pos, false // 在终止字节前耗尽输入
}

// readBlock 按 BlockHandle(offset,size) 读一个块并按需解压。
// 块后紧跟 1 字节压缩类型 + 4 字节 CRC（读取时不需要 CRC）。
// 对越界的 handle 返回错误（而非越界 panic），以便忽略损坏项后继续。
func readBlock(data []byte, offset, size uint64) ([]byte, error) {
	end := offset + size
	if end < offset || end >= uint64(len(data)) { // 溢出 / 块尾+压缩类型字节越界
		return nil, errBadHandle
	}
	raw := data[offset:end]
	switch data[end] {
	case 0:
		return raw, nil
	case 1:
		return snappyDecompress(raw)
	default:
		return nil, errUnsupported
	}
}

var (
	errUnsupported = &parseError{"unsupported block compression"}
	errBadHandle   = &parseError{"block handle out of range"}
)

type parseError struct{ msg string }

func (e *parseError) Error() string { return e.msg }

// iterEntries 解析一个数据/索引块，返回其中的原始 (key,val) 条目。
// key 为块内还原后的原始字节（对数据块即内部键，由调用方再拆分）。
// 遇到损坏(越界 varint / 长度越界)时停止并返回已解析部分，不 panic。
func iterEntries(block []byte) (kvs []KV) {
	if len(block) < 4 {
		return
	}
	n := int(binary.LittleEndian.Uint32(block[len(block)-4:]))
	if n < 0 || 4*(n+1) > len(block) {
		return
	}
	restartOff := len(block) - 4*(n+1)
	pos := 0
	var key []byte
	for pos < restartOff {
		shared, p, ok := uvarint(block, pos)
		if !ok {
			return
		}
		nonshared, p2, ok := uvarint(block, p)
		if !ok {
			return
		}
		vlen, p3, ok := uvarint(block, p2)
		if !ok {
			return
		}
		pos = p3
		// 边界：shared 不能超过已累积键长；nonshared/vlen 不能越出 restart 区
		if int(shared) > len(key) || pos+int(nonshared) > restartOff || pos+int(nonshared)+int(vlen) > restartOff {
			return
		}
		nk := append([]byte{}, key[:shared]...)
		nk = append(nk, block[pos:pos+int(nonshared)]...)
		pos += int(nonshared)
		val := append([]byte{}, block[pos:pos+int(vlen)]...)
		pos += int(vlen)
		key = nk
		kvs = append(kvs, KV{Key: append([]byte{}, nk...), Val: val})
	}
	return
}

// ReadTable 解析一个 .ldb SSTable，返回其中全部键值（已拆分内部键，带 Seq/Type）。
func ReadTable(path string) (kvs []KV) {
	defer func() { recover() }()
	data, err := os.ReadFile(path)
	if err != nil || len(data) < 48 {
		return
	}
	footer := data[len(data)-48:]
	p := 0
	_, p, _ = uvarint(footer, p) // metaindex offset
	_, p, _ = uvarint(footer, p) // metaindex size
	idxOff, p, ok := uvarint(footer, p)
	if !ok {
		return
	}
	idxSz, _, ok := uvarint(footer, p)
	if !ok {
		return
	}
	index, err := readBlock(data, idxOff, idxSz)
	if err != nil {
		return
	}
	for _, e := range iterEntries(index) {
		boff, hp, ok := uvarint(e.Val, 0)
		if !ok {
			continue
		}
		bsz, _, ok := uvarint(e.Val, hp)
		if !ok {
			continue
		}
		blk, err := readBlock(data, boff, bsz)
		if err != nil {
			continue
		}
		for _, e := range iterEntries(blk) {
			uk, seq, typ, ok := parseInternalKey(e.Key)
			if !ok {
				continue
			}
			kvs = append(kvs, KV{Key: append([]byte{}, uk...), Val: e.Val, Seq: seq, Type: typ})
		}
	}
	return
}

// ReadLog 解析一个 .log WAL，返回其中全部记录（put 与 delete 都返回，带 Seq/Type）。
// 每个 WriteBatch 头含起始序号，批内每条操作序号依次 +1；delete 以 Type=0 返回，
// 供上层用最高序号压制历史写入（还原“已删除键不再出现”的语义）。
func ReadLog(path string) (kvs []KV) {
	defer func() { recover() }()
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}
	const block = 32768
	pos, n := 0, len(data)
	var frag []byte
	var recs [][]byte
	for pos+7 <= n {
		room := block - (pos % block)
		if room < 7 {
			pos += room
			continue
		}
		length := int(binary.LittleEndian.Uint16(data[pos+4 : pos+6]))
		rtype := data[pos+6]
		pos += 7
		if pos+length > n {
			break
		}
		payload := data[pos : pos+length]
		pos += length
		switch rtype {
		case 1: // full
			recs = append(recs, append([]byte{}, payload...))
		case 2: // first
			frag = append([]byte{}, payload...)
		case 3: // middle
			frag = append(frag, payload...)
		case 4: // last
			frag = append(frag, payload...)
			recs = append(recs, frag)
			frag = nil
		}
	}
	for _, rec := range recs {
		if len(rec) < 12 {
			continue
		}
		func() {
			defer func() { recover() }()
			seq := binary.LittleEndian.Uint64(rec[0:8]) // 批起始序号
			p := 12                                     // 跳过 WriteBatch 头(seq 8 + count 4)
			for p < len(rec) {
				tag := rec[p]
				p++
				if tag == typeValue { // put
					klen, np, ok := uvarint(rec, p)
					if !ok || np+int(klen) > len(rec) {
						break
					}
					p = np
					k := append([]byte{}, rec[p:p+int(klen)]...)
					p += int(klen)
					vlen, np2, ok := uvarint(rec, p)
					if !ok || np2+int(vlen) > len(rec) {
						break
					}
					p = np2
					v := append([]byte{}, rec[p:p+int(vlen)]...)
					p += int(vlen)
					kvs = append(kvs, KV{Key: k, Val: v, Seq: seq, Type: typeValue})
					seq++
				} else if tag == typeDeletion { // delete
					klen, np, ok := uvarint(rec, p)
					if !ok || np+int(klen) > len(rec) {
						break
					}
					p = np
					k := append([]byte{}, rec[p:p+int(klen)]...)
					p += int(klen)
					kvs = append(kvs, KV{Key: k, Seq: seq, Type: typeDeletion})
					seq++
				} else {
					break
				}
			}
		}()
	}
	return
}
