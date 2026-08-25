package main

import (
	"encoding/json"
	"testing"
)

func TestReleaseAssetsCoverWindowsAndMac(t *testing.T) {
	assets := releaseAssets("1.2.3")
	want := map[string]string{
		"windows_amd64": "huashan-query-v1.2.3.exe",
		"mac_arm64":     "huashan-query-v1.2.3-mac-arm64",
	}
	if len(assets) != len(want) {
		t.Fatalf("assets=%+v", assets)
	}
	for _, asset := range assets {
		if want[asset.Key] != asset.Name {
			t.Errorf("asset %q=%q want %q", asset.Key, asset.Name, want[asset.Key])
		}
	}
}

func TestManifestIncludesAllDownloadsAndLegacyWindowsURL(t *testing.T) {
	downloads := map[string]string{"windows_amd64": "win", "mac_arm64": "arm"}
	b, err := manifestBytes("1.2.3", downloads, "notes")
	if err != nil {
		t.Fatal(err)
	}
	var got struct {
		Version   string            `json:"version"`
		URL       string            `json:"url"`
		Downloads map[string]string `json:"downloads"`
	}
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatal(err)
	}
	if got.Version != "1.2.3" || got.URL != "win" || len(got.Downloads) != 2 || got.Downloads["mac_arm64"] != "arm" {
		t.Fatalf("manifest=%+v", got)
	}
}
