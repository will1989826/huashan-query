// 华山战力查询 · 启动器（单文件静态 exe，Windows GUI 子系统，无控制台窗口）
// main 只做“装配”：微信令牌来源 → 令牌管理器 → 本地服务 → 打开浏览器 → 等待退出信号。
// 令牌是否存在、如何引导用户登录，全部交给网页判断（页面调 /api/session）；
// 进程生命周期由页面心跳驱动：页面每 3 秒发心跳，服务连续 3 分钟收不到即触发退出（见 server 看门狗）。
package main

import (
	"os"
	"os/signal"
	"syscall"

	"huashanquery/internal/huashan"
	"huashanquery/internal/logx"
	"huashanquery/internal/player"
	"huashanquery/internal/server"
	"huashanquery/internal/token"
)

// version 由打包脚本通过 -ldflags "-X main.version=vX.Y.Z" 注入；默认 dev。
var version = "dev"

// updateURL 是“检查更新”读取的清单地址，由打包脚本通过 -ldflags "-X main.updateURL=..." 注入（默认空=功能关闭）。
// 故意不写死在代码里：地址属于“部署/仓库信息”，随托管（GitHub/Gitee/自建）而变，由构建时从未入库的 deploy-url.txt 提供。
var updateURL = ""

func main() {
	defer logx.Recover("main") // 兜底：任何未捕获 panic 都记进日志（含调用栈）
	logx.Init(version)         // 无控制台，日志只写文件（exe 同目录 huashan-query.log）

	// 令牌来源按平台装配（见 platform_*.go）：Windows 扫本地微信存储；其他平台（Mac/Linux）无自动来源，只走手动填 Token。
	// 页面加载后自己调 /api/session 判断有无令牌，没有就展示引导页并提供“重新检测 / 手动输入”，全部在浏览器里完成。
	sources := tokenSources()
	mgr := &token.Manager{Sources: sources}
	svc := player.New(huashan.New(mgr), 100) // 内存缓存最多 100 名选手（LRU，无时间过期——关掉重开即最新）

	url, done, closeSrv, err := server.Run(svc, server.Options{
		Version: version, UpdateURL: updateURL, ManualTokenOnly: len(sources) == 0,
	})
	if err != nil {
		logx.Errorf("start local server failed: %v", err)
		fatalBox("无法启动本地服务。\n\n请把 exe 同目录下的「huashan-query.log」发给作者。\n\n" + err.Error())
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
