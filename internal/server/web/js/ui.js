// 视图与状态层：搜索、详情、逐场、单局。Go(player 层) 负责“大量计算”（聚合/候选/按作用域筛选），
// 本层做“轻活”：取模型、加中文标签与格式化、逐场表的快捷筛选/排序/分页、单局排版。
// 作用域(赛区/赛季/门派)变化才请求后端；表内 gf/排序/翻页只在本地重渲染，不发请求（Go 已把作用域数据一次给足）。
import { esc, roleColor, roleWeight, campColor, seatSkills, seatMarks, skillText, skillLabel, seatRef, roleEmoji, isWolf, WOLFSIDE, isGoodCamp, fmt, uniq, causeText, voteHitClass, kvMap, metricOf, arrowFor, sortableTh, sortRows } from './format.js';
import { resolveZone, zoneName, honorZoneName } from './zone.js';
import { searchPlayers, detail, game as fetchGame, refreshSession, setManualToken, checkToken, tokenValid, sessionReason, manualTokenOnly } from './api.js';
import { inBasket } from './compare.js';
import { currentView, setView } from './view.js';

const $ = s => document.querySelector(s);
const PAGE = 20;      // 逐场战绩每次显示行数
let V = null;         // 当前选手状态（作用域 + 表内交互态 + 最近模型 model）

export function __setV(v) { V = v; }
export function __getV() { return V; }

function newState(id) {
  return {
    id, zone: 'ALL', season: '', sect: '',
    gf: { result: '', camp: '', role: '', sect: '', mark: '' },
    sort: { key: 'play_date', dir: -1 }, roleSort: { key: 'n', dir: -1 }, editionSort: { key: 'n', dir: -1 },
    detailTab: 'overview',
    limit: PAGE, gen: 0, abort: null, model: null, gameCache: {}, gamesLoading: false,
  };
}

// —— 选手名搜索 ——
// 每条结果：点整条→单人详情；右侧“＋ 对比”按钮把该人加入对比篮（data-* 带信息，addToBasket 就地读取）。
const itemHTML = p => {
  const sect = (p.sects || []).map(s => s.name).join(' · ');
  const added = inBasket(p.player_id);
  const btn = `<button class="addbtn${added ? ' added' : ''}"${added ? ' disabled' : ''} data-id="${esc(p.player_id)}" data-name="${esc(p.player_name || '')}" data-avatar="${esc(p.player_avatar || '')}" data-sect="${esc(sect)}" onclick="event.stopPropagation();addToBasket(this)">${added ? '已加入' : '＋ 对比'}</button>`;
  return `<div class="item" onclick="openPlayer(${p.player_id})">
  <img src="${esc(p.player_avatar || '')}" onerror="this.style.visibility='hidden'">
  <div><div class="nm">${esc(p.player_name)}</div><div class="sect">${esc(sect || '—')}</div></div>
  <div class="rt">${p.total_point != null ? ('总分 ' + p.total_point) : ''}<div class="id">#${p.player_id}</div>${btn}</div></div>`;
};

// —— 确定选手预热 ——
// 搜索已能锁定目标选手时（ID 直达命中 / 姓名搜索相关度最高者），后台先把该人全量详情拉进缓存：
// 一次全量请求灌满 stats|ALL、gp1|ALL、games|ALL 三个子键——之后无论点“资料”进单人详情、
// 还是加入对比，openPlayer / openCompare 命中的正是这些子键。Go 侧 getSub 用 singleflight 合并、
// 引用计数兜底：预热与点击并发也只真拉一次、互不取消，不会冲突（见 cache.go）。
// 去重只针对“正在进行”的预热（prefetching Map，settle 即删）：失败/取消/服务端 LRU 淘汰后都能再次预热，
// 成功后的复用交给服务端缓存——绝不把已取消/失败的请求永久记为“已预热”。
// signal 由当轮搜索传入：迟到的旧搜索用的是自己那把已被取消的 signal，绝不会借新搜索的名义预热已放弃的人。
const prefetching = new Map();   // id → 进行中的预热 Promise（settle 即删；仅防并发重复，不做长期记忆）
export function prefetchPlayer(id, signal) {
  if (id == null) return;
  id = String(id);
  if (prefetching.has(id)) return;         // 同一人已有在途预热：不重复发起
  // 全量作用域恒为 ALL：与 openPlayer 的 head/firstpage/full、openCompare 的 head/full 所用子键一致
  const p = detail('id=' + encodeURIComponent(id) + '&zone=ALL', signal)
    .catch(() => {})                       // 预热失败/取消静默：点击时会照常重取
    .finally(() => { if (prefetching.get(id) === p) prefetching.delete(id); });
  prefetching.set(id, p);
}

// —— 搜索模式（按名字 / 按 ID）——
// 不再用“纯数字=ID”的隐式猜测：用户显式切换。按 ID 精确定位编号；按名字走官方宽匹配 + 前端相关度排序。
let searchMode = 'name';   // 'name' | 'id'
export function setSearchMode(m) {
  searchMode = m === 'id' ? 'id' : 'name';
  const q = $('#q');
  if (q) q.placeholder = searchMode === 'id' ? '输入选手 ID（纯数字），回车直达' : '输入选手名，回车搜索';
  if (typeof document !== 'undefined' && document.querySelectorAll)
    document.querySelectorAll('.smode .qf').forEach(el => el.classList.toggle('on', el.dataset.mode === searchMode));
  if (q && q.value.trim()) searchName();   // 已有输入：切模式即按新模式重查
}

// rankByRelevance：官方姓名接口是宽匹配（可能带回很多只沾一两个字的名字），前端按与查询词的相关度重排（纯函数，便于单测）。
// 分档：完全相同(0) > 以查询词开头(1) > 包含查询词(2，命中位置越靠前越相关) > 其余不含(3，官方模糊匹配的边角)。
// 同档再按名字更短（更贴近查询）、总分更高、原始顺序兜底——保证最相关者稳定置顶。
export function rankByRelevance(arr, q) {
  const nq = (q || '').trim();
  if (!nq) return (arr || []).slice();   // 空查询：原样返回（searchName 已保证非空，仅防御）
  const score = p => {
    const nm = ((p && p.player_name) || '').trim();
    if (!nq) return 3;
    if (nm === nq) return 0;
    if (nm.startsWith(nq)) return 1;
    const i = nm.indexOf(nq);
    if (i >= 0) return 2 + Math.min(i, 99) / 100;
    return 3;
  };
  return (arr || []).map((p, i) => ({ p, i })).sort((a, b) => {
    const sa = score(a.p), sb = score(b.p);
    if (sa !== sb) return sa - sb;
    const la = ((a.p.player_name) || '').length, lb = ((b.p.player_name) || '').length;
    if (la !== lb) return la - lb;
    const ta = +a.p.total_point || 0, tb = +b.p.total_point || 0;
    if (ta !== tb) return tb - ta;
    return a.i - b.i;
  }).map(x => x.p);
}

// 搜索代际 + 当轮取消器：每轮 searchName 自增 gen、新建 controller 并取消上一轮；渲染/预热前用 stale() 复核仍是当轮，
// 避免迟到的旧搜索覆盖新结果、或借新取消器预热已放弃的人。signal 同时传给 searchPlayers / ID head / 预热。
let searchGen = 0;
let searchAbort = null;
export async function searchName() {
  const gen = ++searchGen;
  if (searchAbort) searchAbort.abort();   // 取消上一轮搜索及其未点开的预热（已完成则无操作）
  const ctl = new AbortController(), signal = ctl.signal;
  searchAbort = ctl;
  const stale = () => gen !== searchGen;
  const bail = e => stale() || (e && (e.name === 'AbortError' || e.name === 'LocalServerError'));
  const q = $("#q").value.trim(), box = $("#results"); setView('search'); $("#detail").innerHTML = ""; V = null;
  if (!q) { box.innerHTML = '<div class="muted">' + (searchMode === 'id' ? '输入选手 ID 后直达' : '输入选手名后搜索') + '</div>'; return }
  box.innerHTML = '<div class="spin">搜索中…</div>';
  // 按 ID 直达：直接确认该人并拿姓名（跳过重名消歧列表）。
  if (searchMode === 'id') {
    if (!/^\d+$/.test(q)) { box.innerHTML = '<div class="muted">ID 需为纯数字；要按名字找人请切到「按名字」。</div>'; return; }
    try {
      const m = await detail('id=' + encodeURIComponent(q) + '&zone=ALL&only=head', signal);
      if (stale()) return;
      if (!m || !m.player || !m.player.name) { box.innerHTML = '<div class="muted">没找到 ID 为「' + esc(q) + '」的选手，可切到「按名字」搜索。</div>'; return; }
      const comp = kvMap(m.comprehensive || []);
      box.innerHTML = itemHTML({ player_id: q, player_name: m.player.name, player_avatar: m.player.avatar || '', sects: [], total_point: comp.total_point });
      prefetchPlayer(q, signal);   // 已锁定该人：后台预热全量，点“资料”/加入对比即秒开
    } catch (e) {
      if (bail(e)) return;
      box.innerHTML = '<div class="muted">没找到 ID 为「' + esc(q) + '」的选手，可切到「按名字」搜索。</div>';
    }
    return;
  }
  // 按名字：宽匹配 → 前端按相关度排序，最相关者置顶并预热其全量。
  try {
    const list = await searchPlayers(q, signal);
    if (stale()) return;
    const arr = rankByRelevance(Array.isArray(list) ? list : (list.items || []), q);
    box.innerHTML = arr.length ? arr.map(itemHTML).join("") : '<div class="muted">没找到「' + esc(q) + '」</div>';
    if (arr.length) prefetchPlayer(arr[0].player_id, signal);   // 预热相关度最高者
  } catch (e) {
    if (bail(e)) return;
    box.innerHTML = '<div class="err">搜索失败：' + esc(e.message) + '</div>';
  }
}

// —— 选手详情：作用域请求后端 ——
export async function openPlayer(id) {
  setView('detail');   // 接管 #detail；对比表(compare.js)的迟到回调据此让位，不再互相覆盖
  $("#results").innerHTML = "";
  if (V && V.abort) V.abort.abort();
  V = newState(id);
  await fetchDetail({ spinner: true, initial: true, twoPhase: true });
}

// 只把作用域(赛区/赛季/门派)传给后端；表内交互态是页面本地的。only='head' 时只取 stats 出头部（第一阶段）。
function buildQS(st, only) {
  const p = new URLSearchParams();
  p.set('id', st.id); p.set('zone', st.zone);
  if (st.season) p.set('season', st.season);
  if (st.sect) p.set('sect', st.sect);
  if (only) p.set('only', only);
  return p.toString();
}

export function detailLoadingHTML(stage = 0, initial = true) {
  const first = [
    ['正在处理数据', '首次查询可能需要一点时间，请耐心等待。'],
    ['数据仍在处理中', '程序正在正常运行，请耐心等待，不要重复点击。'],
    ['数据较多，仍在处理', '请继续耐心等待，处理完成后会自动显示结果。'],
  ];
  const again = [['正在处理数据', '请耐心等待。']];
  const steps = initial ? first : again;
  const [title, tip] = steps[Math.min(Math.max(stage, 0), steps.length - 1)];
  return `<div class="loading-card" role="status" aria-live="polite">
    <span class="loading-pulse" aria-hidden="true"></span>
    <div><b>${title}</b><span>${tip}</span></div>
  </div>`;
}

function showDetailLoading(st, gen, initial) {
  const timers = [];
  const paint = stage => {
    if (V === st && st.gen === gen && (!initial || !st.model) && currentView() === 'detail') $("#detail").innerHTML = detailLoadingHTML(stage, initial);
  };
  paint(0);
  if (initial) {
    timers.push(setTimeout(() => paint(1), 6000));
    timers.push(setTimeout(() => paint(2), 18000));
  }
  return () => timers.forEach(clearTimeout);
}

// fetchDetail 取作用域模型并渲染。state+gen 双校验规避“切换选手/连点作用域”的竞态。
// twoPhase：head/firstpage/full 三路并发、到一路渲一路——head(仅 stats)秒出头部、firstpage 补首屏表格、
// full 补全量+角色+筛选。三者独立发起：head 即便因 stats 5xx/非法 JSON（非鉴权）失败，也不放弃 full——
// full 仍可能带回逐场（stats 失败但 games 成功即部分降级，逐场区可用、统计区报错）。仅 401 直接走鉴权失效流程。
// 季/门派切换逐场索引已缓存，单阶段即快。
async function fetchDetail(opts = {}) {
  const st = V, gen = ++st.gen;
  if (st.abort) st.abort.abort();
  st.abort = new AbortController();
  const signal = st.abort.signal;
  let stopLoading = () => {};
  if (opts.spinner || !st.model) stopLoading = showDetailLoading(st, gen, !!opts.initial || !st.model);
  const stale = () => V !== st || st.gen !== gen;
  const clearLoading = () => { if (!stale()) st.gamesLoading = false; };
  const ignorable = e => e && (e.name === 'AbortError' || e.name === 'LocalServerError');
  try {
    if (opts.twoPhase) {
      st.gamesLoading = true;
      // 三路并发发起；head/firstpage 慢或失败都不拖住彼此，full 独立进行。
      const headP = detail(buildQS(st, 'head'), signal);
      const previewP = detail(buildQS(st, 'firstpage'), signal).catch(e => ({ __err: e }));
      const fullP = detail(buildQS(st), signal);
      fullP.catch(() => {});   // 防“head 401 提前抛出”时 full 变未处理拒绝；真正的值/错误仍由下方 await 取

      // 头部：stats 一到即渲染。非 401 失败不 bail——继续等 full 兜底。
      try {
        const head = await headP;
        if (stale()) return;
        st.model = head; stopLoading(); stopLoading = () => {}; renderDetail();
      } catch (e) {
        if (stale() || ignorable(e)) { clearLoading(); return; }
        if (e.status === 401) throw e;   // 鉴权失效：交下方统一处理（req 已触发 onAuthLost）
        // 非 401（stats 5xx/非法 JSON）：头部暂缺，继续等 full
      }

      // 首屏预览：到了就补进表格（失败静默，full 会给真状态）。
      const preview = await previewP;
      if (stale()) return;
      if (preview && !preview.__err && st.gamesLoading && st.model) {
        st.model = { ...st.model, games: preview.games, games_total: preview.games_total, games_total_known: preview.games_total_known };
        renderDetail();
      }

      // 全量：权威完整模型（可能自带 stats_error/games_error 的部分降级）。
      const full = await fullP;
      if (stale()) return;
      st.model = full; st.gamesLoading = false; renderDetail();
      return;
    }
    const full = await detail(buildQS(st), signal);
    if (stale()) return;
    st.model = full; st.gamesLoading = false; renderDetail();
  } catch (e) {
    if (stale() || ignorable(e)) { clearLoading(); return; }
    clearLoading();
    if (e.status === 401) { if (!st.model) paintDetail('<div class="err">登录信息已过期，请重新登录。</div>'); else renderDetail(); return; }
    // 已有头部（全量阶段失败）：保留头部，仅逐场区报错；否则整块报错。
    if (st.model) { st.model = { ...st.model, games_error: st.model.games_error || e.message }; renderDetail(); }
    else paintDetail('<div class="err">获取失败：' + esc(e.message) + '</div>');
  } finally {
    stopLoading();
  }
}

// —— 筛选器事件 ——
export function pick(kind, el) {
  const v = (el.value || '').trim();
  if (!v) { el.value = el.dataset.prev || ''; return; }
  if (kind === 'zone') onFZone(v); else if (kind === 'season') onFSeason(v); else onFSect(v);
}
function resetGF() { V.gf = { result: '', camp: '', role: '', sect: '', mark: '' }; }
function onFZone(val) {
  V.zone = resolveZone(val, (V.model && V.model.joined) || []);
  V.season = ''; V.sect = ''; V.limit = PAGE; resetGF();
  fetchDetail({ spinner: true, twoPhase: true });   // 换赛区：逐场索引换 games|zone 键、需重拉，两阶段先出头部
}
function onFSeason(val) {
  V.season = (String(val).match(/\d+/) || [''])[0]; V.limit = PAGE; resetGF();
  fetchDetail({ spinner: true });
}
function onFSect(val) {
  const v = String(val || '').trim();
  V.sect = (v && v !== '全部门派') ? v : ''; V.limit = PAGE;
  fetchDetail();   // 门派换作用域：Go 从已缓存逐场现算，无需 spinner
}
// 表内交互：纯本地重渲染，不请求后端（作用域数据已在 model.games / model.roles 里）
export function showMore() { V.limit += PAGE; renderDetail(); }
export function sortGames(key) { if (V.sort.key === key) V.sort.dir *= -1; else V.sort = { key, dir: -1 }; renderDetail(); }
export function setRoleSort(key) { const s = V.roleSort || { key: 'n', dir: -1 }; if (s.key === key) s.dir *= -1; else { s.key = key; s.dir = -1; } V.roleSort = s; renderDetail(); }
export function setEditionSort(key) { const s = V.editionSort || { key: 'n', dir: -1 }; if (s.key === key) s.dir *= -1; else { s.key = key; s.dir = -1; } V.editionSort = s; renderDetail(); }
export function setGF(kind, val) { V.gf[kind] = val; V.limit = PAGE; renderDetail(); }
export function setDetailTab(tab) {
  if (!V || !['overview', 'roles', 'editions', 'games'].includes(tab)) return;
  V.detailTab = tab; renderDetail();
}

// 纯 HTML 构造器：输入状态 st（含后端模型 st.model + 表内交互态），输出详情区 HTML（无 DOM 副作用，便于单测）
export function renderDetailHTML(st) {
  const m = st.model;
  if (!m) return detailLoadingHTML(0, true);
  const p = m.player || {}, pid = p.id || st.id;
  const zone = m.zone, season = m.season, sect = m.sect;
  const zName = zone === 'ALL' ? '全部赛区' : zoneName(zone, m.joined);
  const scopeTxt = `${zName} / ${season ? ('S' + season) : '全部赛季'}${sect ? (' / ' + sect) : ''}`;
  const sc = `<small>· ${esc(scopeTxt)}</small>`;
  const errBox = msg => `<div class="err" style="padding:16px">获取失败：${esc(msg)}</div>`;

  // 键值列表 → map（取头部指标用）
  const comp = kvMap(m.comprehensive), good = kvMap(m.good);
  const mRounds = metricOf(comp, 'round_total'), mAvg = metricOf(comp, 'round_point_avg'), mWin = metricOf(comp, 'win_pct', true);
  const mToulang = metricOf(good, 'toulang_pct', true), mZhanbian = metricOf(good, 'zhanbian_pct', true);   // 门派维度这些键不存在 → —

  const honorsInline = (m.honors || []).map(h => `<span class="badge">${esc(honorZoneName(h.zone_id, m.joined))} S${h.season_id} ${String(h.code) === '1' ? '冠军' : '第' + h.code + '名'}</span>`).join("");
  // gamesLoading：两阶段第一步已出头部、逐场仍在后台加载。逐场/角色/队伍区显示“加载中”而非“无数据”。
  const gamesLoading = !!st.gamesLoading && !m.games_error;
  const teamsHtml = m.games_error ? '<span class="none">—</span>' : (gamesLoading ? '<span class="none">加载中…</span>' : ((m.teams && m.teams.length) ? m.teams.map(c => `<span class="tm">${esc(c)}</span>`).join('') : '<span class="none">—</span>'));

  // 聚合方块：fmt 补中文标签/百分比；好人局隐藏 htsp_num，狼人局隐藏 bgx_num
  const tilesHTML = (arr, hide) => {
    const e = (arr || []).filter(t => t.key !== '' && !(hide || []).includes(t.key));
    if (!e.length) return '<div class="muted" style="padding:2px 0">暂无数据</div>';
    return '<div class="grid">' + e.map(t => { const f = fmt(t.key, t.val); return `<div class="tile"><b>${esc(f.val)}</b><span>${esc(f.name)}</span></div>`; }).join("") + '</div>';
  };
  const section = (title, arr, hide) => `<div class="sec"><h3>${title} ${sc}</h3>${tilesHTML(arr, hide)}</div>`;
  const scErr = sect ? m.games_error : m.stats_error;
  const statsHtml = scErr
    ? `<div class="sec"><h3>🎯 综合 ${sc}</h3>${errBox(scErr)}</div>`
    : section('🎯 综合', m.comprehensive) + section('😇 好人局', m.good, ['htsp_num']) + section('🐺 狼人局', m.wolf, ['bgx_num']);

  const games = m.games || [];

  // —— 角色表现表（客户端排序）——
  let roleHtml = '';
  if (m.roles && m.roles.length) {
    const rs = st.roleSort || { key: 'n', dir: -1 };
    const rrows = sortRows(m.roles, rs.key, rs.dir);
    const rth = (k, l) => sortableTh('setRoleSort', k, l, rs);
    roleHtml = `<div class="sec"><h3>🎭 角色表现 ${sc}</h3></div>
      <div class="tbl-wrap" style="padding:0 16px 6px"><table><thead><tr><th>身份</th>${rth('n', '场次')}${rth('avg', '场均分')}${rth('win', '胜率')}${rth('mvp', 'MVP')}${rth('svp', '尽力')}${rth('bgx', '背锅')}</tr></thead><tbody>${rrows.map(r => `<tr><td style="color:${roleColor(r.role)}${roleWeight(r.role)}">${esc(r.role)}</td><td>${r.n}</td><td>${r.avg}</td><td>${r.win}%</td><td>${r.mvp || ''}</td><td>${r.svp || ''}</td><td>${r.bgx || ''}</td></tr>`).join("")
      }</tbody></table></div>`;
  } else if (gamesLoading) {
    roleHtml = `<div class="sec"><h3>🎭 角色表现 ${sc}</h3><div class="muted" style="padding:2px 16px 8px">加载中…</div></div>`;
  } else if (m.games_error) {
    roleHtml = `<div class="sec"><h3>🎭 角色表现 ${sc}</h3>${errBox(m.games_error)}</div>`;
  } else {
    roleHtml = `<div class="sec"><h3>🎭 角色表现 ${sc}</h3><div class="muted" style="padding:2px 16px 8px">暂无角色表现</div></div>`;
  }

  // —— 版型表现表（逐场里的 edition_name 由 Go 聚合）——
  let editionHtml = '';
  if (m.editions && m.editions.length) {
    const es = st.editionSort || { key: 'n', dir: -1 };
    const erows = sortRows(m.editions, es.key, es.dir);
    const eth = (k, l) => sortableTh('setEditionSort', k, l, es);
    editionHtml = `<div class="sec"><h3>🧩 版型表现 ${sc}</h3></div>
      <div class="tbl-wrap" style="padding:0 16px 6px"><table><thead><tr><th>版型</th>${eth('n', '场次')}${eth('avg', '场均分')}${eth('win', '胜率')}${eth('molang', '摸狼率')}${eth('mvp', 'MVP')}${eth('svp', '尽力')}${eth('bgx', '背锅')}</tr></thead><tbody>${erows.map(r => `<tr><td><b>${esc(r.edition)}</b></td><td>${r.n}</td><td>${r.avg}</td><td>${r.win}%</td><td>${r.molang}%</td><td>${r.mvp || ''}</td><td>${r.svp || ''}</td><td>${r.bgx || ''}</td></tr>`).join('')
      }</tbody></table></div>`;
  } else if (gamesLoading) {
    editionHtml = `<div class="sec"><h3>🧩 版型表现 ${sc}</h3><div class="muted" style="padding:2px 16px 8px">加载中…</div></div>`;
  } else if (m.games_error) {
    editionHtml = `<div class="sec"><h3>🧩 版型表现 ${sc}</h3>${errBox(m.games_error)}</div>`;
  } else {
    editionHtml = `<div class="sec"><h3>🧩 版型表现 ${sc}</h3><div class="muted" style="padding:2px 16px 8px">暂无版型表现</div></div>`;
  }

  // —— 逐场战绩表（客户端：多维筛选 + 排序 + 分页）——
  const gf = st.gf, sort = st.sort, limit = st.limit;
  let tg = games.slice();
  if (gf.result === 'w') tg = tg.filter(g => +g.win === 1); else if (gf.result === 'l') tg = tg.filter(g => +g.win !== 1);
  if (gf.camp === 'good') tg = tg.filter(g => isGoodCamp(g.rpt_name)); else if (gf.camp === 'wolf') tg = tg.filter(g => !isGoodCamp(g.rpt_name));
  if (gf.role) tg = tg.filter(g => g.rpt_name === gf.role);
  if (gf.sect) tg = tg.filter(g => g.sect_name === gf.sect);
  if (gf.mark === 'mvp') tg = tg.filter(g => +g.mvp === 1); else if (gf.mark === 'svp') tg = tg.filter(g => +g.svp === 1); else if (gf.mark === 'bgx') tg = tg.filter(g => +g.bgx === 1);
  const sk = (sort.key === 'play_date' || sort.key === 'total_point') ? sort.key : 'play_date', sd = sort.dir;
  tg.sort((a, b) => { if (sk === 'play_date') { const x = a.play_date || '', y = b.play_date || ''; return sd * (x < y ? -1 : x > y ? 1 : 0); } return sd * ((+a[sk] || 0) - (+b[sk] || 0)); });
  const shown = tg.slice(0, limit);
  const gameRow = g => {
    const marks = [];
    if (g.mvp) marks.push('<span class="gm mvp">MVP</span>');
    if (g.svp) marks.push('<span class="gm svp">尽力</span>');
    if (g.bgx) marks.push('<span class="gm bgx">背锅</span>');
    const res = +g.win === 1 ? '<span class="res w">胜</span>' : '<span class="res l">负</span>';
    return `<tr class="grow" onclick="openGame(${g.game_id})" onmouseenter="prefetchGame(${g.game_id})">
      <td>${esc(g.play_date || '')}</td><td>S${g.season_id ?? ''}</td><td>${g.round ?? ''}</td><td>${g.seat ?? ''}</td>
      <td>${esc(g.sect_name || '')}</td><td style="color:${roleColor(g.rpt_name)}${roleWeight(g.rpt_name)}">${esc(g.rpt_name || '')}</td><td>${g.total_point ?? ''}</td><td>${res}</td><td>${marks.join('')}</td></tr>`;
  };
  const rows = shown.map(gameRow).join("");
  const th = (k, l) => sortableTh('sortGames', k, l, sort);
  const qf = (kind, val, l) => `<span class="qf${gf[kind] === val ? ' on' : ''}" onclick="setGF('${kind}','${val}')">${l}</span>`;
  const roleOpts = uniq(games.map(g => g.rpt_name)).filter(Boolean).sort();
  const tSectOpts = uniq(games.map(g => g.sect_name)).filter(Boolean).sort();
  const qsel = (kind, cur, opts) => `<select class="qsel" onchange="setGF('${kind}',this.value)"><option value="">全部</option>${opts.map(o => `<option value="${esc(o)}"${o === cur ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
  const qg = (label, inner) => `<span class="qg"><label>${label}</label>${inner}</span>`;
  const qfbar = `<div class="qfbar">`
    + qg('身份', qsel('role', gf.role, roleOpts))
    + qg('门派', qsel('sect', gf.sect, tSectOpts))
    + qg('结果', `${qf('result', '', '全部')}${qf('result', 'w', '胜')}${qf('result', 'l', '负')}`)
    + qg('阵营', `${qf('camp', '', '全部')}${qf('camp', 'good', '好人')}${qf('camp', 'wolf', '狼')}`)
    + qg('标记', `${qf('mark', '', '全部')}${qf('mark', 'mvp', 'MVP')}${qf('mark', 'svp', '尽力')}${qf('mark', 'bgx', '背锅')}`)
    + `</div>`;
  let gamesBody;
  if (m.games_error) { gamesBody = errBox(m.games_error); }
  else if (gamesLoading && games.length) {
    // 部分加载：首屏已到、其余后台补齐。展示已到行（日期倒序），禁用筛选/排序/加载更多——
    // 全量到齐前这些若按部分数据算会误导；恒为默认视图，是最终结果的正确前缀。
    const pr = games.slice()
      .sort((a, b) => { const x = a.play_date || '', y = b.play_date || ''; return x < y ? 1 : x > y ? -1 : 0; })
      .map(gameRow).join("");
    const total = (m.games_total > 0) ? m.games_total : games.length;   // 后端已归一未知总数；此处再兜一层，绝不显示负数/0
    // 总数确定(官方给了 total_items)才写“共 N 场”；未知则只说“已显示前 N 场”，不谎报一个可能偏小的确定数。
    const note = m.games_total_known
      ? `<div class="muted" style="padding:0 0 6px">共 ${total} 场 · 正在加载完整战绩，筛选和排序稍后可用。</div>`
      : `<div class="muted" style="padding:0 0 6px">已显示 ${games.length} 场 · 正在加载完整战绩，筛选和排序稍后可用。</div>`;
    const head = `<tr><th>日期</th><th>赛季</th><th>轮</th><th>座</th><th>门派</th><th>身份</th><th>分</th><th>结果</th><th>标识</th></tr>`;
    gamesBody = note + `<div class="tbl-wrap"><table><thead>${head}</thead><tbody>${pr}</tbody></table></div>`;
  }
  else if (gamesLoading) {
    // 首页行尚未到（或首页失败前）：占位。
    gamesBody = `<div class="loading-card" role="status" aria-live="polite"><span class="loading-pulse" aria-hidden="true"></span><div><b>正在加载逐场战绩</b><span>该选手对局较多时需要一点时间，加载完成后自动显示。</span></div></div>`;
  }
  else if (!games.length) { gamesBody = '<div class="muted">无战绩</div>'; }
  else {
    const truncNote = m.games_trunc ? '<div class="err" style="padding:0 0 6px">⚠ 战绩较多，当前仅展示部分数据。</div>' : '';
    const tbl = tg.length
      ? `<div class="tbl-wrap"><table><thead><tr>${th('play_date', '日期')}<th>赛季</th><th>轮</th><th>座</th><th>门派</th><th>身份</th>${th('total_point', '分')}<th>结果</th><th>标识</th></tr></thead><tbody>${rows}</tbody></table></div>`
      + (tg.length > limit ? `<button class="morebtn" onclick="showMore()">加载更多（还有 ${tg.length - limit} 场）</button>` : '')
      : '<div class="muted">当前筛选无匹配</div>';
    gamesBody = qfbar + truncNote + `<div class="muted" style="padding:0 0 6px">共 ${tg.length} 场 · 点任意一场看复盘（阵容 · 投票 · 技能）</div>` + tbl;
  }
  const gamesHtml = `<div class="sec"><h3>🗒️ 逐场战绩 ${sc}</h3></div><div style="padding:0 16px 16px">${gamesBody}</div>`;

  // —— 筛选器候选 datalist ——
  const opt = arr => (arr || []).map(t => `<option value="${esc(t)}">`).join("");
  const zoneLabel = zone === 'ALL' ? '' : zName;
  const zoneOpts = opt(['全部赛区', ...((m.joined || []).map(j => j.text))]);
  const seasonOpts = opt(['全部赛季', ...((m.season_cands || []).map(n => 'S' + n))]);
  const sectOpts = opt(['全部门派', ...(m.sect_cands || [])]);
  const detailTab = ['overview', 'roles', 'editions', 'games'].includes(st.detailTab) ? st.detailTab : 'overview';
  const tab = (key, label) => `<button class="detail-tab${detailTab === key ? ' active' : ''}" role="tab" aria-selected="${detailTab === key}" onclick="setDetailTab('${key}')">${label}</button>`;
  const activeSection = { overview: statsHtml, roles: roleHtml, editions: editionHtml, games: gamesHtml }[detailTab] || statsHtml;

  return `
    <div class="bar" style="margin-bottom:12px">
      <div class="line">
        <div class="f"><label>赛区</label><input id="fzone" list="dlzone" placeholder="全部赛区" value="${esc(zoneLabel)}" autocomplete="off" onfocus="this.dataset.prev=this.value;this.value=''" onblur="if(!this.value)this.value=this.dataset.prev||''" onchange="pick('zone',this)"><datalist id="dlzone">${zoneOpts}</datalist></div>
        <div class="f"><label>赛季</label><input id="fseason" list="dlseason" placeholder="全部赛季" value="${season ? ('S' + esc(season)) : ''}" autocomplete="off" onfocus="this.dataset.prev=this.value;this.value=''" onblur="if(!this.value)this.value=this.dataset.prev||''" onchange="pick('season',this)"><datalist id="dlseason">${seasonOpts}</datalist></div>
        <div class="f"><label>门派</label><input id="fsect" list="dlsect" placeholder="全部门派" value="${esc(sect || '')}" autocomplete="off" onfocus="this.dataset.prev=this.value;this.value=''" onblur="if(!this.value)this.value=this.dataset.prev||''" onchange="pick('sect',this)"><datalist id="dlsect">${sectOpts}</datalist></div>
      </div>
    </div>
    <div class="pcard">
      <div class="phead">
        <img class="pphoto" src="${esc(p.avatar || '')}" onerror="this.style.visibility='hidden'">
        <div class="pinfo">
          <div class="prow"><span class="name">${esc(p.name || ('#' + pid))}</span><span class="id">#${esc(pid)}</span>${honorsInline}<span class="infohint" onclick="this.classList.toggle('open')" title="数据说明">ⓘ<span class="infobubble">数据不会自动刷新。想查看最新数据，请关闭本程序再重新打开。</span></span></div>
          <div class="pstat">
            <div class="pw-hero"><b>${esc(m.power == null ? '—' : m.power)}</b><span>战力值</span></div>
            <div class="pmetrics">
              <div class="pmetric"><b>${esc(mRounds)}</b><span>总场次</span></div>
              <div class="pmetric"><b>${esc(mAvg)}</b><span>场均分</span></div>
              <div class="pmetric"><b>${esc(mWin)}</b><span>胜率</span></div>
              <div class="pmetric"><b>${esc(mToulang)}</b><span>投狼率</span></div>
              <div class="pmetric"><b>${esc(mZhanbian)}</b><span>站对边率</span></div>
            </div>
          </div>
        </div>
      </div>
      <div class="teams">${teamsHtml}</div>
      <div class="detail-tabs" role="tablist" aria-label="个人数据分类">${tab('overview', '概览')}${tab('roles', '角色表现')}${tab('editions', '版型表现')}${tab('games', '逐场战绩')}</div>
      <div class="detail-panel" role="tabpanel">${activeSection}</div>
    </div>`;
}
// 只有当 #detail 仍归属单人详情时才写入（对比表可能已接管；异步回调据此让位，避免互相覆盖）。
function paintDetail(html) { if (currentView() === 'detail') $("#detail").innerHTML = html; }
function renderDetail() { paintDetail(renderDetailHTML(V)); }

// —— 单场牌局详情弹层（纯展示，前端排版）——
function getGame(gid) {
  if (!V.gameCache[gid]) V.gameCache[gid] = fetchGame(gid).catch(e => { delete V.gameCache[gid]; throw e });
  return V.gameCache[gid];
}
// 悬停预取：鼠标移到某场行上就先拉+分析该局（服务端按 gid 缓存），点开时通常已就绪、秒开。
// 每局至多触发一次（gameCache 记忆化）；预取失败静默，点击时会照常重取。
export function prefetchGame(gid) {
  if (!V || gid == null) return;
  try { getGame(gid).catch(() => {}); } catch (e) { /* V 无或已切换：忽略 */ }
}
export async function openGame(gid) {
  const ov = $("#ov"); ov.style.display = 'flex';
  ov.innerHTML = '<div class="ov-card"><div class="ov-head"><b>对局 #' + gid + '</b><span class="ov-close" onclick="closeGame()">关闭</span></div><div class="spin">加载对局…</div></div>';
  // 当前选手在该局的逐场行（含 bgx——form2 里没有 per-seat 背锅，只有此处有当前选手的背锅标识）
  curMeRow = ((V.model && V.model.games) || []).find(r => String(r && r.game_id) === String(gid)) || null;
  try { renderGame(await getGame(gid)); }
  catch (e) {
    if (e && e.name === 'LocalServerError') return;
    ov.innerHTML = '<div class="ov-card"><div class="ov-head"><b>对局 #' + gid + '</b><span class="ov-close" onclick="closeGame()">关闭</span></div><div class="err">获取失败：' + esc(e.message) + '</div></div>';
  }
}
export function closeGame() { const ov = $("#ov"); ov.style.display = 'none'; ov.innerHTML = ''; curGame = null; }

let curGame = null, gameMode = 'seat', curMeRow = null;
function renderGame(g) { curGame = g; $("#ov").innerHTML = renderGameHTML(g, V.id, gameMode, curMeRow); }
export function setGameMode(mode) { gameMode = mode; if (curGame) $("#ov").innerHTML = renderGameHTML(curGame, V.id, gameMode, curMeRow); }

const voted = v => v != null && v !== '' && String(v) !== '0';

// 一条 analysis 投票的“→目标”内联片段：只给箭头着色(投狼绿/投好人红)，名字/角色保持默认色；弃票单列，警长★。
function voteInline(v, bySeat) {
  if (!v) return '';
  if (v.abstain) return `<span class="sk-arrow">→</span><span class="v-abst">弃票</span>`;
  const star = v.badge ? '<span class="star" title="警长1.5票">★</span>' : '';
  const t = bySeat.get(Number(v.target));
  const cls = voteHitClass(t ? t.rpt_name : '');
  const tgt = t ? `${v.target}号 ${esc(t.player_name || '')}·${esc(t.rpt_name || '')}` : `${v.target || '?'}号`;
  return `${star}<span class="sk-arrow ${cls}">→</span>${tgt}`;
}

// 座位视图。dead: seat→死亡记录；vbs: seat→[{d,v}]（放逐投票，来自 analysis）。
function seatBody(rows, days, g, meId, dead, vbs, bySeat) {
  const outTag = s => { const d = dead.get(Number(s.seat)); return d ? `<span class="out-tag">出局·第${d.day}${d.phase === 'night' ? '夜' : '天'}</span>` : ''; };
  const voteCell = s => {
    const parts = (vbs.get(Number(s.seat)) || []).slice().sort((a, b) => a.d - b.d)
      .map(({ d, v }) => `D${d}${voteInline(v, bySeat)}`);
    if (voted(s.vote_jinhui)) parts.push('警徽→' + esc(String(s.vote_jinhui).replace(/^\*/, '')) + '号');
    return parts.join('　') || '—';
  };
  const rowHtml = rows.map(s => {
    const out = dead.has(Number(s.seat));
    const cls = (s.player_id === meId ? 'me' : '') + (out ? ' out' : '');
    return `<tr${cls ? ` class="${cls.trim()}"` : ''}><td>${s.seat}</td>
      <td><div class="pn">${esc(s.player_name || '')}</div><div class="sc">${esc(s.sect_name || '')}</div></td>
      <td style="color:${campColor(s.rpt_name)}${roleWeight(s.rpt_name)}">${esc(s.rpt_name || '')}</td>
      <td>${voteCell(s)}</td><td>${seatSkills(s)}</td><td>${seatMarks(s, g)}${outTag(s)}</td></tr>`;
  }).join("");
  const cardHtml = rows.map(s => {
    const out = dead.has(Number(s.seat));
    const marks = seatMarks(s, g) + outTag(s);
    return `<div class="seat-card${s.player_id === meId ? ' me' : ''}${out ? ' out' : ''}">
      <div class="seat-card-h"><span class="seat-no">${s.seat}</span><b>${esc(s.player_name || '')}</b><span class="sc">${esc(s.sect_name || '')}</span><span class="seat-role" style="color:${campColor(s.rpt_name)}${roleWeight(s.rpt_name)}">${esc(s.rpt_name || '')}</span></div>
      <div class="day-line"><span class="day-k">投票</span>${voteCell(s)}</div>
      <div class="day-line"><span class="day-k">技能</span>${seatSkills(s)}</div>
      ${marks ? `<div class="day-line"><span class="day-k">标记</span>${marks}</div>` : ''}
    </div>`;
  }).join("");
  return `<div class="seat-wide tbl-wrap"><table class="gt"><thead><tr><th>座</th><th>玩家 / 门派</th><th>身份</th><th>投票</th><th>技能</th><th>标记</th></tr></thead><tbody>${rowHtml}</tbody></table></div>
    <div class="seat-narrow">${cardHtml}</div>`;
}

// 按天视图（方案A：彩色文字行）。每天顺序：技能 → 警徽竞选(仅第1天) → 投票制表 → 事件。
// 行动方 / 目标统一用 seatRef 标注「座号 名字·角色」；狼刀按“同天同目标”合并成一条并列出狼队。
const dayBlock = (title, inner) => inner ? `<div class="day-block"><div class="day-bh">${title}</div>${inner}</div>` : '';
const actorTag = s => `${s.seat}号${esc(s.player_name || '')}`;

function daySkills(rows, bySeat, d) {
  const killers = new Map();   // 目标座位串 → [发动座位]（狼刀合并用）
  const lines = [];
  rows.forEach(s => (s.skills || []).forEach(k => {
    if (!k || k.day !== d || !Array.isArray(k.target_seats) || !k.target_seats.length) return;
    const verb = skillLabel(k.name, s.rpt_name);
    const wolf = isWolf(s.rpt_name) || WOLFSIDE.has(s.rpt_name);
    if (wolf && (verb === '刀' || /刀/.test(k.name || ''))) {          // 狼刀 → 合并
      const key = k.target_seats.join(',');
      (killers.get(key) || killers.set(key, []).get(key)).push(s.seat);
      return;
    }
    const emo = `<span class="sk-emo">${roleEmoji(s.rpt_name)}</span>`;
    const role = `<b class="sk-role" style="color:${campColor(s.rpt_name)}${roleWeight(s.rpt_name)}">${esc(s.rpt_name || '')}</b>`;
    if (skillText(k, s.rpt_name, s.seat) === '顶盾') {                  // 怪盗狼王顶盾：无目标
      lines.push(`<div class="sk-line">${emo}${role} ${actorTag(s)} <span class="sk-verb">顶盾</span></div>`);
      return;
    }
    const tgt = k.target_seats.map(t => seatRef(t, bySeat)).join('、');
    lines.push(`<div class="sk-line">${emo}${role} ${actorTag(s)} <span class="sk-verb">${esc(verb)}</span><span class="sk-arrow">→</span>${tgt}</div>`);
  }));
  // 狼刀合并成一条，只列目标——不再显示发动的狼队成员（身份已在花名册/座位表体现）。
  const kills = [...killers.entries()].map(([key]) => {
    const tgt = key.split(',').map(t => seatRef(t, bySeat)).join('、');
    return `<div class="sk-line"><span class="sk-emo">🐺</span><b class="sk-role" style="color:${campColor('狼')}">狼刀</b> <span class="sk-arrow">→</span>${tgt}</div>`;
  });
  return dayBlock('技能', [...kills, ...lines].join('') || '<span class="day-none">—</span>');
}

const votePair = (from, to) => `<span class="vote-pair">${from}<span class="sk-arrow">→</span>${esc(to)}</span>`;

function dayBadge(rows, bySeat) {
  const votes = rows.filter(s => voted(s.vote_jinhui)).sort((a, b) => a.seat - b.seat)
    .map(s => votePair(s.seat, String(s.vote_jinhui).replace(/^\*/, '') + '号'));
  const winner = rows.find(s => Number(s.day_of_jinhui) === 1);
  const win = winner ? `<div class="badge-win">当选 <span class="star">★</span> ${seatRef(winner.seat, bySeat)}</div>` : '';
  const vote = votes.length ? `<div class="day-line"><span class="day-k">警徽投票</span>${votes.join('')}</div>` : '';
  return dayBlock('警徽竞选', win + vote);
}

// 投票制表：逐票着色 + 放逐结果/平安白天（来自 analysis）。
// 投票制表：按“被投目标”归并同投一人的票，每个目标一行（弃票单独成组、置末）。
// 箭头按目标阵营着色（投狼绿 vhit / 投好人红 vmiss），号码两侧都标「座号 名字·身份」但不给身份上色——
// 与逐票视图一致：只有箭头有颜色。放逐结果/平安白天来自 analysis。
function dayVotes(votes, exile, bySeat) {
  if (!votes || !votes.length) return dayBlock('投票', '<span class="day-none">—</span>');
  const plainRef = seat => {   // 「座号 名字·身份」——不着色（身份色只在别处用）
    const s = bySeat.get(Number(seat));
    return s ? `${seat}号 ${esc(s.player_name || '')}·${esc(s.rpt_name || '')}` : `${esc(String(seat))}号`;
  };
  const groups = new Map();   // 目标座号（或 'abstain'）→ [vote,...]
  votes.slice().sort((a, b) => a.seat - b.seat).forEach(v => {
    const key = v.abstain ? 'abstain' : String(v.target);
    (groups.get(key) || groups.set(key, []).get(key)).push(v);
  });
  const keys = [...groups.keys()].sort((a, b) => ((a === 'abstain') - (b === 'abstain')) || (Number(a) - Number(b)));
  const rows = keys.map(key => {
    const vs = groups.get(key);
    const from = vs.map(v => `${plainRef(v.seat)}${v.badge ? '<span class="star" title="警长1.5票">★</span>' : ''}`).join('、');
    if (key === 'abstain') return `<div class="vote-row"><span class="v-from">${from}</span><span class="sk-arrow">→</span><span class="v-abst">弃票</span></div>`;
    const t = bySeat.get(Number(key));
    const cls = voteHitClass(t ? t.rpt_name : '');
    return `<div class="vote-row"><span class="v-from">${from}</span><span class="sk-arrow ${cls}">→</span><span class="v-to">${plainRef(key)}</span></div>`;
  }).join('');
  let result = '';
  if (exile) {
    if (exile.peaceful) result = `<div class="exile-line peace">平安白天 · 无人放逐</div>`;
    else if (exile.seat) result = `<div class="exile-line">放逐 <span class="star">▶</span> ${seatRef(exile.seat, bySeat)}` +
      (exile.tally && exile.tally.length ? ` <span class="tally">（${exile.tally.map(t => t.seat + '号' + fmtVotes(t.votes) + '票').join('，')}）</span>` : '') + `</div>`;
  }
  return dayBlock('投票', `<div class="vote-list">${rows}</div>` + result);
}
const fmtVotes = w => String(w);

function dayEvents(rows, d) {
  const ev = [];
  rows.forEach(s => {
    if (s['zibao' + d]) ev.push(`${actorTag(s)} 自爆`);
    if (Number(s.day_of_hantiao) === d) ev.push(`${actorTag(s)} 悍跳${s.hantiao_rpt_name ? esc(s.hantiao_rpt_name) : ''}`);
    if (d > 1 && Number(s.day_of_jinhui) === d) ev.push(`${actorTag(s)} 警徽转移`);   // 第1天当选已在“警徽竞选”里
  });
  return dayBlock('事件', ev.map(e => `<span class="ev-item">${e}</span>`).join(''));
}

function dayBody(rows, days, an, bySeat) {
  const secs = [];
  for (let d = 1; d <= days; d++) {
    const votes = an ? (an.votes && an.votes[d]) : null;
    const exile = an ? (an.exile && an.exile[d]) : null;
    secs.push(`<div class="day-sec"><h4>第 ${d} 天</h4>`
      + daySkills(rows, bySeat, d)
      + (d === 1 ? dayBadge(rows, bySeat) : '')
      + dayVotes(votes, exile, bySeat)
      + dayEvents(rows, d)
      + `</div>`);
  }
  return `<div class="day-view">${secs.join('')}</div>`;
}

// 两队花名册：狼队(特殊身份高亮) vs 好人(神/民)。
function rosterHTML(an, bySeat) {
  if (!an || !an.roster) return '';
  const ro = an.roster;
  const chip = seat => { const s = bySeat.get(Number(seat)); const r = s ? s.rpt_name : ''; return `<span class="rc" style="color:${campColor(r)}${roleWeight(r)}">${seat}号${s ? '·' + esc(s.rpt_name || '') : ''}</span>`; };
  const wolves = (ro.wolf || []).map(chip).join('');
  const gods = (ro.gods || []).map(chip).join('');
  const civ = (ro.civ || []).map(chip).join('');
  return `<div class="roster">
    <div class="rteam wolf"><span class="rk">狼队</span>${wolves}</div>
    <div class="rteam good"><span class="rk">神职</span>${gods}<span class="rk civk">平民</span>${civ}</div>
  </div>`;
}

// 死亡时间线：按序列出出局（中文死因；doubt 标存疑）。
function timelineHTML(an, bySeat) {
  if (!an || !an.deaths || !an.deaths.length) return '';
  const items = an.deaths.map(d => {
    const ph = d.phase === 'night' ? `第${d.day}夜` : `第${d.day}天`;
    return `<span class="tl-item"><span class="tl-day">${ph}</span>${seatRef(d.seat, bySeat)} <span class="tl-cause">${esc(causeText(d.cause))}</span>${d.doubt ? '<span class="tl-doubt">存疑</span>' : ''}</span>`;
  }).join('<span class="tl-sep">›</span>');
  return `<div class="timeline"><span class="tl-k">出局顺序</span>${items}</div>`;
}

// 违规扣分事件（form2.points，客观事实）。
function pointsHTML(points, bySeat) {
  if (!Array.isArray(points) || !points.length) return '';
  const items = points.map(p => {
    const s = bySeat.get(Number(p.seat));
    return `<span class="pt-item">${p.seat}号${s ? esc(s.player_name || '') : ''} <span class="pt-name">${esc(p.name || '')}</span> <span class="pt-val">${p.point}</span></span>`;
  }).join('');
  return `<div class="points"><span class="tl-k">违规扣分</span>${items}</div>`;
}

export function renderGameHTML(g, meId, mode = 'seat', meRow = null) {
  let form2 = g.form2; if (typeof form2 === 'string') { try { form2 = JSON.parse(form2) } catch (e) { form2 = {} } }
  const rows = (form2 && form2.rows) || []; const days = g.day || 1;
  const an = g.analysis || null;
  const bySeat = new Map(rows.map(s => [Number(s.seat), s]));
  // 出局映射 + 放逐投票按座位归集（供座位视图）
  const dead = new Map();
  if (an && an.deaths) an.deaths.forEach(d => { if (!dead.has(d.seat)) dead.set(d.seat, d); });
  const vbs = new Map();
  if (an && an.votes) Object.keys(an.votes).forEach(d => an.votes[d].forEach(v => {
    if (!vbs.has(v.seat)) vbs.set(v.seat, []);
    vbs.get(v.seat).push({ d: +d, v });
  }));

  const win = g.victory_camp === 1 ? '<span class="win good">好人胜</span>' : (g.victory_camp === 2 ? '<span class="win wolf">狼人胜</span>' : '');
  const tab = (mo, l) => `<span class="qf${mode === mo ? ' on' : ''}" onclick="setGameMode('${mo}')">${l}</span>`;
  const mvpTxt = g.mvp_seat ? seatRef(g.mvp_seat, bySeat) : '—';
  const svpTxt = g.svp_seat ? seatRef(g.svp_seat, bySeat) : '—';
  const bgxTxt = meRow && meRow.bgx ? `<span class="mk-bgx">背锅 ${seatRef(meRow.seat, bySeat)}</span>` : '';
  const body = mode === 'day' ? dayBody(rows, days, an, bySeat) : seatBody(rows, days, g, meId, dead, vbs, bySeat);
  return `<div class="ov-card">
    <div class="ov-head">
      <b>${esc(g.play_date || '')}</b>
      <span>${esc((g.edition && g.edition.name) || '')}</span>
      <span>第 ${g.round ?? '?'} 轮 · S${g.season_id ?? ''} · ${esc(g.season_type_label || '')}</span>
      ${win}
      <span>MVP ${mvpTxt} · 尽力 ${svpTxt}</span>
      ${bgxTxt ? `<span>${bgxTxt}</span>` : ''}
      <span>裁判 ${esc(g.referee_name || '—')}</span>
      <span class="ov-tabs">${tab('seat', '按人')}${tab('day', '按天')}</span>
      <span class="ov-close" onclick="closeGame()">关闭</span>
    </div>
    ${rosterHTML(an, bySeat)}
    ${timelineHTML(an, bySeat)}
    ${body}
    ${pointsHTML(form2 && form2.points, bySeat)}
  </div>`;
}

// —— 启动引导页（无有效令牌时整页展示；拿到令牌才进 #app）——
// gateHTML 是纯函数（便于单测）：按精确原因给出提示，并提供自动检测与手动令牌两条入口。
const GATE_WARN = {
  expired: '⚠ 登录令牌已过期，需要重新获取',
  network: '⚠ 暂时连不上华山服务器',
  server: '⚠ 华山服务器暂时异常',
};
export function gateHTML(reason, manualOnly = false) {
  const manual = `<div class="manual-login">
      <div class="manual-title"><span>手动输入登录 Token</span></div>
      <div class="manual-row">
        <input id="manual-token" type="password" autocomplete="off" spellcheck="false" placeholder="粘贴完整 Token" onkeydown="if(event.key==='Enter')useManualToken(this.nextElementSibling)">
        <button onclick="useManualToken(this)">验证并登录</button>
      </div>
    <div id="manual-status" class="manual-status">Token 等同登录凭证，请只粘贴可信的人发给你的 Token。本工具不会保存你输入的 Token。</div>
    </div>`;
  if (manualOnly) {
    return `<h2>华山论剑 · 数据查询</h2>
      <div class="warn">⚠ 请手动输入登录 Token</div>
      <p class="gate-lead">macOS 版不读取微信本地数据。请从已登录 Windows 版首页的“使用说明”中复制有效 Token，再粘贴到下方。</p>
      ${manual}
      <div class="gate-sub">Token 约 1 天有效，过期后需要重新获取 · <a onclick="showAbout()">使用说明</a></div>`;
  }
  const warn = GATE_WARN[reason] || '⚠ 还没检测到你的登录令牌';
  return `<h2>华山论剑 · 数据查询</h2>
    <div class="warn">${warn}</div>
    <p class="gate-lead">本工具会使用电脑版微信的登录状态进行查询。请按以下步骤登录：</p>
    <ol>
      <li>在电脑上打开 <b>电脑版微信</b>。</li>
      <li>进入自己的 <b>「华山战力页」</b> 并登录一次（令牌约 1 天有效）。</li>
      <li>登录后<b>关掉 / 退出这个战力页</b>。</li>
      <li>回到本工具，点下面的按钮重新检测。</li>
    </ol>
    <button class="gate-btn" onclick="retryToken(this)">我已登录，重新检测</button>
    ${manual}
    <div class="gate-sub">自动检测仍失败？请确认微信是<b>电脑版</b>且已在其中登录过战力页 · <a onclick="showAbout()">使用说明</a></div>`;
}
export function showGate() {
  const g = $("#gate"); if (g) { g.innerHTML = gateHTML(sessionReason(), manualTokenOnly()); g.hidden = false; }
  const a = $("#app"); if (a) a.hidden = true;
}
export function enterApp() {
  const g = $("#gate"); if (g) g.hidden = true;
  const a = $("#app"); if (a) a.hidden = false;
  const home = $("#home"); if (home) home.hidden = false;
  const personal = $("#personal-page"); if (personal) personal.hidden = true;
  const events = $("#events-page"); if (events) events.hidden = true;
  const tools = $("#tools-page"); if (tools) tools.hidden = true;
  checkToken();
}

export async function useManualToken(btn) {
  const input = $("#manual-token"), status = $("#manual-status");
  const raw = input ? input.value.trim() : '';
  if (!raw) { if (status) { status.textContent = '请先粘贴完整 Token。'; status.className = 'manual-status error'; } return; }
  const old = btn.textContent; btn.disabled = true; btn.textContent = '验证中…';
  if (status) { status.textContent = '正在验证 Token…'; status.className = 'manual-status'; }
  try {
    await setManualToken(raw);
    if (input) input.value = '';
    if (tokenValid()) { enterApp(); return; }
    throw new Error('Token 暂时无法使用，请重新获取后再试');
  } catch (e) {
    if (e && e.name === 'LocalServerError') return;
    if (status) { status.textContent = (e && e.message) || 'Token 验证失败，请重试'; status.className = 'manual-status error'; }
  } finally {
    btn.disabled = false; btn.textContent = old;
  }
}
// 引导页“重新检测”：强制重扫令牌；成功进应用，失败按精确原因弹窗。
const RETRY_POPUP = {
  no_token: ['没找到登录令牌',
    `<ul><li>请确认用的是 <b>电脑版微信</b> 且当前<b>已登录</b>。</li>
      <li>在微信里打开自己的 <b>「华山战力页」</b> 登录，然后<b>关掉该页</b>。</li></ul>
     <p>完成后，再点一次「我已登录，重新检测」。</p>`],
  expired: ['登录令牌已过期',
    `<ul><li>找到了登录信息，但已<b>过期</b>（令牌约 1 天有效）。</li>
      <li>回 <b>微信</b> 重新打开一次 <b>「华山战力页」</b> 登录。</li>
      <li>登录后先<b>关掉 / 退出该战力页</b>，再回到本工具。</li></ul>
     <p>做完以上再点一次「我已登录，重新检测」。</p>`],
  network: ['连不上服务器',
    `<ul><li>当前<b>无法连接</b>华山服务器。</li>
      <li>请检查网络（断网 / 代理 / 防火墙）后再重试。</li></ul>`],
  server: ['华山服务器暂时异常',
    `<ul><li>华山服务器当前可能繁忙或正在维护。</li>
      <li>这不是你的问题，<b>稍后再试</b>即可；令牌无需重新获取。</li></ul>`],
};
export async function retryToken(btn) {
  const old = btn.textContent; btn.disabled = true; btn.textContent = '检测中…';
  let ok;
  try {
    ok = await refreshSession(true);
  } catch (e) {
    if (e && e.name === 'LocalServerError') return;
    throw e;
  }
  if (ok && tokenValid()) { enterApp(); return; }
  btn.disabled = false; btn.textContent = old;
  const [title, body] = RETRY_POPUP[sessionReason()] || RETRY_POPUP.no_token;
  popup(title, body);
}

// —— 通用弹窗（错误/提示统一走它，不再用控制台/内联横幅）——
export function popup(title, html) {
  const el = $("#pop"); if (!el) return;
  el.style.display = 'flex';
  el.innerHTML = `<div class="ov-card about-card"><div class="ov-head"><b>${esc(title)}</b><span class="ov-close" onclick="closePop()">关闭</span></div><div class="about-body">${html}</div></div>`;
}
export function closePop() { const el = $("#pop"); if (el) { el.style.display = 'none'; el.innerHTML = ''; } }
