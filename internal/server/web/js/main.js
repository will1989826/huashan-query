// 引导入口：把内联事件处理器暴露到 window（HTML 里用 onclick 等调用）；
// 启动时开心跳（进程存活由它维持），再判断登录状态——有效令牌进应用，否则进引导页。
import { refreshSession, checkToken, tokenValid, startHeartbeat, quitApp, setAuthLostHandler } from './api.js';
import { searchName, openPlayer, openGame, closeGame, sortGames, setRoleSort, setEditionSort, setGF, showMore, pick, setGameMode,
  showGate, enterApp, retryToken, useManualToken, closePop, prefetchGame, setSearchMode, setDetailTab,
  showProfileCrestPicker, selectProfileCrest, showBatchSearch, syncBatchInput, runBatchSearch, selectBatchCandidate,
  confirmBatchName, editBatchName, removeBatchName, batchNameKeydown, pasteBatchNames,
  setProfileMetricDisplay, setSearchTab, searchTabKeydown, returnToCompare,
  toggleBatchCandidates, retryBatchEntry, confirmBatchPlayers, toggleRadarPicker, toggleRadarMetric, resetRadarMetrics } from './ui.js';
import { addToBasket, removeFromBasket, clearBasket, openCompare, setCompareLayer, setCompareGroup, setCompareDeepMode,
  setCompareMetric, setCompareRole, setCompareScope, sortCompare, toggleCompareFocus, toggleCompareCustom, showAllCompare,
  toggleCompareRadarPicker, toggleCompareRadarMetric, resetCompareRadarMetrics,
  setCompareView, setCompareOverviewMetric, toggleCompareOverviewOrder, toggleCompareSpotlight,
  setSharedMode, setSharedEdition, setSharedOrder, showMoreSharedGames,
  openLineup, closeLineup, setLineupEdition, setLineupSeat, assignLineupSeatsInOrder, toggleLineupSeatOrder, setLineupRole, clearLineupAssignments, retryLineupData } from './compare.js';
import { showTheme, setTheme, showAbout, jumpHelp, closeAbout, copyEmail, copyLoginToken, showChangelog, checkUpdate, autoCheckUpdate, shareApp } from './options.js';
import { showHome, showPersonal, closePersonal, showTools, showEvents, closeEvents, queryEvents, retryEventTypes, setEventPage, toggleEventExpand, setEventRankSort, setEventTab, setEventPlayerSort, showEventTeam, closeEventTeam, syncEventFilters, setEventMemberSort } from './events.js';
import { showDrawTool, closeDrawTool, syncDrawFilters, queryDrawTool, setDrawProjection, selectDrawRemoved, selectDrawEditGame } from './draw-tool.js';
import { showGroupTool, closeGroupTool, syncGroupFilters, queryGroupTool, retryGroupTool, drawNextTeam, finishGroupDraw, resetGroupDraw } from './group-tool.js';

// type="module" 的顶层绑定不进全局，内联 on* 处理器需要显式挂到 window。
Object.assign(window, {
  openLineup, closeLineup, setLineupEdition, setLineupSeat, assignLineupSeatsInOrder, toggleLineupSeatOrder, setLineupRole, clearLineupAssignments, retryLineupData,
  searchName, openPlayer, openGame, closeGame, sortGames, setRoleSort, setEditionSort, setGF, showMore, pick, setGameMode,
  retryToken, useManualToken, closePop, quitApp, prefetchGame, setSearchMode, setDetailTab, showProfileCrestPicker, selectProfileCrest,
  showBatchSearch, syncBatchInput, runBatchSearch, selectBatchCandidate, toggleBatchCandidates, retryBatchEntry, confirmBatchPlayers,
  confirmBatchName, editBatchName, removeBatchName, batchNameKeydown, pasteBatchNames,
  toggleRadarPicker, toggleRadarMetric, resetRadarMetrics,
  setProfileMetricDisplay, setSearchTab, searchTabKeydown, returnToCompare,
  addToBasket, removeFromBasket, clearBasket, openCompare, setCompareLayer, setCompareGroup, setCompareDeepMode,
  setCompareMetric, setCompareRole, setCompareScope, sortCompare, toggleCompareFocus, toggleCompareCustom, showAllCompare,
  toggleCompareRadarPicker, toggleCompareRadarMetric, resetCompareRadarMetrics,
  setCompareView, setCompareOverviewMetric, toggleCompareOverviewOrder, toggleCompareSpotlight,
  setSharedMode, setSharedEdition, setSharedOrder, showMoreSharedGames,
  showTheme, setTheme, showAbout, jumpHelp, closeAbout, copyEmail, copyLoginToken, showChangelog, checkUpdate, shareApp,
  showHome, showPersonal, closePersonal, showTools, showEvents, closeEvents, queryEvents, retryEventTypes, setEventPage, toggleEventExpand, setEventRankSort, setEventTab, setEventPlayerSort, showEventTeam, closeEventTeam, syncEventFilters, setEventMemberSort,
  showDrawTool, closeDrawTool, syncDrawFilters, queryDrawTool, setDrawProjection, selectDrawRemoved, selectDrawEditGame,
  showGroupTool, closeGroupTool, syncGroupFilters, queryGroupTool, retryGroupTool, drawNextTeam, finishGroupDraw, resetGroupDraw,
});

document.addEventListener('keydown', e => { if (e.key === 'Escape' && !e.defaultPrevented) { closeEvents(); } });
// 点击外部关闭数据说明气泡。
document.addEventListener('click', e => {
  document.querySelectorAll('.infohint.open').forEach(h => { if (!h.contains(e.target)) { h.classList.remove('open'); h.setAttribute('aria-expanded', 'false'); } });
});

// 令牌失效(401)：回到引导页让用户重新登录微信。
setAuthLostHandler(showGate);

// 启动：先开心跳，再取会话——有效令牌进首页，否则进登录引导页。
startHeartbeat();
(async () => {
  try {
    const ok = await refreshSession();
    if (ok && tokenValid()) enterApp(); else showGate();
  } catch (e) {
    // 本地服务失联已由 api 层提示并尝试关闭页面，不再误显示成“未登录”。
    if (!e || e.name !== 'LocalServerError') showGate();
  }
  // refreshSession 结束后（版本号已就绪或确实取不到）再静默检查更新——避免与会话加载竞态而误判。
  // 只有确实有新版本才弹提示（可下载或“以后再说”）；已最新 / 未配置 / 连不上 / 当前版本未知一律静默，绝不报错、不打扰。
  autoCheckUpdate().catch(() => {});
})();
