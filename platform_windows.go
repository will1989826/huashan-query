//go:build windows

// Windows 平台装配：令牌来源为本地微信存储；用原生 Win32 API 打开浏览器 / 弹致命错误框。
package main

import (
	"syscall"
	"unsafe"

	"huashanquery/internal/logx"
	"huashanquery/internal/token"
	"huashanquery/internal/wechat"
)

// tokenSources：Windows 扫近 3 天改动过的微信 leveldb，提取候选登录令牌。
func tokenSources() []token.Source {
	return []token.Source{&wechat.Store{MaxAgeDays: 3}}
}

// openBrowser 用 ShellExecuteW 打开默认浏览器——不经 cmd/start，避免 GUI 子系统下闪出黑窗。
func openBrowser(url string) {
	verb, _ := syscall.UTF16PtrFromString("open")
	target, err := syscall.UTF16PtrFromString(url)
	if err != nil {
		logx.Errorf("bad url for ShellExecute: %v (visit %s manually)", err, url)
		return
	}
	const swShowNormal = 1
	shell32 := syscall.NewLazyDLL("shell32.dll")
	ret, _, _ := shell32.NewProc("ShellExecuteW").Call(
		0, uintptr(unsafe.Pointer(verb)), uintptr(unsafe.Pointer(target)), 0, 0, uintptr(swShowNormal))
	if ret <= 32 { // ShellExecute 约定：返回值 <=32 表示失败
		logx.Errorf("ShellExecuteW failed (code %d); visit %s manually", ret, url)
	}
}

// fatalBox 在无控制台时向用户弹出原生错误框（仅用于“连网页都起不来”的致命启动错误）。
func fatalBox(msg string) {
	const mbIconError = 0x10
	title, _ := syscall.UTF16PtrFromString("华山战力查询")
	text, _ := syscall.UTF16PtrFromString(msg)
	user32 := syscall.NewLazyDLL("user32.dll")
	user32.NewProc("MessageBoxW").Call(
		0, uintptr(unsafe.Pointer(text)), uintptr(unsafe.Pointer(title)), uintptr(mbIconError))
}
