// 多人对比：对比篮（最多 12 人）+ 对比表。数据全部复用现有 /api/players/detail：
//   - 浅层（综合/好人/狼人）：每人 ?only=head（只打 stats，秒出汇总指标），页面侧扇出拼矩阵；
//   - 深层（按身份）：浅层出来后在后台低调预热每人全量 detail（角色维度 roles[] 由 Go 算好）灌进按人 LRU 缓存，
//     用户切到“深层对比”即命中缓存、从本地秒读。深层两种排法：人×身份矩阵 / 选身份多指标，用户自选。
// 计算不在这里做：页面只格式化 + 排序 + 筛选（与 ui.js 一致的边界）。排序/键值原语复用 format.js。
import { esc, fmt, kvMap, sortRows, roleColor, roleWeight, arrowFor } from './format.js';
import { resolveZone, zoneName, honorZoneName } from './zone.js';
import { detail } from './api.js';
import { currentView, setView } from './view.js';

const $ = s => document.querySelector(s);
export const MAX = 12;

// —— 对比篮（跨搜索/对比持续存在的模块级状态）——
let basket = [];   // [{id, name, avatar, sect}]
export const inBasket = id => basket.some(b => String(b.id) === String(id));
export const basketCount = () => basket.length;
export function __resetBasket() { basket = []; C = null; }   // 测试用

// —— 对比视图状态（进入对比才建；null=未在对比）——
let C = null;
function newCompare() {
  return {
    scope: { zone: 'ALL', season: '' },
    layer: 'shallow',              // shallow（浅层，stats 汇总）| deep（深层，逐场按身份）
    group: 'comprehensive',        // 浅层子组：comprehensive | good | wolf | custom（跨组自选指标）
    custom: DEFAULT_CUSTOM.map(p => p.slice()),   // 自定义组选中的指标 [[group, key], ...]（仅浅层跨组）
    deepMode: 'matrix',            // 深层排法：matrix（人×身份）| byrole（选身份多指标）
    metric: 'avg',                 // matrix 展示的身份指标
    role: '',                      // byrole 选中的身份
    sort: { key: '', dir: -1 },    // key=''：保持篮内顺序
    hidden: new Set(),             // 聚焦子集：被隐藏的选手 id
    rows: {},                      // id → {head, full, loadingHead, loadingFull, headErr, fullErr}
    gen: 0, abort: null,
  };
}

// 深层身份指标（能从逐场自算的：场次/场均分/胜率/MVP/尽力/背锅；比率类官方口径逐场算不出，故不列）。
const ROLE_METRICS = [
  { key: 'n', label: '场次', pct: false },
  { key: 'avg', label: '场均分', pct: false },
  { key: 'win', label: '胜率', pct: true },
  { key: 'mvp', label: 'MVP', pct: false },
  { key: 'svp', label: '尽力', pct: false },
  { key: 'bgx', label: '背锅', pct: false },
];
// 浅层各组 page-side 隐藏（与单人详情一致）：好人局藏 htsp_num、狼人局藏 bgx_num。
const SHALLOW_HIDE = { good: ['htsp_num'], wolf: ['bgx_num'], comprehensive: [] };

// —— 自定义（跨组自选）——仅浅层：同一 key 在 综合/好人/狼人 里含义不同，故用 (group,key) 唯一标识，行标签带组前缀。
const GROUP_PREFIX = { comprehensive: '综合', good: '好人', wolf: '狼人' };
// 起手集：对齐单人卡头指标，保证「自定义」组默认非空。
const DEFAULT_CUSTOM = [
  ['comprehensive', 'round_total'], ['comprehensive', 'round_point_avg'], ['comprehensive', 'win_pct'],
  ['good', 'toulang_pct'], ['good', 'zhanbian_pct'],
];

// —— 最优值高亮：只高亮“可比较的归一化指标”——比率(各 _pct)与均值(场均分、深层 avg/胜率 win)。
// 原始次数(场次/MVP/尽力/背锅/人命值等)受总场次影响，绝对值高低不代表表现优劣，一律不参与高亮，避免误导。
// 归一化指标均为越高越好（投狼率/站对边率/胜率… 无“越低越好”者），故方向恒 +1；不可比指标返回 0（不高亮）。
const HL_AVG = new Set(['round_point_avg', 'avg', 'win']);   // 场均分 / 深层场均分 / 深层胜率
function dirOfKey(k) { return (k.endsWith('_pct') || HL_AVG.has(k)) ? 1 : 0; }

// 某浅层组实际返回的字段（官方首见顺序、去 page-side 隐藏；不猜键名、不漏字段）。colsFor 与自定义 picker 共用。
function shallowKeys(state, group) {
  const hide = SHALLOW_HIDE[group] || [];
  const seen = new Set(), keys = [];
  (state.basket || []).forEach(b => {
    (((((state.rows || {})[b.id] || {}).head || {})[group]) || []).forEach(t => {
      if (t && t.key && !seen.has(t.key) && !hide.includes(t.key)) { seen.add(t.key); keys.push(t.key); }
    });
  });
  return keys;
}

// 当前视图的列描述 [{key,label,render,srcKey?,srcGroup?,dir,color?,weight?}]（纯函数，输入 state）
function colsFor(state) {
  if (state.layer === 'shallow') {
    if (state.group === 'custom') {   // 跨组自选：列 = 用户勾选的 (group,key)；标签带组前缀
      return (state.custom || []).map(([g, k]) => ({
        key: g + ':' + k, srcGroup: g, srcKey: k, dir: dirOfKey(k),
        label: (GROUP_PREFIX[g] || g) + '·' + fmt(k, 0).name, render: v => fmt(k, v).val,
      }));
    }
    return shallowKeys(state, state.group).map(k => ({ key: k, srcKey: k, dir: dirOfKey(k), label: fmt(k, 0).name, render: v => fmt(k, v).val }));
  }
  if (state.deepMode === 'matrix') {   // 列 = 各人打过的身份并集；单元格=该身份的选中指标（方向由选中指标决定）
    const m = ROLE_METRICS.find(x => x.key === state.metric) || ROLE_METRICS[1];
    const dir = dirOfKey(state.metric);
    return unionRoles(state).map(role => ({
      key: role, label: role, color: roleColor(role), weight: roleWeight(role), dir,
      render: v => v == null ? '—' : (m.pct ? v + '%' : v),
    }));
  }
  return ROLE_METRICS.map(m => ({ key: m.key, srcKey: m.key, dir: dirOfKey(m.key), label: m.label, render: v => v == null ? '—' : (m.pct ? v + '%' : v) }));
}

// 把每人摊平成一行：把当前视图各列的值提到顶层（供 sortRows 直接按列排序），meta 用不冲突的键名。
function buildDrows(state) {
  const cols = colsFor(state);
  return (state.basket || []).map(b => {
    const row = (state.rows || {})[b.id] || {};
    const out = { id: b.id, name: b.name, avatar: b.avatar };
    if (state.layer === 'shallow') {
      if (state.group === 'custom') {   // 每列各取所属组的 head KV
        cols.forEach(c => { const m = kvMap((row.head || {})[c.srcGroup]); out[c.key] = m[c.srcKey]; });
      } else {
        const m = kvMap((row.head || {})[state.group]);
        cols.forEach(c => { out[c.key] = m[c.key]; });
      }
      out.loading = !row.head && !!row.loadingHead; out.err = row.headErr;
    } else if (state.deepMode === 'matrix') {
      const roles = (row.full || {}).roles || [];
      cols.forEach(c => { const ro = roles.find(r => r.role === c.key); out[c.key] = ro ? ro[state.metric] : undefined; });
      out.loading = !row.full && !!row.loadingFull; out.err = row.fullErr || (row.full && row.full.games_error);
    } else {
      const ro = ((row.full || {}).roles || []).find(r => r.role === state.role);
      cols.forEach(c => { out[c.key] = ro ? ro[c.key] : undefined; });
      out.loading = !row.full && !!row.loadingFull; out.err = row.fullErr || (row.full && row.full.games_error);
    }
    return out;
  });
}

// —— 统一中间表示（IR）：把 colsFor（列）与 buildDrows（每人）转成 {people, rows}——
// 表格与卡片列共用同一 rows 与同一高亮计算，只是行/列互为转置。rawFor 按 id 取该指标原值。
function buildIR(state) {
  const cols = colsFor(state);
  const people = buildDrows(state);
  const byId = Object.fromEntries(people.map(r => [r.id, r]));
  const rows = cols.map(c => ({
    key: c.key, label: c.label, color: c.color, weight: c.weight, dir: c.dir == null ? 1 : c.dir, render: c.render,
    rawFor: id => { const r = byId[id]; return r ? r[c.key] : undefined; },
  }));
  return { people, rows };
}

// 一行（指标）在可见诸人中的最优者 id 集合：dir=0 不高亮；有效值 <2 不高亮；并列全高亮；缺失/非数值跳过。
function winnersFor(row, people) {
  if (!row.dir) return new Set();
  const vals = people.map(p => { const v = row.rawFor(p.id); const n = +v; return (v == null || v === '' || isNaN(n)) ? null : n; });
  const valid = vals.filter(v => v != null);
  if (valid.length < 2) return new Set();
  const best = row.dir > 0 ? Math.max(...valid) : Math.min(...valid);
  const w = new Set();
  people.forEach((p, i) => { if (vals[i] === best) w.add(p.id); });
  return w;
}

function unionJoined(state) {
  const seen = new Set(), out = [];
  (state.basket || []).forEach(b => {
    (((state.rows || {})[b.id] || {}).head || {}).joined?.forEach(j => {
      if (j && j.ordering && !seen.has(j.ordering)) { seen.add(j.ordering); out.push(j); }
    });
  });
  return out;
}
function unionSeasons(state) {
  const seen = new Set();
  (state.basket || []).forEach(b => (((state.rows || {})[b.id] || {}).full || {}).season_cands?.forEach(n => seen.add(n)));
  return [...seen].sort((a, b) => b - a);
}
function unionRoles(state) {
  const seen = new Set(), out = [];
  (state.basket || []).forEach(b => (((state.rows || {})[b.id] || {}).full || {}).roles?.forEach(r => {
    if (r && r.role && !seen.has(r.role)) { seen.add(r.role); out.push(r.role); }
  }));
  return out;
}

// —— 纯渲染：输入快照 state，输出对比表 HTML（无 DOM 副作用，便于单测）——
export function renderCompareHTML(state) {
  const { basket: bk = [], scope = { zone: 'ALL', season: '' }, layer = 'shallow', sort = { key: '', dir: -1 } } = state;
  const hidden = state.hidden || [];
  if (!bk.length) return '<div class="muted" style="padding:16px">对比篮是空的，先搜索选手并点“＋”加入。</div>';

  // 顶层：按阵营（综合/好人/狼人，stats 秒出）/ 按身份（逐场按身份细分，后台预热）
  const layerTabs = [['shallow', '按阵营'], ['deep', '按身份']]
    .map(([k, l]) => `<span class="qf${layer === k ? ' on' : ''}" onclick="setCompareLayer('${k}')">${l}</span>`).join('');

  // 范围（zone 候选=各人 joined 并集；season 候选=各人 season_cands 并集，可手动输）
  const joined = unionJoined(state);
  const zName = scope.zone === 'ALL' ? '' : zoneName(scope.zone, joined);
  const zoneOpts = ['全部赛区', ...joined.map(j => j.text)].map(t => `<option value="${esc(t)}">`).join('');
  const seasonOpts = ['全部赛季', ...unionSeasons(state).map(n => 'S' + n)].map(t => `<option value="${esc(t)}">`).join('');
  const scopeBar = `<div class="cmp-scope">
    <div class="f"><label>赛区</label><input id="cmpzone" list="dlcmpzone" placeholder="全部赛区" value="${esc(zName)}" autocomplete="off" onfocus="this.dataset.prev=this.value;this.value=''" onblur="if(!this.value)this.value=this.dataset.prev||''" onchange="setCompareScope('zone',this.value)"><datalist id="dlcmpzone">${zoneOpts}</datalist></div>
    <div class="f"><label>赛季</label><input id="cmpseason" list="dlcmpseason" placeholder="全部赛季" value="${scope.season ? 'S' + esc(scope.season) : ''}" autocomplete="off" onfocus="this.dataset.prev=this.value;this.value=''" onblur="if(!this.value)this.value=this.dataset.prev||''" onchange="setCompareScope('season',this.value)"><datalist id="dlcmpseason">${seasonOpts}</datalist></div>
  </div>`;

  // 子选择区：浅层=综合/好人/狼人/自定义；深层=排法切换 + 指标/身份选择器
  let subBar;
  if (layer === 'shallow') {
    const tabsRow = `<div class="qfbar cmp-tabs">${[['comprehensive', '综合'], ['good', '好人'], ['wolf', '狼人'], ['custom', '自定义']]
      .map(([g, l]) => `<span class="qf${state.group === g ? ' on' : ''}" onclick="setCompareGroup('${g}')">${l}</span>`).join('')}</div>`;
    if (state.group === 'custom') {   // 跨组自选：三组各列可开关 chip；勾选项即成对比行
      const sel = new Set((state.custom || []).map(([g, k]) => g + ':' + k));
      const grps = [['comprehensive', '综合'], ['good', '好人'], ['wolf', '狼人']].map(([g, gl]) => {
        // 候选 = 当前作用域实际返回的字段 ∪ 已勾选字段（后者保证：换作用域后已选项即便当前无人拥有，仍能取消勾选）
        const found = shallowKeys(state, g);
        const selKeys = (state.custom || []).filter(([cg]) => cg === g).map(([, k]) => k);
        const keys = [...found, ...selKeys.filter(k => !found.includes(k))];
        if (!keys.length) return '';
        const chips = keys.map(k => `<span class="qf${sel.has(g + ':' + k) ? ' on' : ''}" onclick="toggleCompareCustom('${g}','${esc(k)}')">${esc(fmt(k, 0).name)}</span>`).join('');
        return `<div class="cmp-pickgrp"><span class="cmp-pickgl">${gl}</span><div class="cmp-pickchips">${chips}</div></div>`;
      }).join('');
      subBar = tabsRow + `<div class="cmp-picker">${grps || '<span class="muted">指标加载中，稍候可选。</span>'}</div>`;
    } else {
      subBar = tabsRow;
    }
  } else {
    const modeTabs = [['matrix', '人 × 身份'], ['byrole', '单个身份']]
      .map(([k, l]) => `<span class="qf${state.deepMode === k ? ' on' : ''}" onclick="setCompareDeepMode('${k}')">${l}</span>`).join('');
    let picker;
    if (state.deepMode === 'matrix') {
      const opts = ROLE_METRICS.map(m => `<option value="${m.key}"${m.key === state.metric ? ' selected' : ''}>${m.label}</option>`).join('');
      picker = `<span class="cmp-pick"><label>指标</label><select class="qsel" onchange="setCompareMetric(this.value)">${opts}</select></span>`;
    } else {
      const roles = unionRoles(state);
      const opts = roles.map(r => `<option value="${esc(r)}"${r === state.role ? ' selected' : ''}>${esc(r)}</option>`).join('');
      picker = `<span class="cmp-pick"><label>身份</label><select class="qsel" onchange="setCompareRole(this.value)"><option value="">选择身份…</option>${opts}</select></span>`;
    }
    subBar = `<div class="qfbar cmp-tabs">${modeTabs}${picker}</div>`;
  }

  const shell = body => `<div class="cmp">
    <div class="cmp-head"><h3>选手对比 <small>· ${bk.length}/${MAX} 人</small></h3>${scopeBar}</div>
    <div class="qfbar cmp-layers">${layerTabs}</div>
    ${subBar}
    ${body}
  </div>`;

  // 深层：先按 full 数据整体状态（拉取中 / 全失败 / 确实为空）出占位，再处理 byrole 是否已选身份——
  // 顺序不能反，否则 byrole 未选身份时会永远停在“选择一个身份”，看不到失败/空状态。
  if (layer === 'deep') {
    const roles = unionRoles(state);
    if (!roles.length) {   // 还没有任何身份数据可用（matrix 无列、byrole 无可选身份）
      const rs = bk.map(b => (state.rows || {})[b.id] || {});
      // 失败含两种：请求抛错(fullErr) 与 HTTP 200 部分降级(full.games_error，roles 可能为空但其实是拉取失败)。
      const failed = r => !!(r.fullErr || (r.full && r.full.games_error));
      if (rs.some(r => !r.full && !r.fullErr)) {   // 仍有人在拉（含预热尚未发起）
        return shell('<div class="loading-card" role="status" aria-live="polite"><span class="loading-pulse" aria-hidden="true"></span><div><b>正在加载身份数据</b><span>身份数据较多，请稍候。</span></div></div>');
      }
      if (rs.length && rs.every(failed)) {
        return shell('<div class="err" style="padding:8px 0">身份数据获取失败，可切回“按阵营”或换个作用域重试。</div>');
      }
      if (rs.some(failed)) {   // 一部分失败、其余无数据：别把失败伪装成“空”
        return shell('<div class="err" style="padding:8px 0">部分选手的身份数据获取失败，其余暂无数据；可切回“按阵营”或重试。</div>');
      }
      return shell('<div class="muted" style="padding:8px 0">该赛区 / 赛季内暂无可用的身份数据。</div>');
    }
    if (state.deepMode === 'byrole' && !state.role) {   // 已有身份可选，但用户还没选
      return shell('<div class="muted" style="padding:8px 0">选择一个身份后查看对比。</div>');
    }
  }

  const ir = buildIR(state);
  let people = ir.people.filter(r => !hidden.includes(r.id));
  if (sort.key) people = sortRows(people, sort.key, sort.dir);
  const rows = ir.rows;

  const hiddenNote = hidden.length ? `<div class="muted" style="padding:0 0 6px">已隐藏 ${hidden.length} 人 · <a onclick="showAllCompare()">显示全部</a></div>` : '';
  let body;
  if (!people.length) body = '<div class="muted" style="padding:8px 0">当前无可显示的选手（都被隐藏了）。</div>';
  else if (!rows.length) body = '<div class="muted" style="padding:8px 0">请选择要对比的指标。</div>';
  else body = people.length <= 4 ? renderCardColumns(people, rows, state, sort) : renderCompareTable(people, rows, sort);

  const foot = rows.length && people.length
    ? '<div class="muted" style="padding:6px 0 0">点指标排序 · 点名字看单人详情 · 取消勾选可隐藏 · 可比较指标高亮最优值</div>' : '';
  return shell(`${hiddenNote}${body}${foot}`);
}

// —— 表格布局（可见 ≥5 人）：人=行、指标=列。命中最优值的格加 cmp-best。——
function renderCompareTable(people, rows, sort) {
  const winners = rows.map(row => winnersFor(row, people));
  const th = row => {
    const style = row.color ? ` style="color:${row.color}${row.weight || ''}"` : '';
    return `<th class="sortable"${style} onclick="sortCompare('${esc(row.key)}')">${esc(row.label)}${arrowFor(sort, row.key)}</th>`;
  };
  const headRow = `<tr><th class="cmp-check"></th><th class="cmp-name">选手</th>${rows.map(th).join('')}</tr>`;
  const cell = (r, row, ri) => r.loading ? '<td class="cmp-load">…</td>' : `<td${winners[ri].has(r.id) ? ' class="cmp-best"' : ''}>${esc(row.render(row.rawFor(r.id)))}</td>`;
  const bodyRows = people.map(r => {
    const note = r.err ? '<span class="cmp-err" title="获取失败">⚠</span>' : '';
    const nameCell = `<div class="cmp-p">
        <img class="cmp-photo" src="${esc(r.avatar || '')}" onerror="this.style.visibility='hidden'">
        <div><a class="cmp-nm" onclick="openPlayer(${r.id})">${esc(r.name || ('#' + r.id))}</a><div class="cmp-sect">#${esc(r.id)}</div></div>
        <span class="cmp-x" title="移出对比" onclick="removeFromBasket('${esc(r.id)}')">×</span>
      </div>`;
    return `<tr>
      <td class="cmp-check"><input type="checkbox" checked onchange="toggleCompareFocus('${esc(r.id)}')" title="取消勾选可暂时隐藏"></td>
      <td class="cmp-name">${nameCell}${note}</td>${rows.map((row, ri) => cell(r, row, ri)).join('')}</tr>`;
  }).join('');
  return `<div class="tbl-wrap cmp-wrap"><table class="cmp-tbl"><thead>${headRow}</thead><tbody>${bodyRows}</tbody></table></div>`;
}

// —— 卡片列布局（可见 ≤4 人）：人=列（大照片卡头），指标=横向对齐的行。CSS grid：首列行标签 + N 人列。——
function renderCardColumns(people, rows, state, sort) {
  const n = people.length;
  const headCell = p => {
    const r = (state.rows || {})[p.id] || {};
    const head = r.head || {};
    const pl = head.player || {};
    const avatar = pl.avatar || p.avatar || '';
    const name = p.name || pl.name || ('#' + p.id);
    const power = head.power == null ? '—' : head.power;
    const honors = (head.honors || []).map(h => `<span class="badge">${esc(honorZoneName(h.zone_id, head.joined))} S${h.season_id} ${String(h.code) === '1' ? '冠军' : '第' + h.code + '名'}</span>`).join('');
    // 统一读 buildDrows 汇总的 p.err：浅层=headErr，深层=fullErr / games_error——任一层数据失败都在卡头标 ⚠
    const err = p.err ? '<span class="cmp-err" title="获取失败">⚠</span>' : '';
    return `<div class="cmpc-head">
      <img class="cmpc-photo" src="${esc(avatar)}" onerror="this.style.visibility='hidden'">
      <div class="cmpc-nm"><a onclick="openPlayer(${p.id})">${esc(name)}</a><span class="cmp-x" title="移出对比" onclick="removeFromBasket('${esc(p.id)}')">×</span></div>
      <div class="cmpc-id">#${esc(p.id)}${err}</div>
      <div class="cmpc-honors">${honors}</div>
      <div class="cmpc-pw"><b>${esc(power)}</b><span>战力值</span></div>
      <label class="cmpc-focus" title="取消勾选可暂时隐藏"><input type="checkbox" checked onchange="toggleCompareFocus('${esc(p.id)}')"> 显示</label>
    </div>`;
  };
  const winners = rows.map(row => winnersFor(row, people));
  const bodyRows = rows.map((row, ri) => {
    const style = row.color ? ` style="color:${row.color}${row.weight || ''}"` : '';
    const label = `<div class="cmpc-rowlabel sortable"${style} onclick="sortCompare('${esc(row.key)}')">${esc(row.label)}${arrowFor(sort, row.key)}</div>`;
    const cells = people.map(p => {
      if (p.loading) return '<div class="cmpc-cell cmp-load">…</div>';
      const best = winners[ri].has(p.id) ? ' cmp-best' : '';
      return `<div class="cmpc-cell${best}">${esc(row.render(row.rawFor(p.id)))}</div>`;
    }).join('');
    return label + cells;
  }).join('');
  return `<div class="cmpc" style="--n:${n}"><div class="cmpc-corner"></div>${people.map(headCell).join('')}${bodyRows}</div>`;
}

// —— 对比篮 bar（常驻搜索区下方）——
export function renderBasketHTML() {
  if (!basket.length) return '';
  const chips = basket.map(b => `<span class="bk-chip"><span class="bk-nm">${esc(b.name || ('#' + b.id))}</span><span class="bk-x" onclick="removeFromBasket('${esc(b.id)}')" title="移除">×</span></span>`).join('');
  return `<div class="bk-inner">
    <span class="bk-label">对比篮 ${basket.length}/${MAX}</span>
    <div class="bk-chips">${chips}</div>
    <button class="bk-go" onclick="openCompare()">开始对比 (${basket.length})</button>
    <button class="bk-clear" onclick="clearBasket()">清空</button>
  </div>`;
}
function renderBasket() { const el = $('#basket'); if (el) { el.innerHTML = renderBasketHTML(); el.hidden = !basket.length; } }

// —— 篮子增删（供搜索结果 ＋ 按钮与对比表调用）——
// addToBasket(el)：从 data-* 读取选手信息，去重、封顶 12。
export function addToBasket(el) {
  if (!el || !el.dataset) return;
  const id = el.dataset.id;
  if (!id || inBasket(id) || basket.length >= MAX) { syncAddButtons(); return; }
  basket.push({ id, name: el.dataset.name || '', avatar: el.dataset.avatar || '', sect: el.dataset.sect || '' });
  syncAddButtons();
  renderBasket();
  if (C) { fetchOne(id); render(); }   // 对比中新增：只拉这一个人
}
// 同步当前搜索结果里所有 ＋ 按钮的状态（加入/已满/可加）——篮子任何变化后都调用，
// 否则移出/清空后旧按钮仍停在“已加入/已满”，无法再次加入。
function syncAddButtons() {
  if (typeof document === 'undefined' || !document.querySelectorAll) return;
  const full = basket.length >= MAX;
  document.querySelectorAll('.addbtn').forEach(el => {
    const id = el.dataset && el.dataset.id;
    if (inBasket(id)) { el.textContent = '已加入'; el.classList.add('added'); el.disabled = true; }
    else if (full) { el.textContent = '已满'; el.classList.remove('added'); el.disabled = true; }
    else { el.textContent = '＋ 对比'; el.classList.remove('added'); el.disabled = false; }
  });
}
export function removeFromBasket(id) {
  basket = basket.filter(b => String(b.id) !== String(id));
  if (C) { delete C.rows[id]; C.hidden.delete(String(id)); }
  syncAddButtons();
  renderBasket();
  if (C) render();
}
export function clearBasket() {
  if (C && C.abort) C.abort.abort();
  basket = []; C = null;
  syncAddButtons();
  renderBasket();
  if (currentView() === 'compare') { setView('search'); const d = $('#detail'); if (d) d.innerHTML = ''; }
}

// —— 进入/渲染对比 ——
export function openCompare() {
  if (!basket.length) return;
  setView('compare');   // 接管 #detail；单人详情(ui.js)的迟到回调据此让位，不再互相覆盖
  $('#results').innerHTML = '';
  if (!C) C = newCompare();
  loadAll();
  render();
}
function snapshot() {
  return { basket: basket.slice(), rows: C.rows, scope: C.scope, layer: C.layer, group: C.group, custom: [...C.custom], deepMode: C.deepMode, metric: C.metric, role: C.role, sort: C.sort, hidden: [...C.hidden] };
}
// 只有当 #detail 仍归属对比表时才写入（用户可能已点开单人详情或返回搜索）。
function render() { if (C && currentView() === 'compare') { const d = $('#detail'); if (d) d.innerHTML = renderCompareHTML(snapshot()); } }

// —— 交互（内联 onclick）——
export function setCompareLayer(l) { if (!C) return; C.layer = l; C.sort = { key: '', dir: -1 }; render(); }
export function setCompareGroup(g) { if (!C) return; C.group = g; C.sort = { key: '', dir: -1 }; render(); }
// 自定义组：按 (group,key) 增删选中指标。旧 sort.key 若指向已移除列，sortRows 视其缺失、顺序不变，无需特意重置。
export function toggleCompareCustom(group, key) {
  if (!C) return;
  const i = C.custom.findIndex(([g, k]) => g === group && k === key);
  if (i >= 0) C.custom.splice(i, 1); else C.custom.push([group, key]);
  render();
}
export function setCompareDeepMode(m) { if (!C) return; C.deepMode = m; C.sort = { key: '', dir: -1 }; render(); }
export function setCompareMetric(m) { if (!C) return; C.metric = m; render(); }        // 换指标：列不变(身份)，排序仍有效
export function setCompareRole(r) { if (!C) return; C.role = r || ''; render(); }
export function setCompareScope(kind, val) {
  if (!C) return;
  if (kind === 'zone') C.scope.zone = resolveZone(val, unionJoined(snapshot()));
  else C.scope.season = (String(val).match(/\d+/) || [''])[0];
  C.rows = {};   // 换作用域：丢弃旧作用域的 head/full，避免新表头配旧数据；loadAll 会重新拉取并显示加载/失败态
  loadAll(); render();
}
export function sortCompare(key) { if (!C) return; if (C.sort.key === key) C.sort.dir *= -1; else C.sort = { key, dir: -1 }; render(); }
export function toggleCompareFocus(id) { if (!C) return; id = String(id); if (C.hidden.has(id)) C.hidden.delete(id); else C.hidden.add(id); render(); }
export function showAllCompare() { if (!C) return; C.hidden.clear(); render(); }

// —— 取数编排 ——
function ignorable(e) { return e && (e.name === 'AbortError' || e.name === 'LocalServerError'); }
function qs(id, only) {
  const p = new URLSearchParams();
  p.set('id', id); p.set('zone', C.scope.zone);
  if (C.scope.season) p.set('season', C.scope.season);
  if (only) p.set('only', only);
  return p.toString();
}

// loadAll：浅层全发（秒出），深层延后 + 限并发在后台预热（让浅层先抢占上游闸门）。
function loadAll() {
  const gen = ++C.gen;
  if (C.abort) C.abort.abort();
  C.abort = new AbortController();
  const signal = C.abort.signal;
  const stale = () => !C || C.gen !== gen;
  const ids = basket.map(b => b.id);

  ids.forEach(id => fetchHead(id, signal, stale));
  // 深层后台预热：延后 400ms 让浅层先返回；限并发 4，避免抢光 12 路上游闸门。
  setTimeout(() => { if (!stale()) runLimited(ids, 4, id => fetchFull(id, signal, stale), signal); }, 400);
}

// fetchOne：对比中新增单人（复用当前代际的 signal）。
function fetchOne(id) {
  if (!C || !C.abort) return;
  const gen = C.gen, signal = C.abort.signal, stale = () => !C || C.gen !== gen;
  fetchHead(id, signal, stale);
  setTimeout(() => { if (!stale()) fetchFull(id, signal, stale); }, 400);
}

function row(id) { return (C.rows[id] = C.rows[id] || {}); }
function fetchHead(id, signal, stale) {
  const r = row(id); r.loadingHead = true; r.headErr = null;
  return detail(qs(id, 'head'), signal).then(m => {
    if (stale()) return; r.head = m; r.loadingHead = false; render();
  }).catch(e => {
    if (stale() || ignorable(e)) return; r.loadingHead = false; r.headErr = e.message; render();
  });
}
function fetchFull(id, signal, stale) {
  const r = row(id); r.loadingFull = true; r.fullErr = null;
  return detail(qs(id), signal).then(m => {
    if (stale()) return; r.full = m; r.loadingFull = false; if (C.layer === 'deep') render();
  }).catch(e => {
    if (stale() || ignorable(e)) return; r.loadingFull = false; r.fullErr = e.message; if (C.layer === 'deep') render();
  });
}

// 限并发跑一批异步任务（深层预热用）。任务失败已在各自 .catch 里吞掉，这里不 reject。
function runLimited(items, limit, fn, signal) {
  let i = 0;
  const next = () => {
    if (signal && signal.aborted) return Promise.resolve();
    if (i >= items.length) return Promise.resolve();
    const item = items[i++];
    return Promise.resolve(fn(item)).catch(() => {}).then(next);
  };
  const runners = [];
  for (let k = 0; k < Math.min(limit, items.length); k++) runners.push(next());
  return Promise.all(runners);
}
