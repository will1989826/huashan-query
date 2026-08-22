// 华山战力查询 · 启动器（单文件静态 exe，Windows GUI 子系统，无控制台窗口）
// main 只做“装配”：微信令牌来源 → 令牌管理器 → 本地服务 → 打开浏览器 → 等待退出信号。
// 令牌是否存在、如何引导用户登录，全部交给网页判断（页面调 /api/session）；
// 进程生命周期由页面心跳驱动：页面每 3 秒发心跳，服务连续 3 分钟收不到即触发退出（见 server 看门狗）。
package main

import (
	"os"
	"os/signal"
	"syscall"
	"unsafe"

	"huashanquery/internal/huashan"
	"huashanquery/internal/logx"
	"huashanquery/internal/player"
	"huashanquery/internal/server"
	"huashanquery/internal/token"
	"huashanquery/internal/wechat"
)

// version 由打包脚本通过 -ldflags "-X main.version=vX.Y.Z" 注入；默认 dev。
var version = "dev"
var buildMode = "release"

func main() {
	defer logx.Recover("main") // 兜底：任何未捕获 panic 都记进日志（含调用栈）
	logx.Init(version)         // 无控制台，日志只写文件（exe 同目录 华山战力查询.log）

	// 令牌来源：微信本地存储。这里不再预先扫描/拦截——页面加载后自己调 /api/session 判断有无令牌，
	// 没有就展示引导页并提供“重新检测”，全部在浏览器里完成。
	mgr := &token.Manager{Sources: []token.Source{&wechat.Store{MaxAgeDays: 3}}}
	svc := player.New(huashan.New(mgr), 100) // 内存缓存最多 100 名选手（LRU，无时间过期——关掉重开即最新）

	url, done, closeSrv, err := server.Run(svc, server.Options{TestMode: buildMode == "test", Version: version})
	if err != nil {
		logx.Errorf("start local server failed: %v", err)
		fatalBox("无法启动本地服务。\n\n请把 exe 同目录下的「华山战力查询.log」发给作者。\n\n" + err.Error())
		return
	}
	defer closeSrv()

	openBrowser(url)

	// 退出时机：页面心跳超时 / 页面点“退出程序”(done)，或收到系统信号。任一发生即收尾退出。
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	select {
	case <-done:
	case <-sig:
	}
	_ = closeSrv()
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
