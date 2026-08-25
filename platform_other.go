//go:build !windows

// 非 Windows 平台装配（Mac / Linux）：无自动令牌来源——只支持在网页里手动填 Token；
// 用系统命令打开浏览器，致命启动错误打到标准错误 + 日志（这些平台有可见控制台）。
package main

import (
	"fmt"
	"os"
	"os/exec"
	"runtime"

	"huashanquery/internal/logx"
	"huashanquery/internal/token"
)

// tokenSources：Mac/Linux 无内置自动来源（不去读微信本地存储），返回 nil。
// 用户在引导页手动粘贴 Token 即可（token.Manager.SetManual 纯 HTTP 校验，跨平台可用）。
func tokenSources() []token.Source { return nil }

// openBrowser 用系统默认方式打开 URL：macOS 用 open，其余（Linux）用 xdg-open。
func openBrowser(url string) {
	cmd := "xdg-open"
	if runtime.GOOS == "darwin" {
		cmd = "open"
	}
	if err := exec.Command(cmd, url).Run(); err != nil {
		logx.Errorf("open browser via %s failed: %v (visit %s manually)", cmd, err, url)
	}
}

// fatalBox 打印致命启动错误到标准错误并记日志（无 GUI 子系统，控制台可见）。
func fatalBox(msg string) {
	fmt.Fprintln(os.Stderr, msg)
	logx.Errorf("fatal: %s", msg)
}
