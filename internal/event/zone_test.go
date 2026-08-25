package event

import "testing"

// zone.go 是赛区单一事实源：这里锁定其对外语义，避免后续调整列表时误删/误判默认与校验。
func TestZoneRegistry(t *testing.T) {
	opts := zoneOptions()
	if len(opts) < 10 || opts[0].Value != "SH" {
		t.Fatalf("zoneOptions=%+v (want SH first, ≥10 zones)", opts)
	}
	if eventOptionExists(opts, "ALL") {
		t.Fatal("ALL must not appear as a selectable zone")
	}

	for _, code := range []string{"SD", "HSXM", "SH"} {
		if !validZone(code) {
			t.Fatalf("validZone(%q) = false, want true", code)
		}
	}
	for _, code := range []string{"ALL", "", "NOPE"} {
		if validZone(code) {
			t.Fatalf("validZone(%q) = true, want false", code)
		}
	}

	if zoneOrDefault("") != defaultZone {
		t.Fatalf("zoneOrDefault(\"\") = %q, want %q", zoneOrDefault(""), defaultZone)
	}
	if zoneOrDefault("SD") != "SD" {
		t.Fatalf("zoneOrDefault(\"SD\") = %q, want SD", zoneOrDefault("SD"))
	}
}
