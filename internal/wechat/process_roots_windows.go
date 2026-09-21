//go:build windows

package wechat

import (
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"huashanquery/internal/logx"
)

const wechatRootQuery = `$ErrorActionPreference = 'SilentlyContinue'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); Get-CimInstance Win32_Process -Filter "Name='WeChatAppEx.exe'" | ForEach-Object { if ($_.CommandLine -match '--wmpf_root_dir="([^"]+)"') { $Matches[1] }; if ($_.CommandLine -match '--wechat-files-path="([^"]+)"') { $Matches[1] } }`

var runningRootCache struct {
	sync.Mutex
	roots   []string
	expires time.Time
	logged  string
	didLog  bool
}

// runningWeChatRoots reads both storage roots declared by the active WeChat web
// process. Migrated installations can retain web stores below either root.
func runningWeChatRoots() []string {
	runningRootCache.Lock()
	defer runningRootCache.Unlock()
	if time.Now().Before(runningRootCache.expires) {
		return append([]string(nil), runningRootCache.roots...)
	}

	cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", wechatRootQuery)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	out, err := cmd.Output()
	if err == nil {
		runningRootCache.roots = parseRunningRootLines(string(out))
		key := strings.Join(runningRootCache.roots, "\x00")
		if !runningRootCache.didLog || key != runningRootCache.logged {
			if len(runningRootCache.roots) == 0 {
				logx.Infof("no WeChat process storage root detected")
			}
			for _, root := range runningRootCache.roots {
				logx.Infof("detected WeChat process storage root: %s", root)
			}
			runningRootCache.logged = key
			runningRootCache.didLog = true
		}
	} else {
		logDiagnostic("process-query", err.Error(), "WeChat process storage query failed: %v", err)
	}
	// Refresh during a live detection session so launching WeChat later still works.
	runningRootCache.expires = time.Now().Add(8 * time.Second)
	return append([]string(nil), runningRootCache.roots...)
}

func parseRunningRootLines(output string) []string {
	var roots []string
	for _, line := range strings.Split(strings.ReplaceAll(output, "\r\n", "\n"), "\n") {
		root := strings.TrimSpace(strings.TrimPrefix(line, "\ufeff"))
		if root == "" || !filepath.IsAbs(root) {
			continue
		}
		roots = append(roots, filepath.Clean(root))
	}
	return uniquePaths(roots)
}
