package wechat

import (
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"testing"
	"time"
)

func TestStorageDirsUsesBothWindowsRoots(t *testing.T) {
	app := t.TempDir()
	local := t.TempDir()

	want := []string{
		filepath.Join(app, "Tencent", "WeChat", "leveldb"),
		filepath.Join(local, "Tencent", "x", "LEVELDB"),
	}
	for _, dir := range want {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.MkdirAll(filepath.Join(app, "Tencent", "not-leveldb"), 0o755); err != nil {
		t.Fatal(err)
	}

	got := storageDirs(windowsRoots(app, local), nil)
	sort.Strings(got)
	sort.Strings(want)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("storageDirs() = %v, want %v", got, want)
	}
}

func TestStorageDirsFindsDarwinWebStores(t *testing.T) {
	home := t.TempDir()
	library := filepath.Join(home, "Library")
	want := []string{
		filepath.Join(library, "Containers", "com.tencent.xinWeChat", "Data", "Library", "WebKit", "WebsiteData", "LocalStorage"),
		filepath.Join(library, "Application Support", "com.tencent.xinWeChat", "WebView", "Local Storage", "LEVELDB"),
		filepath.Join(library, "Group Containers", "5A4RE8SF68.com.tencent.xinWeChat", "origin"),
	}
	for _, dir := range want {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(want[2], "localstorage.sqlite3"), []byte("sqlite"), 0o644); err != nil {
		t.Fatal(err)
	}

	got := storageDirs(darwinRoots(home), skipDarwinStorageDir)
	sort.Strings(got)
	sort.Strings(want)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("macOS storageDirs() = %v, want %v", got, want)
	}
}

func TestDarwinStorageDirsPrunesHeavySubtrees(t *testing.T) {
	home := t.TempDir()
	roots := darwinRoots(home)
	var want []string
	for _, root := range roots {
		// Each layout must retain web stores, including those under Caches and Storage.
		for _, rel := range []string{
			filepath.Join("Caches", "WebView", "Local Storage", "leveldb"),
			filepath.Join("WebKit", "WebsiteData", "LocalStorage"),
			filepath.Join("WebKit", "WebsiteData", "Default", "origin", "LocalStorage"),
			filepath.Join("Storage", "profile", "origin"),
		} {
			dir := filepath.Join(root, rel)
			if err := os.MkdirAll(dir, 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(dir, "localstorage.sqlite3"), []byte("sqlite"), 0o644); err != nil {
				t.Fatal(err)
			}
			want = append(want, dir)
		}
		for _, name := range []string{
			"Message", "MessageTemp", "MsgAttach", "FileStorage", "file_storage", "db_storage",
			"Cache", "Code Cache", "GPUCache", "DawnCache", "NetworkCache",
		} {
			// A discoverable store inside each excluded tree exposes accidental descent.
			dir := filepath.Join(root, "account", name, "nested", "leveldb")
			if err := os.MkdirAll(dir, 0o755); err != nil {
				t.Fatal(err)
			}
		}
	}
	got := storageDirs(roots, skipDarwinStorageDir)
	sort.Strings(want)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("macOS storageDirs() = %v, want %v", got, want)
	}
	// The macOS exclusions must not affect Windows discovery.
	if unfiltered := storageDirs(roots, nil); len(unfiltered) <= len(got) {
		t.Fatal("unfiltered discovery should also find stores inside the excluded trees")
	}
}

func TestStoreCandidatesRawFallbackDeduplicates(t *testing.T) {
	tok := makeTok(map[string]any{"jti": "same-user"})
	dirs := []string{t.TempDir(), t.TempDir()}
	for i, dir := range dirs {
		if err := os.WriteFile(filepath.Join(dir, "blob"), []byte("prefix "+tok+" suffix"), 0o644); err != nil {
			t.Fatal(err)
		}
		if i == 1 {
			old := time.Now().Add(-10 * 24 * time.Hour)
			if err := os.Chtimes(filepath.Join(dir, "blob"), old, old); err != nil {
				t.Fatal(err)
			}
		}
	}

	// Unlimited age scans both copies, but Store-level deduplication returns one token.
	s := &Store{DirsFn: func() []string { return dirs }}
	got := s.Candidates()
	if len(got) != 1 || got[0] != tok {
		t.Fatalf("Candidates() = %v", got)
	}

	// With an age limit, the stale duplicate is skipped and the fresh one still wins.
	s.MaxAgeDays = 3
	got = s.Candidates()
	if len(got) != 1 || got[0] != tok {
		t.Fatalf("Candidates(age limited) = %v", got)
	}
}

func TestWechatParsingEdges(t *testing.T) {
	if got := decodeValue([]byte{'x', 'y'}); got != "xy" {
		t.Fatalf("decodeValue raw = %q", got)
	}
	if got := decodeValue([]byte{0, 'a'}); got != "" {
		t.Fatalf("decodeValue odd UTF-16 = %q", got)
	}
	if !recentEnough(filepath.Join(t.TempDir(), "missing"), 1) {
		t.Fatal("missing file should not be rejected solely by age filtering")
	}
	for _, bad := range []string{"", "one.part", "a.***.c"} {
		if looksLikeUserToken(bad) {
			t.Fatalf("looksLikeUserToken(%q) = true", bad)
		}
	}
}
