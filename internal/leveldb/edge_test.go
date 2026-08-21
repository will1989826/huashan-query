package leveldb

import (
	"encoding/binary"
	"errors"
	"math"
	"testing"
)

func TestParseInternalKeyEdges(t *testing.T) {
	if _, _, _, ok := parseInternalKey([]byte("short")); ok {
		t.Fatal("short internal key should be rejected")
	}

	key := append([]byte("player"), make([]byte, 8)...)
	binary.LittleEndian.PutUint64(key[len(key)-8:], 123<<8|typeDeletion)
	user, seq, typ, ok := parseInternalKey(key)
	if !ok || string(user) != "player" || seq != 123 || typ != typeDeletion {
		t.Fatalf("parseInternalKey = %q, %d, %d, %v", user, seq, typ, ok)
	}
}

func TestUvarintEdges(t *testing.T) {
	if _, next, ok := uvarint([]byte{1}, 1); ok || next != 1 {
		t.Fatalf("end position should fail without advancing: next=%d ok=%v", next, ok)
	}
	overflow := []byte{0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80}
	if _, next, ok := uvarint(overflow, 0); ok || next != len(overflow) {
		t.Fatalf("overflow should fail after %d bytes: next=%d ok=%v", len(overflow), next, ok)
	}
}

func TestReadBlockEdges(t *testing.T) {
	raw := []byte{'a', 'b', 'c', 0, 0, 0, 0, 0}
	got, err := readBlock(raw, 0, 3)
	if err != nil || string(got) != "abc" {
		t.Fatalf("raw block = %q, %v", got, err)
	}

	unsupported := append([]byte("abc"), 2)
	if _, err := readBlock(unsupported, 0, 3); !errors.Is(err, errUnsupported) {
		t.Fatalf("unsupported compression error = %v", err)
	}
	if _, err := readBlock([]byte{0}, math.MaxUint64, 2); !errors.Is(err, errBadHandle) {
		t.Fatalf("overflowing handle error = %v", err)
	}
	if _, err := readBlock([]byte{0}, 0, 1); !errors.Is(err, errBadHandle) {
		t.Fatalf("missing compression byte error = %v", err)
	}
}

func TestSnappyCorruptionReturnsError(t *testing.T) {
	if _, err := snappyDecompress([]byte{0x01, 0x01}); err == nil {
		t.Fatal("invalid copy offset should return an error")
	}
}

func TestParseErrorText(t *testing.T) {
	if got := (&parseError{msg: "bad table"}).Error(); got != "bad table" {
		t.Fatalf("Error() = %q", got)
	}
}
