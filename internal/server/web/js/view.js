// 当前占据 #detail 的视图：'search'（搜索空态）| 'detail'（单人详情）| 'compare'（多人对比）。
// 单人详情(ui.js)与对比表(compare.js)都异步写 #detail；各自的回调在写入前必须确认自己仍是当前视图，
// 否则一方的迟到请求会覆盖另一方——例如在对比表点开某人后，后台预热返回会把详情又盖回对比表。
let cur = 'search';
let fromCompare = false;
let personalOrigin = 'home';
export const setPersonalOrigin = origin => { personalOrigin = origin; };
export const currentView = () => cur;
export const setView = v => {
  if (v === 'detail' && cur !== 'detail') fromCompare = cur === 'compare';
  if (v === 'search') fromCompare = false;
  cur = v;
  if (typeof document === 'undefined') return;
  const nav = document.querySelector('#detail-navigation');
  if (!nav) return;
  nav.hidden = v === 'search';
  nav.innerHTML = v === 'compare'
    ? `<button type="button" class="page-back" onclick="setSearchTab('compare')">← 对比搜索</button><div class="roster-actions"><button type="button" onclick="setSearchTab('compare','add')">＋ 添加人员</button><button type="button" class="roster-replace" onclick="setSearchTab('compare','replace')">更换全部人员</button></div>`
    : `<button type="button" class="page-back" onclick="${fromCompare ? 'returnToCompare()' : personalOrigin === 'events' ? 'closePersonal()' : "setSearchTab('personal')"}">${fromCompare ? '← 返回对比' : personalOrigin === 'events' ? document.querySelector('#personal-back')?.textContent || '← 返回赛事数据' : '← 返回个人搜索'}</button>`;
  const tabs = document.querySelector('#search-tabs');
  if (tabs) tabs.hidden = v !== 'search';
  for (const id of ['personal-search', 'compare-search']) {
    const panel = document.querySelector('#' + id);
    if (panel && v !== 'search') panel.hidden = true;
  }
};
