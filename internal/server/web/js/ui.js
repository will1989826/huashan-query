// 视图与状态层：搜索、详情、逐场、单局。Go(player 层) 负责“大量计算”（聚合/候选/按作用域筛选），
// 本层做“轻活”：取模型、加中文标签与格式化、逐场表的快捷筛选/排序/分页、单局排版。
// 作用域(赛区/赛季/门派)变化才请求后端；表内 gf/排序/翻页只在本地重渲染，不发请求（Go 已把作用域数据一次给足）。
import { esc, roleColor, roleWeight, campColor, seatSkills, seatMarks, skillText, skillLabel, seatRef, roleEmoji, isWolf, WOLFSIDE, resolveZone, isGoodCamp, fmt, zoneName, honorZoneName, uniq, causeText, voteHitClass } from './format.js';
import { searchPlayers, detail, game as fetchGame, refreshSession, checkToken, tokenValid, sessionReason, testMode } from './api.js';

const $ = s => document.querySelector(s);
const PAGE = 20;      // 逐场战绩每次显示行数
let V = null;         // 当前选手状态（作用域 + 表内交互态 + 最近模型 model）
let viewSeq = 0;
const viewSession = Math.random().toString(36).slice(2);

export function __setV(v) { V = v; }
export function __getV() { return V; }

function newState(id) {
  return {
    id, zone: 'ALL', season: '', sect: '',
    gf: { result: '', camp: '', role: '', sect: '', mark: '' },
    sort: { key: 'play_date', dir: -1 }, roleSort: { key: 'n', dir: -1 },
    limit: PAGE, gen: 0, abort: null, model: null, gameCache: {}, gamesLoading: false, testMode: testMode(), view: `${viewSession}-${++viewSeq}`,
  };
}

// —— 选手名搜索 ——
const itemHTML = p => `<div class="item" onclick="openPlayer(${p.player_id})">
  <img src="${esc(p.player_avatar || '')}" onerror="this.style.visibility='hidden'">
  <div><div class="nm">${esc(p.player_name)}</div><div class="sect">${esc((p.sects || []).map(s => s.name).join(' · ') || '—')}</div></div>
  <div class="rt">${p.total_point != null ? ('总分 ' + p.total_point) : ''}<div class="id">#${p.player_id}</div></div></div>`;

export async function searchName() {
  const q = $("#q").value.trim(), box = $("#results"); $("#detail").innerHTML = ""; V = null;
  if (!q) { box.innerHTML = '<div class="muted">输入选手名后搜索</div>'; return }
  box.innerHTML = '<div class="spin">搜索中…</div>';
  try {
    const list = await searchPlayers(q);
    const arr = Array.isArray(list) ? list : (list.items || []);
    box.innerHTML = arr.length ? arr.map(itemHTML).join("") : '<div class="muted">没找到「' + esc(q) + '」</div>';
  } catch (e) {
    if (e && (e.name === 'LocalServerError' || e.name === 'TestVersionExpiredError')) return;
    box.innerHTML = '<div class="err">搜索失败：' + esc(e.message) + '</div>';
  }
}

// —— 选手详情：作用域请求后端 ——
export async function openPlayer(id) {
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
  if (st.view) p.set('view', st.view);
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
    if (V === st && st.gen === gen && (!initial || !st.model)) $("#detail").innerHTML = detailLoadingHTML(stage, initial);
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
  const ignorable = e => e && (e.name === 'AbortError' || e.name === 'LocalServerError' || e.name === 'TestVersionExpiredError');
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
    if (e.status === 401) { if (!st.model) $("#detail").innerHTML = '<div class="err">令牌已过期，请按上方提示刷新。</div>'; else renderDetail(); return; }
    // 已有头部（全量阶段失败）：保留头部，仅逐场区报错；否则整块报错。
    if (st.model) { st.model = { ...st.model, games_error: st.model.games_error || e.message }; renderDetail(); }
    else $("#detail").innerHTML = '<div class="err">获取失败：' + esc(e.message) + '</div>';
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
export function setGF(kind, val) { V.gf[kind] = val; V.limit = PAGE; renderDetail(); }

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
  const kvMap = arr => Object.fromEntries((arr || []).map(t => [t.key, t.val]));
  const comp = kvMap(m.comprehensive), good = kvMap(m.good);
  const metric = (v, pct) => (v == null || v === '') ? '—' : (pct ? v + '%' : v);
  const mRounds = metric(comp.round_total, false), mAvg = metric(comp.round_point_avg, false), mWin = metric(comp.win_pct, true);
  const mToulang = metric(good.toulang_pct, true), mZhanbian = metric(good.zhanbian_pct, true);   // 门派维度这些键不存在 → —

  const honorsInline = (m.honors || []).map(h => `<span class="badge">${esc(honorZoneName(h.zone_id, m.joined))} S${h.season_id} ${String(h.code) === '1' ? '冠军' : '第' + h.code + '名'}</span>`).join("");
  // gamesLoading：两阶段第一步已出头部、逐场仍在后台加载。逐场/角色/队伍区显示“加载中”而非“无数据”。
  const gamesLoading = !!st.gamesLoading && !m.games_error;
  const teamsHtml = m.games_error ? '<span class="none">—</span>' : (gamesLoading ? '<span class="none">加载中…</span>' : ((m.teams && m.teams.length) ? m.teams.map(c => `<span class="tm">${esc(c)}</span>`).join('') : '<span class="none">—</span>'));
  const testWatermark = st.testMode ? '<span class="test-watermark" aria-label="测试版本">测试版本</span>' : '';

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
    const rrows = m.roles.slice().sort((a, b) => rs.dir * ((+a[rs.key] || 0) - (+b[rs.key] || 0)));
    const rarrow = k => rs.key === k ? (rs.dir < 0 ? ' ▾' : ' ▴') : '';
    const rth = (k, l) => `<th class="sortable" onclick="setRoleSort('${k}')">${l}${rarrow(k)}</th>`;
    roleHtml = `<div class="sec"><h3>🎭 角色表现 ${sc}</h3></div>
      <div class="tbl-wrap" style="padding:0 16px 6px"><table><thead><tr><th>身份</th>${rth('n', '场次')}${rth('avg', '场均分')}${rth('win', '胜率')}${rth('mvp', 'MVP')}${rth('svp', '尽力')}${rth('bgx', '背锅')}</tr></thead><tbody>${rrows.map(r => `<tr><td style="color:${roleColor(r.role)}${roleWeight(r.role)}">${esc(r.role)}</td><td>${r.n}</td><td>${r.avg}</td><td>${r.win}%</td><td>${r.mvp || ''}</td><td>${r.svp || ''}</td><td>${r.bgx || ''}</td></tr>`).join("")
      }</tbody></table></div>`;
  } else if (gamesLoading) {
    roleHtml = `<div class="sec"><h3>🎭 角色表现 ${sc}</h3><div class="muted" style="padding:2px 16px 8px">加载中…</div></div>`;
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
  const arrow = k => sort.key === k ? (sort.dir < 0 ? ' ▾' : ' ▴') : '';
  const th = (k, l) => `<th class="sortable" onclick="sortGames('${k}')">${l}${arrow(k)}</th>`;
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
      ? `<div class="muted" style="padding:0 0 6px">共 ${total} 场 · 逐场加载中…（已显示前 ${games.length} 场，筛选 / 排序稍后可用）</div>`
      : `<div class="muted" style="padding:0 0 6px">已显示前 ${games.length} 场 · 完整数量加载中…（筛选 / 排序稍后可用）</div>`;
    const head = `<tr><th>日期</th><th>赛季</th><th>轮</th><th>座</th><th>门派</th><th>身份</th><th>分</th><th>结果</th><th>标识</th></tr>`;
    gamesBody = note + `<div class="tbl-wrap"><table><thead>${head}</thead><tbody>${pr}</tbody></table></div>`;
  }
  else if (gamesLoading) {
    // 首页行尚未到（或首页失败前）：占位。
    gamesBody = `<div class="loading-card" role="status" aria-live="polite"><span class="loading-pulse" aria-hidden="true"></span><div><b>正在加载逐场战绩</b><span>该选手对局较多时需要一点时间，加载完成后自动显示。</span></div></div>`;
  }
  else if (!games.length) { gamesBody = '<div class="muted">无战绩</div>'; }
  else {
    const truncNote = m.games_trunc ? '<div class="err" style="padding:0 0 6px">⚠ 战绩过多，已达安全上限，仅展示部分（可能不完整）。</div>' : '';
    const tbl = tg.length
      ? `<div class="tbl-wrap"><table><thead><tr>${th('play_date', '日期')}<th>赛季</th><th>轮</th><th>座</th><th>门派</th><th>身份</th>${th('total_point', '分')}<th>结果</th><th>标识</th></tr></thead><tbody>${rows}</tbody></table></div>`
      + (tg.length > limit ? `<button class="morebtn" onclick="showMore()">加载更多（还有 ${tg.length - limit} 场）</button>` : '')
      : '<div class="muted">当前筛选无匹配</div>';
    gamesBody = qfbar + truncNote + `<div class="muted" style="padding:0 0 6px">共 ${tg.length} 场 · 点击某场查看牌型 / 投票 / 刀验</div>` + tbl;
  }
  const gamesHtml = `<div class="sec"><h3>🗒️ 逐场战绩 ${sc}</h3></div><div style="padding:0 16px 16px">${gamesBody}</div>`;

  // —— 筛选器候选 datalist ——
  const opt = arr => (arr || []).map(t => `<option value="${esc(t)}">`).join("");
  const zoneLabel = zone === 'ALL' ? '' : zName;
  const zoneOpts = opt(['全部赛区', ...((m.joined || []).map(j => j.text))]);
  const seasonOpts = opt(['全部赛季', ...((m.season_cands || []).map(n => 'S' + n))]);
  const sectOpts = opt(['全部门派', ...(m.sect_cands || [])]);

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
        ${testWatermark}
        <img class="pphoto" src="${esc(p.avatar || '')}" onerror="this.style.visibility='hidden'">
        <div class="pinfo">
          <div class="prow"><span class="name">${esc(p.name || ('#' + pid))}</span><span class="id">#${esc(pid)}</span>${honorsInline}<span class="infohint" onclick="this.classList.toggle('open')" title="数据说明">ⓘ<span class="infobubble">数据为打开程序时抓取的快照，不会自动更新。若怀疑已过期，关闭本程序再重新打开即可获取最新数据。</span></span></div>
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
      ${statsHtml}
      ${roleHtml}
      ${gamesHtml}
    </div>`;
}
function renderDetail() { $("#detail").innerHTML = renderDetailHTML(V); }

// —— 单场牌局详情弹层（纯展示，前端排版）——
function getGame(gid) {
  if (!V.gameCache[gid]) V.gameCache[gid] = fetchGame(gid).catch(e => { delete V.gameCache[gid]; throw e });
  return V.gameCache[gid];
}
// 悬停预取：鼠标移到某场行上就先拉+分析该局（服务端按 gid 缓存），点开时通常已就绪、秒开。
// 每局至多触发一次（gameCache 记忆化）；预取失败静默，点击时会照常重取。/api/games 不计测试版查询额度。
export function prefetchGame(gid) {
  if (!V || gid == null) return;
  try { getGame(gid).catch(() => {}); } catch (e) { /* V 无或已切换：忽略 */ }
}
export async function openGame(gid) {
  const ov = $("#ov"); ov.style.display = 'flex';
  ov.innerHTML = '<div class="ov-card"><div class="ov-head"><b>牌局 #' + gid + '</b><span class="ov-close" onclick="closeGame()">关闭</span></div><div class="spin">加载牌局…</div></div>';
  // 当前选手在该局的逐场行（含 bgx——form2 里没有 per-seat 背锅，只有此处有当前选手的背锅标识）
  curMeRow = ((V.model && V.model.games) || []).find(r => String(r && r.game_id) === String(gid)) || null;
  try { renderGame(await getGame(gid)); }
  catch (e) {
    if (e && (e.name === 'LocalServerError' || e.name === 'TestVersionExpiredError')) return;
    ov.innerHTML = '<div class="ov-card"><div class="ov-head"><b>牌局 #' + gid + '</b><span class="ov-close" onclick="closeGame()">关闭</span></div><div class="err">获取失败：' + esc(e.message) + '</div></div>';
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
// gateHTML 是纯函数（便于单测）：按精确原因给出提示 + 获取步骤 + “重新检测”按钮。
const GATE_WARN = {
  expired: '⚠ 登录令牌已过期，需要重新获取',
  network: '⚠ 暂时连不上华山服务器',
  server: '⚠ 华山服务器暂时异常',
};
export function gateHTML(reason) {
  const warn = GATE_WARN[reason] || '⚠ 还没检测到你的登录令牌';
  return `<h2>华山论剑 · 选手查询</h2>
    <div class="warn">${warn}</div>
    <p class="gate-lead">本工具只在你自己的电脑上读取微信里的登录令牌用于查询，不会上传。按下面步骤获取：</p>
    <ol>
      <li>在电脑上打开 <b>电脑版微信</b>。</li>
      <li>进入自己的 <b>「华山战力页」</b> 并登录一次（令牌约 1 天有效）。</li>
      <li>回到本页面，点下面的按钮重新检测。</li>
    </ol>
    <button class="gate-btn" onclick="retryToken(this)">我已登录，重新检测</button>
    <div class="gate-sub">仍检测不到？请确认微信是<b>电脑版</b>且已在其中登录过战力页，然后重试 · <a onclick="showAbout()">使用说明</a></div>`;
}
export function showGate() {
  const g = $("#gate"); if (g) { g.innerHTML = gateHTML(sessionReason()); g.hidden = false; }
  const a = $("#app"); if (a) a.hidden = true;
}
export function enterApp() {
  const g = $("#gate"); if (g) g.hidden = true;
  const a = $("#app"); if (a) a.hidden = false;
  checkToken();
}
// 引导页“重新检测”：强制重扫令牌；成功进应用，失败按精确原因弹窗。
const RETRY_POPUP = {
  no_token: ['没找到登录令牌',
    `<ul><li>请确认用的是 <b>电脑版微信</b> 且当前<b>已登录</b>。</li>
      <li>并且在微信里打开过自己的 <b>「华山战力页」</b>（哪怕只打开一次）。</li></ul>
     <p>完成后，再点一次「我已登录，重新检测」。</p>`],
  expired: ['登录令牌已过期',
    `<ul><li>找到了登录信息，但已<b>过期</b>（令牌约 1 天有效）。</li>
      <li>回 <b>微信</b> 重新打开一次 <b>「华山战力页」</b> 即可刷新。</li></ul>
     <p>刷新后，再点一次「我已登录，重新检测」。</p>`],
  network: ['连不上服务器',
    `<ul><li>本机<b>无法访问</b>华山官方服务器。</li>
      <li>请检查网络（断网 / 代理 / 防火墙）后再重试。</li></ul>`],
  server: ['华山服务器暂时异常',
    `<ul><li>官方服务器返回了错误（繁忙 / 维护 / 5xx）。</li>
      <li>这不是你的问题，<b>稍后再试</b>即可；令牌无需重新获取。</li></ul>`],
};
export async function retryToken(btn) {
  const old = btn.textContent; btn.disabled = true; btn.textContent = '检测中…';
  let ok;
  try {
    ok = await refreshSession(true);
  } catch (e) {
    if (e && (e.name === 'LocalServerError' || e.name === 'TestVersionExpiredError')) return;
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
