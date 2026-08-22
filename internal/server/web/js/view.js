// 当前占据 #detail 的视图：'search'（搜索空态）| 'detail'（单人详情）| 'compare'（多人对比）。
// 单人详情(ui.js)与对比表(compare.js)都异步写 #detail；各自的回调在写入前必须确认自己仍是当前视图，
// 否则一方的迟到请求会覆盖另一方——例如在对比表点开某人后，后台预热返回会把详情又盖回对比表。
let cur = 'search';
export const currentView = () => cur;
export const setView = v => { cur = v; };
