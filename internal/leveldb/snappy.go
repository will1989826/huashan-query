package leveldb

import (
	"encoding/binary"
	"fmt"
)

// snappyDecompress 解压一个 Snappy 原始块（leveldb 块内不带流式帧）。
func snappyDecompress(data []byte) (out []byte, err error) {
	defer func() {
		if e := recover(); e != nil {
			err = fmt.Errorf("snappy: %v", e)
		}
	}()
	_, pos, _ := uvarint(data, 0) // 解压后长度，忽略
	appendCopy := func(offset, length int) {
		start := len(out) - offset
		for i := 0; i < length; i++ {
			out = append(out, out[start+i])
		}
	}
	for pos < len(data) {
		tag := data[pos]
		pos++
		switch tag & 3 {
		case 0: // literal
			length := int(tag >> 2)
			if length >= 60 {
				k := length - 59
				v := 0
				for i := 0; i < k; i++ {
					v |= int(data[pos+i]) << (8 * i)
				}
				length = v
				pos += k
			}
			length++
			out = append(out, data[pos:pos+length]...)
			pos += length
		case 1: // copy, 1-byte offset
			length := int((tag>>2)&7) + 4
			offset := int(tag>>5)<<8 | int(data[pos])
			pos++
			appendCopy(offset, length)
		case 2: // copy, 2-byte offset
			length := int(tag>>2) + 1
			offset := int(binary.LittleEndian.Uint16(data[pos : pos+2]))
			pos += 2
			appendCopy(offset, length)
		case 3: // copy, 4-byte offset
			length := int(tag>>2) + 1
			offset := int(binary.LittleEndian.Uint32(data[pos : pos+4]))
			pos += 4
			appendCopy(offset, length)
		}
	}
	return out, nil
}
