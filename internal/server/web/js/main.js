// 引导入口：把内联事件处理器暴露到 window（HTML 里用 onclick 等调用）；
// 启动时开心跳（进程存活由它维持），再判断登录状态——有效令牌进应用，否则进引导页。
import { refreshSession, checkToken, tokenValid, startHeartbeat, quitApp, setAuthLostHandler } from './api.js';
import { searchName, openPlayer, openGame, closeGame, sortGames, setRoleSort, setGF, showMore, pick, setGameMode,
  showGate, enterApp, retryToken, closePop, prefetchGame } from './ui.js';
import { toggleOpt, closeOpt, toggleTheme, showAbout, closeAbout, copyEmail } from './options.js';

// type="module" 的顶层绑定不进全局，内联 on* 处理器需要显式挂到 window。
Object.assign(window, {
  searchName, openPlayer, openGame, closeGame, sortGames, setRoleSort, setGF, showMore, pick, setGameMode,
  retryToken, closePop, quitApp, prefetchGame,
  toggleOpt, toggleTheme, showAbout, closeAbout, copyEmail,
});

document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeGame(); closeAbout(); closePop(); closeOpt(); } });
// 点击外部关闭选项菜单 / 数据说明气泡
document.addEventListener('click', e => {
  if (!e.target.closest('#opt')) closeOpt();
  document.querySelectorAll('.infohint.open').forEach(h => { if (!h.contains(e.target)) h.classList.remove('open'); });
});

// 令牌失效(401)：回到引导页让用户重新登录微信。
setAuthLostHandler(showGate);

// 启动：先开心跳，再取会话——有效令牌进搜索页，否则进引导页。
startHeartbeat();
(async () => {
  try {
    const ok = await refreshSession();
    if (ok && tokenValid()) enterApp(); else showGate();
  } catch (e) {
    // 本地服务失联已由 api 层提示并尝试关闭页面，不再误显示成“未登录”。
    if (!e || (e.name !== 'LocalServerError' && e.name !== 'TestVersionExpiredError')) showGate();
  }
})();
