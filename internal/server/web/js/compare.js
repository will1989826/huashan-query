// 多人对比：对比篮（最多 12 人）+ 对比表。数据全部复用现有 /api/players/detail：
//   - 浅层（综合/好人/狼人）：每人 ?only=head（只打 stats，秒出汇总指标），页面侧扇出拼矩阵；
//   - 深层（按身份/同场）：用户切换到对应页签后限并发读取每人全量 detail；按身份直接读 Go 算好的 roles[]，
//     同场对比则用逐场里的稳定 game_id 求交集，并只对交集做小规模汇总与排版。
// 页面负责格式化、排序、筛选与多人结果拼接（与 ui.js 一致的边界）。排序/键值原语复用 format.js。
import { esc, fmt, kvMap, sortRows, roleColor, roleWeight, arrowFor, isGoodCamp } from './format.js';
import { resolveZone, zoneName, honorZoneName } from './zone.js';
import { detail } from './api.js';
import { currentView, setView } from './view.js';
import {
  SUMMARY_RATES, rateOf, withPanelRates, withSummaryRates, isRatioMetric,
} from './panel-metrics.js';
import { loadProfileCrestChoice, profileCrestCandidates, resolveProfileCrest } from './profile-crest.js';
import {
  DEFAULT_RADAR_METRICS, RADAR_MAX, RADAR_MIN, compareRadarSVG, compareRadarView,
  loadCompareRadarSelection, radarGroups, saveCompareRadarSelection, toggleRadarSelection,
} from './profile-radar.js';
import {
  compareViewOf, compareViewPickerHTML, focusedCompareIDs, loadCompareView, overviewContext,
  overviewRows, renderCompareOverview, saveCompareView, validCompareView,
} from './compare-views.js';

const $ = s => document.querySelector(s);
export const MAX = 12;
export const compareLayerNeedsFull = layer => layer === 'deep' || layer === 'shared';

// —— 对比篮（跨搜索/对比持续存在的模块级状态）——
let basket = [];   // [{id, name, avatar, sect}]
export const inBasket = id => basket.some(b => String(b.id) === String(id));
export const basketCount = () => basket.length;
export function __resetBasket() { basket = []; C = null; }   // 测试用
export function __setCompareState(state, players = []) { C = state; basket = players; }   // 测试用

// —— 对比视图状态（进入对比才建；null=未在对比）——
let C = null;
function newCompare() {
  return {
    scope: { zone: 'ALL', season: '' },
    compareView: loadCompareView(), overviewChoices: {}, focusedIDs: null, viewPositions: {},
    layer: 'shallow',              // shallow（按阵营）| deep（按身份）| shared（同场对比）
    group: 'comprehensive',        // 浅层子组：comprehensive | good | wolf | custom（跨组自选指标）
    custom: DEFAULT_CUSTOM.map(p => p.slice()),   // 自定义组选中的指标 [[group, key], ...]（仅浅层跨组）
    radarPickerOpen: false,
    radarSelection: loadCompareRadarSelection(),
    deepMode: 'matrix',            // 深层排法：matrix（人×身份）| byrole（选身份多指标）
    metric: 'avg',                 // matrix 展示的身份指标
    role: '',                      // byrole 选中的身份
    sharedMode: 'summary',         // 同场排法：summary（表现对比）| games（对局明细）
    sharedEdition: '',             // 对局明细的版型筛选
    sharedOrder: 'desc',           // 对局明细按日期：desc（最新）| asc（最早）
    sharedLimit: 10,               // 对局明细渐进展示，避免一次铺满长页面
    sort: { key: '', dir: -1 },    // key=''：保持篮内顺序
    hidden: new Set(),             // 聚焦子集：被隐藏的选手 id
    rows: {},                      // id → {head, full, loadingHead, loadingFull, headErr, fullErr}
    gen: 0, abort: null,
  };
}

// 身份页复用已有角色汇总；评选率只用汇总中的次数和场次换算。
const ROLE_METRICS = [
  { key: 'n', label: '场次', pct: false },
  { key: 'avg', label: '场均分', pct: false },
  { key: 'win', label: '胜率', pct: true },
  { key: 'mvp', label: 'MVP', pct: false },
  { key: 'svp', label: '尽力', pct: false },
  { key: 'bgx', label: '背锅', pct: false },
  ...SUMMARY_RATES.map(rate => ({ key: rate.key, label: rate.label, pct: true })),
];
// 同场表现的每人样本完全相同，因此总分与评选次数也可以直接比较；背锅取更低值高亮。
const SHARED_METRICS = [
  { key: 'total', label: '总分', dir: 1, render: v => v == null ? '—' : v },
  { key: 'avg', label: '场均分', dir: 1, render: v => v == null ? '—' : v },
  { key: 'win', label: '胜率', dir: 1, render: v => v == null ? '—' : v + '%' },
  { key: 'mvp', label: 'MVP', dir: 1, render: v => v == null ? '—' : v },
  { key: 'svp', label: '尽力', dir: 1, render: v => v == null ? '—' : v },
  { key: 'bgx', label: '背锅', dir: -1, render: v => v == null ? '—' : v },
  ...SUMMARY_RATES.map(rate => ({ key: rate.key, label: rate.label, dir: rate.direction, render: value => fmt(rate.key, value).val })),
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
// 新增换算率单独定义方向：背锅率越低越好，尽力率和警长率不判定优劣。
const HL_AVG = new Set(['round_point_avg', 'avg', 'win']);   // 场均分 / 深层场均分 / 深层胜率
function dirOfKey(k) { return rateOf(k)?.direction ?? ((k.endsWith('_pct') || HL_AVG.has(k)) ? 1 : 0); }

// 某浅层组实际返回的字段（官方首见顺序、去 page-side 隐藏；不猜键名、不漏字段）。colsFor 与自定义 picker 共用。
function shallowKeys(state, group) {
  const hide = SHALLOW_HIDE[group] || [];
  const seen = new Set(), keys = [];
  (state.basket || []).forEach(b => {
    withPanelRates(((((state.rows || {})[b.id] || {}).head || {})[group]) || [], hide).forEach(t => {
      if (t && t.key && !seen.has(t.key)) { seen.add(t.key); keys.push(t.key); }
    });
  });
  return keys;
}

// 当前视图的列描述 [{key,label,render,srcKey?,srcGroup?,dir,color?,weight?}]（纯函数，输入 state）
function colsFor(state) {
  if (state.layer === 'shared') return SHARED_METRICS;
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
      rateKey: rateOf(state.metric) ? state.metric : '',
      render: v => rateOf(state.metric) ? fmt(state.metric, v).val : v == null ? '—' : (m.pct ? v + '%' : v),
    }));
  }
  return ROLE_METRICS.map(m => ({ key: m.key, srcKey: m.key, dir: dirOfKey(m.key), label: m.label, render: v => rateOf(m.key) ? fmt(m.key, v).val : v == null ? '—' : (m.pct ? v + '%' : v) }));
}

// 把每人摊平成一行：把当前视图各列的值提到顶层（供 sortRows 直接按列排序），meta 用不冲突的键名。
function buildDrows(state) {
  const cols = colsFor(state);
  const shared = state.layer === 'shared' ? (state.sharedGames || intersectSharedGames(state)) : [];
  return (state.basket || []).map(b => {
    const row = (state.rows || {})[b.id] || {};
    const headPlayer = (row.head || {}).player || {};
    const fullPlayer = (row.full || {}).player || {};
    const out = { id: b.id, name: b.name || fullPlayer.name || headPlayer.name, avatar: fullPlayer.avatar || headPlayer.avatar || b.avatar, sect: b.sect };
    if (state.layer === 'shared') {
      const stats = sharedStats(shared, b.id);
      out.summary = stats;
      cols.forEach(c => { out[c.key] = stats[c.key]; });
    } else if (state.layer === 'shallow') {
      if (state.group === 'custom') {   // 每列各取所属组的 head KV
        cols.forEach(c => { const m = kvMap(withPanelRates((row.head || {})[c.srcGroup], SHALLOW_HIDE[c.srcGroup])); out[c.key] = m[c.srcKey]; });
      } else {
        const m = kvMap(withPanelRates((row.head || {})[state.group], SHALLOW_HIDE[state.group]));
        cols.forEach(c => { out[c.key] = m[c.key]; });
      }
      out.loading = !row.head && !!row.loadingHead; out.err = row.headErr;
    } else if (state.deepMode === 'matrix') {
      const roles = ((row.full || {}).roles || []).map(withSummaryRates);
      cols.forEach(c => { const ro = roles.find(r => r.role === c.key); out[c.key] = ro ? ro[state.metric] : undefined; });
      out.loading = !row.full && !!row.loadingFull; out.err = row.fullErr || (row.full && row.full.games_error);
    } else {
      const ro = ((row.full || {}).roles || []).map(withSummaryRates).find(r => r.role === state.role);
      cols.forEach(c => { out[c.key] = ro ? ro[c.key] : undefined; });
      out.loading = !row.full && !!row.loadingFull; out.err = row.fullErr || (row.full && row.full.games_error);
    }
    return out;
  });
}

// —— 统一中间表示（IR）：把 colsFor（列）与 buildDrows（每人）转成 {people, rows}——
// 表格与卡片列共用同一 rows 与同一高亮计算，只是行/列互为转置。rawFor 按 id 取该指标原值。
const comparisonMetricKey = (state, column) => state.layer === 'deep' && state.deepMode === 'matrix' ? state.metric : column.srcKey || column.key;
const isAverageMetric = key => key === 'avg' || key === 'round_point_avg' || key.endsWith(':avg');
const averageBarMaximum = (state, group, role) => state.layer === 'shallow' ? (group === 'wolf' ? 8 : 8.5)
  : state.layer === 'deep' ? (isGoodCamp(role) ? 8.5 : 8) : 8.5;

function buildIR(state) {
  const cols = colsFor(state);
  const people = buildDrows(state);
  const byId = Object.fromEntries(people.map(r => [r.id, r]));
  const rows = cols.map(c => ({
    key: c.key, label: c.label, color: c.color, weight: c.weight, rateKey: c.rateKey, dir: c.dir == null ? 1 : c.dir, render: c.render,
    barMax: isAverageMetric(comparisonMetricKey(state, c)) ? averageBarMaximum(state, c.srcGroup || state.group, state.deepMode === 'matrix' ? c.key : state.role) : undefined,
    rawFor: id => { const r = byId[id]; return r ? r[c.key] : undefined; },
    overviewSupport: () => rateOverviewSupport(state, c, byId),
  }));
  return { people, rows };
}

const ACTION_RATE_COUNTS = {
  zhanbian_pct: ['zhanbian_total', 'zhanbian_snum'],
  hantiao_pct: ['hantiao_total', 'hantiao_snum'],
  fds_pct: ['fds_total', 'fds_snum'],
};
const ROLE_RATE_SAMPLES = {
  nvyl_pct: { role: '女巫', key: 'role-sample:nvyl_pct' },
  ztfl_pct: { role: '侦探', key: 'role-sample:ztfl_pct' },
  lrql_pct: { role: '猎人', key: 'role-sample:lrql_pct' },
  yyjyl_pct: { role: '预言家', key: 'role-sample:yyjyl_pct' },
};

// Evidence comes from the selected metric's existing summary, even for custom-only rates and role matrices.
function rateOverviewSupport(state, column, peopleById) {
  const shallow = state.layer === 'shallow';
  const metric = comparisonMetricKey(state, column);
  if (!isRatioMetric(metric)) return null;
  const group = column.srcGroup || state.group;
  const role = state.deepMode === 'matrix' ? column.key : state.role;
  const roleSample = shallow ? ROLE_RATE_SAMPLES[metric] : null;
  const sources = Object.fromEntries((state.basket || []).map(person => {
    const data = state.rows?.[person.id] || {};
    const source = shallow ? kvMap(withPanelRates(data.head?.[group], SHALLOW_HIDE[group]))
      : state.layer === 'shared' ? peopleById[person.id]?.summary
      : withSummaryRates((data.full?.roles || []).find(item => item.role === role) || {});
    if (roleSample) {
      const sample = (data.full?.roles || []).find(item => item.role === roleSample.role);
      const hasOfficialRate = source[metric] != null && source[metric] !== '';
      const sampleAvailable = data.full && !data.fullErr && !data.full.games_error;
      source[`${roleSample.key}:n`] = sampleAvailable ? (sample ? sample.n : (hasOfficialRate ? undefined : 0)) : undefined;
      source[`${roleSample.key}:avg`] = sampleAvailable && sample ? sample.avg : undefined;
      source[`${roleSample.key}:win`] = sampleAvailable && sample ? sample.win : undefined;
    }
    return [person.id, source || {}];
  }));
  const prefix = shallow && state.group === 'custom' ? `${GROUP_PREFIX[group]}·` : '';
  const makeRow = (key, label, dir = 0, render = value => value == null ? '—' : value) => ({
    key: `support:${column.key}:${key}`, label: prefix + label, dir, render,
    barMax: isAverageMetric(key) ? averageBarMaximum(state, group, role) : undefined,
    rawFor: id => sources[id]?.[key],
  });
  const derived = rateOf(metric);
  const actionCounts = shallow && ACTION_RATE_COUNTS[metric];
  const roundBased = shallow && (metric === 'win_pct' || metric === 'cunhuo_pct');
  const pendingSamples = roleSample && (state.basket || []).filter(person => state.rows?.[person.id]?.loadingFull).length;
  const failedSamples = roleSample && (state.basket || []).filter(person => {
    const data = state.rows?.[person.id];
    return data?.fullErr || data?.full?.games_error;
  }).length;
  const incompleteSamples = roleSample && (state.basket || []).filter(person => state.rows?.[person.id]?.full?.games_trunc).length;
  const mismatchedSamples = roleSample && (state.basket || []).filter(person => {
    const source = sources[person.id];
    const data = state.rows?.[person.id];
    return data?.full && !data.full.games_error && source?.[metric] != null && source?.[metric] !== ''
      && source?.[`${roleSample.key}:n`] == null;
  }).length;
  let denominator = shallow ? 'round_total' : 'n', denominatorLabel = '场次';
  let numerator, numeratorLabel = metric === 'win_pct' || metric === 'win' ? '胜场' : metric === 'cunhuo_pct' ? '存活场次' : '对应次数';
  let note;
  if (derived) {
    numerator = shallow ? derived.count : derived.summary;
    numeratorLabel = fmt(derived.count, 0).name;
    note = `${derived.label} = ${numeratorLabel} ÷ 场次 × 100%；下方数据均取同一比较范围。`;
  } else if (actionCounts) {
    [denominator, numerator] = actionCounts;
    denominatorLabel = fmt(denominator, 0).name;
    numeratorLabel = fmt(numerator, 0).name;
    note = `${fmt(metric, 0).name}的分母是${denominatorLabel}，不是场次；下方保留原始次数。`;
  } else if (roundBased) {
    note = `${fmt(metric, 0).name}使用当前分组场次作为分母；面板未提供${numeratorLabel}，因此不显示无法确认的次数。`;
  } else if (roleSample) {
    denominator = `${roleSample.key}:n`;
    denominatorLabel = `${roleSample.role}场次`;
    if (pendingSamples) note = `正在读取完整逐场数据，完成后显示${roleSample.role}场次、场均分和胜率。`;
    else if (failedSamples) note = `部分选手的完整逐场数据读取失败，对应身份的场次、场均分和胜率显示“—”；官方比率保持原值。`;
    else if (mismatchedSamples) note = `部分选手有${fmt(metric, 0).name}，但逐场数据中未找到对应的${roleSample.role}身份，身份数据显示“—”以便核对。`;
    else if (incompleteSamples) note = `部分选手的逐场数据未能完整读取，当前${roleSample.role}场次、场均分和胜率可能不完整；官方比率保持原值。`;
    else note = `${roleSample.role}场次、场均分和胜率来自完整逐场数据，也会复用于“按身份”比较和排序。`;
  } else {
    denominatorLabel = '参考场次';
    note = '当前面板未提供该比率的完整原始次数，场次仅作参考；缺失次数显示“—”，不从百分比反推。';
  }
  const rows = [
    makeRow(denominator, denominatorLabel),
    ...(roundBased || roleSample ? [] : [makeRow(numerator || 'unavailable-count', numeratorLabel)]),
    ...(roleSample ? [
      makeRow(`${roleSample.key}:avg`, `${roleSample.role}场均分`, 1),
      makeRow(`${roleSample.key}:win`, `${roleSample.role}胜率`, 1, value => fmt('win_pct', value).val),
      makeRow('round_total', state.group === 'custom' ? '分组场次' : `${GROUP_PREFIX[group] || '当前分组'}场次`),
    ] : [makeRow(shallow ? 'round_point_avg' : 'avg', '场均分', 1)]),
    ...(roleSample ? [] : [metric === 'win_pct' || metric === 'win'
      ? makeRow('mvp_pct', 'MVP率', 1, value => fmt('mvp_pct', value).val)
      : makeRow(shallow ? 'win_pct' : 'win', '胜率', 1, value => fmt('win_pct', value).val)]),
  ];
  return { rows, note };
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

// game_id 同时也是单局接口的键；只接受数字 ID，避免把异常行拼进内联 openGame 调用。
function gameKey(game) {
  const id = game && game.game_id;
  const key = id == null ? '' : String(id);
  return /^\d+$/.test(key) ? key : '';
}

function sharedLoadState(state) {
  const rs = (state.basket || []).map(b => ({ basket: b, row: (state.rows || {})[b.id] || {} }));
  const pending = rs.filter(x => !x.row.full && !x.row.fullErr);
  const failed = rs.filter(x => x.row.fullErr || (x.row.full && x.row.full.games_error));
  const truncated = rs.filter(x => x.row.full && x.row.full.games_trunc);
  return { loaded: rs.length - pending.length, pending, failed, truncated };
}

const sharedGameCache = new WeakMap();

// 从逐场最少的选手开始探测；只为候选 game_id 保留索引，避免 12 名重度选手各建一份全量 Map。
// rows 与每人的 games[] 引用不变时直接复用结果，排序、隐藏和明细切页不重复扫描全部逐场。
function intersectSharedGames(state) {
  const rows = state.rows || {};
  const entries = (state.basket || []).map(b => ({
    id: String(b.id), games: (((rows[b.id] || {}).full || {}).games || []),
  }));
  if (!entries.length) return [];
  const cache = state.rows && sharedGameCache.get(state.rows);
  if (cache && cache.ids.length === entries.length && entries.every((e, i) => cache.ids[i] === e.id && cache.games[i] === e.games)) return cache.result;

  const base = entries.reduce((a, b) => a.games.length <= b.games.length ? a : b);
  const candidates = new Map();
  base.games.forEach(g => {
    const id = gameKey(g);
    if (id && !candidates.has(id)) candidates.set(id, { id, meta: g, byId: { [base.id]: g } });
  });
  for (const entry of entries) {
    if (entry === base || !candidates.size) continue;
    const seen = new Set();
    entry.games.forEach(g => {
      const id = gameKey(g), candidate = candidates.get(id);
      if (candidate && !seen.has(id)) { candidate.byId[entry.id] = g; seen.add(id); }
    });
    candidates.forEach((_, id) => { if (!seen.has(id)) candidates.delete(id); });
  }
  const out = [...candidates.values()];
  if (state.rows) sharedGameCache.set(state.rows, { ids: entries.map(e => e.id), games: entries.map(e => e.games), result: out });
  return out;
}

function round2(n) { return Math.sign(n) * Math.round(Math.abs(n) * 100) / 100; }
function sharedStats(games, id) {
  const rows = games.map(g => g.byId[String(id)]).filter(Boolean);
  if (!rows.length) return {};
  const total = rows.reduce((n, g) => n + (+g.total_point || 0), 0);
  const count = key => rows.reduce((n, g) => n + (+g[key] === 1 ? 1 : 0), 0);
  return withSummaryRates({
    n: rows.length, total: round2(total), avg: round2(total / rows.length), win: Math.round(count('win') / rows.length * 100),
    mvp: count('mvp'), svp: count('svp'), bgx: count('bgx'),
  });
}

function compareRateNote(state, ir) {
  const hasRates = ir.rows.some(row => rateOf(row.rateKey || row.key.split(':').at(-1)));
  return hasRates && compareViewOf(state) === 'full' ? '<p class="panel-rate-note">换算率使用当前分组的次数 ÷ 场次；保留原始次数，显示最多两位小数，按未舍入数值排序。</p>' : '';
}

function renderCompareRadar(people, state) {
  if (state.layer !== 'shallow' || people.length < 2 || people.length > 4) return '';
  const players = people.map(person => {
    const head = (((state.rows || {})[person.id] || {}).head) || {};
    return { id: person.id, name: person.name, groups: radarGroups(head) };
  });
  const view = compareRadarView(players, state.radarSelection);
  const loading = people.some(person => person.loading);
  const optionHTML = view.options.map(option => {
    const atMin = option.selected && view.selectedCount <= RADAR_MIN;
    const atMax = !option.selected && view.selectedCount >= RADAR_MAX;
    const disabled = atMin || atMax || (!option.available && !option.selected);
    return `<label class="radar-option${option.selected ? ' selected' : ''}${!option.available ? ' unavailable' : ''}">
      <input type="checkbox" data-compare-radar-metric="${option.id}"${option.selected ? ' checked' : ''}${disabled ? ' disabled' : ''} onchange="toggleCompareRadarMetric(this.dataset.compareRadarMetric,this.checked)">
      <span><b>${option.label}</b><small>${option.availableCount}/${people.length} 人有数据</small></span>
    </label>`;
  }).join('');
  let chart;
  if (loading) {
    chart = '<div class="radar-empty"><b>正在读取对比数据</b><span>全部选手的概览返回后会自动绘制。</span></div>';
  } else if (view.complete) {
    chart = compareRadarSVG(view);
  } else {
    const labels = view.missing.map(axis => axis.label).join('、');
    chart = `<div class="radar-empty"><b>当前维度的数据不齐</b><span>${labels ? `请调整${esc(labels)}，只选择全员都有数据的指标。` : '至少保留五个全员都有数据的指标。'}</span></div>`;
  }
  const legend = view.players.map((player, playerIndex) => {
    const summary = view.axes.map(axis => {
      return `${axis.short} ${axis.valueTexts[playerIndex]}`;
    }).join(' · ');
    return `<div class="compare-radar-person series-${playerIndex}"><i></i><span><b>${esc(player.name)}</b><small>${esc(summary)}</small></span></div>`;
  }).join('');
  const picker = state.radarPickerOpen && !loading
    ? `<div class="radar-picker"><div class="radar-picker-note"><span>选择 ${RADAR_MIN}–${RADAR_MAX} 个全员都有数据的指标</span><button type="button" onclick="resetCompareRadarMetrics()">恢复默认</button></div><div class="radar-options">${optionHTML}</div></div>`
    : '';
  return `<section class="compare-radar-card">
    <header class="profile-radar-head"><div><small>MULTI PLAYER RADAR</small><h3>多人表现雷达图</h3><p>所有选手共用维度；好人和狼人场均分上限分别为 8.5 分和 8 分。</p></div><button type="button" class="radar-config" aria-expanded="${!!state.radarPickerOpen}" onclick="toggleCompareRadarPicker()">选择维度 ${view.selectedCount}/${RADAR_MAX}</button></header>
    ${picker}<div class="compare-radar-body"><div class="radar-plot">${chart}</div><div class="compare-radar-legend">${legend}</div></div>
  </section>`;
}

// —— 纯渲染：输入快照 state，输出对比表 HTML（无 DOM 副作用，便于单测）——
export function renderCompareHTML(state) {
  const { basket: bk = [], scope = { zone: 'ALL', season: '' }, layer = 'shallow', sort = { key: '', dir: -1 } } = state;
  const hidden = state.hidden || [];
  if (!bk.length) return '<div class="muted" style="padding:16px">对比篮是空的，先搜索选手并点“＋”加入。</div>';

  // 顶层：按阵营（stats 秒出）/ 按身份（逐场细分）/ 同场对比（game_id 交集）。
  const layerTabs = [['shallow', '按阵营'], ['deep', '按身份'], ['shared', '同场对比']]
    .map(([k, l]) => `<button type="button" class="qf${layer === k ? ' on' : ''}" aria-pressed="${layer === k}" onclick="setCompareLayer('${k}')">${l}</button>`).join('');

  // 范围（zone 候选=各人 joined 并集；season 候选=各人 season_cands 并集，可手动输）
  const joined = unionJoined(state);
  const zName = scope.zone === 'ALL' ? '' : zoneName(scope.zone, joined);
  const zoneOpts = ['全部赛区', ...joined.map(j => j.text)].map(t => `<option value="${esc(t)}">`).join('');
  const seasonOpts = ['全部赛季', ...unionSeasons(state).map(n => 'S' + n)].map(t => `<option value="${esc(t)}">`).join('');
  const scopeBar = `<div class="cmp-scope">
    <div class="f"><label>赛区</label><input id="cmpzone" list="dlcmpzone" placeholder="全部赛区" value="${esc(zName)}" autocomplete="off" onfocus="this.dataset.prev=this.value;this.value=''" onblur="if(!this.value)this.value=this.dataset.prev||''" onchange="setCompareScope('zone',this.value)"><datalist id="dlcmpzone">${zoneOpts}</datalist></div>
    <div class="f"><label>赛季</label><input id="cmpseason" list="dlcmpseason" placeholder="全部赛季" value="${scope.season ? 'S' + esc(scope.season) : ''}" autocomplete="off" onfocus="this.dataset.prev=this.value;this.value=''" onblur="if(!this.value)this.value=this.dataset.prev||''" onchange="setCompareScope('season',this.value)"><datalist id="dlcmpseason">${seasonOpts}</datalist></div>
  </div>`;

  // 子选择区：浅层=统计组；深层=身份排法；同场=表现与明细二选一，一次只铺一类数据。
  let subBar;
  if (layer === 'shallow') {
    const tabsRow = `<div class="qfbar cmp-tabs">${[['comprehensive', '综合'], ['good', '好人'], ['wolf', '狼人'], ['custom', '自定义']]
      .map(([g, l]) => `<button type="button" class="qf${state.group === g ? ' on' : ''}" aria-pressed="${state.group === g}" onclick="setCompareGroup('${g}')">${l}</button>`).join('')}</div>`;
    if (state.group === 'custom') {   // 跨组自选：三组各列可开关 chip；勾选项即成对比行
      const sel = new Set((state.custom || []).map(([g, k]) => g + ':' + k));
      const grps = [['comprehensive', '综合'], ['good', '好人'], ['wolf', '狼人']].map(([g, gl]) => {
        // 候选 = 当前作用域实际返回的字段 ∪ 已勾选字段（后者保证：换作用域后已选项即便当前无人拥有，仍能取消勾选）
        const found = shallowKeys(state, g);
        const selKeys = (state.custom || []).filter(([cg]) => cg === g).map(([, k]) => k);
        const keys = [...found, ...selKeys.filter(k => !found.includes(k))];
        if (!keys.length) return '';
        const chips = keys.map(k => `<button type="button" class="qf${sel.has(g + ':' + k) ? ' on' : ''}" aria-pressed="${sel.has(g + ':' + k)}" onclick="toggleCompareCustom('${g}','${esc(k)}')">${esc(fmt(k, 0).name)}</button>`).join('');
        return `<div class="cmp-pickgrp"><span class="cmp-pickgl">${gl}</span><div class="cmp-pickchips">${chips}</div></div>`;
      }).join('');
      subBar = tabsRow + `<div class="cmp-picker">${grps || '<span class="muted">指标加载中，稍候可选。</span>'}</div>`;
    } else {
      subBar = tabsRow;
    }
  } else if (layer === 'deep') {
    const modeTabs = [['matrix', '人 × 身份'], ['byrole', '单个身份']]
      .map(([k, l]) => `<button type="button" class="qf${state.deepMode === k ? ' on' : ''}" aria-pressed="${state.deepMode === k}" onclick="setCompareDeepMode('${k}')">${l}</button>`).join('');
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
  } else {
    subBar = `<div class="qfbar cmp-tabs cmp-shared-tabs">${[['summary', '表现对比'], ['games', '对局明细']]
      .map(([k, l]) => `<button type="button" class="qf${state.sharedMode === k ? ' on' : ''}" aria-pressed="${state.sharedMode === k}" onclick="setSharedMode('${k}')">${l}</button>`).join('')}</div>`;
  }

  const shell = body => `<div class="cmp">
    <div class="cmp-head"><h3>选手对比 <small>· ${bk.length}/${MAX} 人</small></h3>${scopeBar}</div>
    ${compareViewPickerHTML(state)}
    <div class="qfbar cmp-layers">${layerTabs}</div>
    ${subBar}
    ${body}
  </div>`;

  if (layer === 'shared') return shell(renderShared(state, bk, hidden, sort));

  // 深层：先按 full 数据整体状态（拉取中 / 全失败 / 确实为空）出占位，再处理 byrole 是否已选身份——
  // 顺序不能反，否则 byrole 未选身份时会永远停在“选择一个身份”，看不到失败/空状态。
  if (layer === 'deep') {
    const roles = unionRoles(state);
    if (!roles.length) {   // 还没有任何身份数据可用（matrix 无列、byrole 无可选身份）
      const rs = bk.map(b => (state.rows || {})[b.id] || {});
      // 失败含两种：请求抛错(fullErr) 与 HTTP 200 部分降级(full.games_error，roles 可能为空但其实是拉取失败)。
      const failed = r => !!(r.fullErr || (r.full && r.full.games_error));
      if (rs.some(r => !r.full && !r.fullErr)) {   // 仍有人在拉
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
  let people = ir.people.filter(r => !hidden.map(String).includes(String(r.id)));
  const focusIDs = focusedCompareIDs(state, people);
  const radarPeople = compareViewOf(state) === 'focus' ? people.filter(p => focusIDs.includes(String(p.id))) : people;
  const radar = renderCompareRadar(radarPeople, state);
  if (sort.key && compareViewOf(state) === 'full') people = sortRows(people, sort.key, sort.dir);
  const rows = ir.rows;

  const hiddenNote = hidden.length ? `<div class="muted" style="padding:0 0 6px">已隐藏 ${hidden.length} 人 · <button type="button" class="text-button" onclick="showAllCompare()">显示全部</button></div>` : '';
  let body;
  if (!people.length) body = '<div class="muted" style="padding:8px 0">当前无可显示的选手（都被隐藏了）。</div>';
  else if (compareViewOf(state) !== 'full') body = renderCompareOverview(people, rows, state, winnersFor);
  else if (!rows.length) body = '<div class="muted" style="padding:8px 0">请选择要对比的指标。</div>';
  else body = people.length <= 4 ? renderCardColumns(people, rows, state, sort) : renderCompareTable(people, rows, sort);

  const foot = rows.length && people.length
    ? compareViewOf(state) === 'full'
      ? '<div class="muted" style="padding:6px 0 0">点指标排序 · 点名字看单人详情 · 取消勾选可隐藏 · 可比较指标高亮最优值</div>'
      : '<div class="cmp-overview-foot">点名字查看个人详情 · 次数不直接判定优劣 · 完整指标可在“数据详览”查看</div>' : '';
  return shell(`${hiddenNote}${compareRateNote(state, ir)}${body}${radar}${foot}`);
}

function sharedHiddenNote(hidden, total) {
  return hidden.length
    ? `<div class="muted cmp-shared-hidden">仍按 ${total} 人查找共同对局，当前隐藏 ${hidden.length} 人 · <button type="button" class="text-button" onclick="showAllCompare()">显示全部</button></div>`
    : '';
}

function renderShared(state, basket, hidden, sort) {
  if (basket.length < 2) return '<div class="muted" style="padding:8px 0">至少选择 2 名选手后才能查找共同对局。</div>';
  const status = sharedLoadState(state);
  if (status.pending.length) {
    return `<div class="loading-card" role="status" aria-live="polite"><span class="loading-pulse" aria-hidden="true"></span><div><b>正在查找共同对局</b><span>已读取 ${status.loaded}/${basket.length} 名选手的逐场战绩，全部完成后显示结果。</span></div></div>`;
  }
  if (status.failed.length) {
    const names = status.failed.map(x => x.basket.name || ('#' + x.basket.id)).join('、');
    return `<div class="err cmp-shared-error">${esc(names)}的逐场数据获取失败，暂时无法确认这些选手的共同对局。可切换赛区或赛季重试。</div>`;
  }

  const games = intersectSharedGames(state);
  const incomplete = status.truncated.length > 0;
  const warning = incomplete
    ? '<div class="err cmp-shared-warning">部分选手的逐场数据不完整，当前结果可能遗漏共同对局。</div>' : '';
  if (!games.length) {
    const empty = incomplete ? '在已获取的数据中未找到共同对局。' : '所选选手没有共同参加的对局。';
    return warning + `<div class="muted cmp-shared-empty">${empty}</div>`;
  }

  const intro = `<div class="cmp-shared-intro"><b>${basket.length} 人共同参加 ${games.length} 场对局</b><span>按共同对局的相同样本比较</span></div>`;
  const hiddenNote = sharedHiddenNote(hidden, basket.length);
  if (state.sharedMode === 'games' && compareViewOf(state) === 'full') {
    return intro + warning + hiddenNote + renderSharedGames(state, games, basket, hidden);
  }

  const ir = buildIR({ ...state, sharedGames: games });
  let people = ir.people.filter(r => !hidden.includes(String(r.id)));
  if (sort.key && compareViewOf(state) === 'full') people = sortRows(people, sort.key, sort.dir);
  if (!people.length) return intro + warning + hiddenNote + '<div class="muted" style="padding:8px 0">当前无可显示的选手（都被隐藏了）。</div>';
  const table = compareViewOf(state) !== 'full'
    ? renderCompareOverview(people, ir.rows, { ...state, sharedGames: games }, winnersFor)
    : people.length <= 4 ? renderCardColumns(people, ir.rows, state, sort) : renderCompareTable(people, ir.rows, sort);
  const foot = compareViewOf(state) === 'full'
    ? '<div class="muted" style="padding:6px 0 0">点指标排序 · 点名字看单人详情 · 所有指标都只统计共同对局</div>'
    : '<div class="cmp-overview-foot">所有指标都只统计共同对局 · 重点选择或隐藏选手不会改变共同对局的计算范围</div>';
  return intro + warning + hiddenNote + compareRateNote(state, ir) + table + foot;
}

function sharedGameSort(a, b, order) {
  const ad = a.meta.play_date || '', bd = b.meta.play_date || '';
  if (ad !== bd) return order === 'asc' ? (ad < bd ? -1 : 1) : (ad < bd ? 1 : -1);
  const ai = +a.id || 0, bi = +b.id || 0;
  return order === 'asc' ? ai - bi : bi - ai;
}

function sharedMarks(row) {
  const marks = [];
  if (+row.mvp === 1) marks.push('<span class="gm mvp">MVP</span>');
  if (+row.svp === 1) marks.push('<span class="gm svp">尽力</span>');
  if (+row.bgx === 1) marks.push('<span class="gm bgx">背锅</span>');
  return marks.join('');
}

function sharedPlayerCell(row) {
  if (!row) return '<span class="muted">—</span>';
  const result = +row.win === 1 ? '<span class="res w">胜</span>' : '<span class="res l">负</span>';
  const point = row.total_point == null || row.total_point === '' ? '—' : esc(row.total_point) + '分';
  return `<div class="cmp-game-role" style="color:${roleColor(row.rpt_name)}${roleWeight(row.rpt_name)}">${row.seat == null ? '?' : esc(row.seat)}号 · ${esc(row.rpt_name || '未知身份')}</div>
    <div class="cmp-game-result"><b>${point}</b>${result}${sharedMarks(row)}</div>`;
}

function sharedGameMeta(game) {
  const g = game.meta;
  const season = g.season_id == null ? '' : `S${esc(g.season_id)}`;
  const round = g.round == null ? '' : `第${esc(g.round)}轮`;
  const bits = [season, round].filter(Boolean).join(' · ');
  return `<b>${esc(g.play_date || '日期未知')}</b><span>${bits || `对局 #${esc(game.id)}`}</span><em>${esc(g.edition_name || '版型未知')}</em>`;
}

function renderSharedGames(state, allGames, basket, hidden) {
  const editions = [...new Set(allGames.map(g => g.meta.edition_name).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const edition = state.sharedEdition || '';
  let games = edition ? allGames.filter(g => g.meta.edition_name === edition) : allGames.slice();
  games.sort((a, b) => sharedGameSort(a, b, state.sharedOrder || 'desc'));
  const people = basket.filter(b => !hidden.includes(String(b.id)));
  const editionOpts = editions.map(e => `<option value="${esc(e)}"${e === edition ? ' selected' : ''}>${esc(e)}</option>`).join('');
  const controls = `<div class="cmp-game-controls">
    <label>版型<select class="qsel" onchange="setSharedEdition(this.value)"><option value="">全部版型</option>${editionOpts}</select></label>
    <label>日期<select class="qsel" onchange="setSharedOrder(this.value)"><option value="desc"${state.sharedOrder !== 'asc' ? ' selected' : ''}>最新在前</option><option value="asc"${state.sharedOrder === 'asc' ? ' selected' : ''}>最早在前</option></select></label>
    <span>${edition ? `显示 ${games.length}/${allGames.length} 场` : `共 ${allGames.length} 场`}</span>
  </div>`;
  if (!people.length) return controls + '<div class="muted" style="padding:8px 0">当前无可显示的选手（都被隐藏了）。</div>';
  if (!games.length) return controls + '<div class="muted cmp-shared-empty">当前版型下没有共同对局。</div>';

  const limit = Math.max(10, state.sharedLimit || 10);
  const shown = games.slice(0, limit);
  const playerHeads = people.map(p => `<th><button type="button" class="cmp-nm" onclick="openPlayer(${p.id})">${esc(p.name || ('#' + p.id))}</button><small>#${esc(p.id)}</small></th>`).join('');
  const rows = shown.map(game => `<tr class="grow" role="button" tabindex="0" aria-label="查看对局 ${esc(game.meta.play_date || game.id)}" onclick="openGame(${game.id})" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openGame(${game.id})}" onmouseenter="prefetchGame(${game.id})">
    <td class="cmp-game-meta">${sharedGameMeta(game)}</td>
    ${people.map(p => `<td class="cmp-game-player">${sharedPlayerCell(game.byId[String(p.id)])}</td>`).join('')}
  </tr>`).join('');
  const desktop = `<div class="tbl-wrap cmp-wrap cmp-games-desktop"><table class="cmp-games-tbl"><thead><tr><th class="cmp-game-meta">对局</th>${playerHeads}</tr></thead><tbody>${rows}</tbody></table></div>`;
  const mobile = `<div class="cmp-games-mobile">${shown.map(game => `<article class="cmp-game-card" role="button" tabindex="0" aria-label="查看对局 ${esc(game.meta.play_date || game.id)}" onclick="openGame(${game.id})" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openGame(${game.id})}">
    <header>${sharedGameMeta(game)}</header>${people.map(p => `<div class="cmp-game-card-player"><b>${esc(p.name || ('#' + p.id))}</b><div>${sharedPlayerCell(game.byId[String(p.id)])}</div></div>`).join('')}
  </article>`).join('')}</div>`;
  const more = games.length > limit ? `<button class="morebtn" onclick="showMoreSharedGames()">加载更多（还有 ${games.length - limit} 场）</button>` : '';
  return controls + desktop + mobile + more + '<div class="muted cmp-games-foot">点任意一场查看单局复盘</div>';
}

// —— 表格布局（可见 ≥5 人）：人=行、指标=列。命中最优值的格加 cmp-best。——
function renderCompareTable(people, rows, sort) {
  const winners = rows.map(row => winnersFor(row, people));
  const th = row => {
    const style = row.color ? ` style="color:${row.color}${row.weight || ''}"` : '';
    const direction = sort.key === row.key ? (sort.dir < 0 ? 'descending' : 'ascending') : 'none';
    return `<th class="sortable" aria-sort="${direction}"${style}><button type="button" class="sort-button" onclick="sortCompare('${esc(row.key)}')">${esc(row.label)}${arrowFor(sort, row.key)}</button></th>`;
  };
  const headRow = `<tr><th class="cmp-check"></th><th class="cmp-name">选手</th>${rows.map(th).join('')}</tr>`;
  const cell = (r, row, ri) => r.loading ? '<td class="cmp-load">…</td>' : `<td${winners[ri].has(r.id) ? ' class="cmp-best"' : ''}>${esc(row.render(row.rawFor(r.id)))}</td>`;
  const bodyRows = people.map(r => {
    const note = r.err ? '<span class="cmp-err" title="获取失败">⚠</span>' : '';
    const nameCell = `<div class="cmp-p">
        <img class="cmp-photo" src="${esc(r.avatar || '')}" onerror="this.style.visibility='hidden'">
        <div><button type="button" class="cmp-nm" onclick="openPlayer(${r.id})">${esc(r.name || ('#' + r.id))}</button><div class="cmp-sect">#${esc(r.id)}</div></div>
        <button type="button" class="cmp-x" aria-label="将${esc(r.name || ('#' + r.id))}移出对比" onclick="removeFromBasket('${esc(r.id)}')">×</button>
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
    const avatar = p.avatar || pl.avatar || '';
    const name = p.name || pl.name || ('#' + p.id);
    const power = head.power == null ? '—' : head.power;
    // head 不含逐场推导的门派候选；按阵营页用搜索结果携带的门派摘要回退，避免为队徽读取完整详情。
    const basketSects = String(p.sect || '').split(/\s*·\s*/).map(s => s.trim()).filter(Boolean);
    const crestModel = r.full || ((head.sect || (head.sect_cands || []).length || (head.teams || []).length)
      ? head
      : { ...head, sect_cands: basketSects });
    const crest = resolveProfileCrest(profileCrestCandidates(crestModel), loadProfileCrestChoice(p.id));
    const crestHTML = crest ? `<img class="cmpc-crest" src="${esc(crest.crest)}" alt="${esc(crest.name)}队徽">` : '';
    const honors = (head.honors || []).map(h => `<span class="badge">${esc(honorZoneName(h.zone_id, head.joined))} S${h.season_id} ${String(h.code) === '1' ? '冠军' : '第' + h.code + '名'}</span>`).join('');
    // 统一读 buildDrows 汇总的 p.err：浅层=headErr，深层=fullErr / games_error——任一层数据失败都在卡头标 ⚠
    const err = p.err ? '<span class="cmp-err" title="获取失败">⚠</span>' : '';
    return `<div class="cmpc-head">
      <div class="cmpc-photo-wrap"><img class="cmpc-photo" src="${esc(avatar)}" onerror="this.style.visibility='hidden'">${crestHTML}</div>
      <div class="cmpc-nm"><button type="button" class="cmp-nm" onclick="openPlayer(${p.id})">${esc(name)}</button><button type="button" class="cmp-x" aria-label="将${esc(name)}移出对比" onclick="removeFromBasket('${esc(p.id)}')">×</button></div>
      <div class="cmpc-id">#${esc(p.id)}${err}</div>
      <div class="cmpc-honors">${honors}</div>
      <div class="cmpc-pw"><b>${esc(power)}</b><span>战力值</span></div>
      <label class="cmpc-focus" title="取消勾选可暂时隐藏"><input type="checkbox" checked onchange="toggleCompareFocus('${esc(p.id)}')"> 显示</label>
    </div>`;
  };
  const winners = rows.map(row => winnersFor(row, people));
  const bodyRows = rows.map((row, ri) => {
    const style = row.color ? ` style="color:${row.color}${row.weight || ''}"` : '';
    const label = `<button type="button" class="cmpc-rowlabel sortable"${style} onclick="sortCompare('${esc(row.key)}')">${esc(row.label)}${arrowFor(sort, row.key)}</button>`;
    const cells = people.map(p => {
      if (p.loading) return '<div class="cmpc-cell cmp-load">…</div>';
      const best = winners[ri].has(p.id) ? ' cmp-best' : '';
      return `<div class="cmpc-cell${best}">${esc(row.render(row.rawFor(p.id)))}</div>`;
    }).join('');
    return label + cells;
  }).join('');
  return `<div class="cmpc cmpc-n${n}" style="--n:${n}"><div class="cmpc-corner"></div>${people.map(headCell).join('')}${bodyRows}</div>`;
}

// —— 对比篮 bar（常驻搜索区下方）——
export function renderBasketHTML() {
  if (!basket.length) return '';
  const chips = basket.map(b => {
    const name = b.name || ('#' + b.id);
    return `<span class="bk-chip"><span class="bk-nm">${esc(name)}</span><button type="button" class="bk-x" onclick="removeFromBasket('${esc(b.id)}')" aria-label="将${esc(name)}移出对比">×</button></span>`;
  }).join('');
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
  if (C && currentView() === 'compare') { fetchOne(id); render(); }   // 对比中新增：只拉这一个人
}

// 批量选择只提交一次状态变化，避免逐个 addToBasket 导致重复渲染和 N 组详情请求。
export function addManyToBasket(players) {
  const added = [];
  for (const p of players || []) {
    if (basket.length >= MAX) break;
    const id = String((p && (p.id ?? p.player_id)) ?? '');
    if (!id || inBasket(id)) continue;
    const sect = p.sect || ((p.sects || []).map(s => s && s.name).filter(Boolean).join(' · '));
    basket.push({
      id,
      name: p.name || p.player_name || '',
      avatar: p.avatar || p.player_avatar || '',
      sect: sect || '',
    });
    added.push(id);
  }
  syncAddButtons();
  renderBasket();
  if (added.length && C && currentView() === 'compare') loadAll();
  render();
  return added.length;
}
// 同步当前搜索结果里所有 ＋ 按钮的状态（加入/已满/可加）——篮子任何变化后都调用，
// 否则移出/清空后旧按钮仍停在“已加入/已满”，无法再次加入。
function syncAddButtons() {
  if (typeof document === 'undefined' || !document.querySelectorAll) return;
  const full = basket.length >= MAX;
  document.querySelectorAll('.addbtn').forEach(el => {
    const id = el.dataset && el.dataset.id;
    const name = (el.dataset && el.dataset.name) || ('#' + id);
    if (inBasket(id)) { el.textContent = '已加入'; el.setAttribute('aria-label', `已将${name}加入对比`); el.classList.add('added'); el.disabled = true; }
    else if (full) { el.textContent = '已满'; el.setAttribute('aria-label', `对比人数已满，无法添加${name}`); el.classList.remove('added'); el.disabled = true; }
    else { el.textContent = '＋ 对比'; el.setAttribute('aria-label', `添加${name}到对比`); el.classList.remove('added'); el.disabled = false; }
  });
}
export function removeFromBasket(id) {
  basket = basket.filter(b => String(b.id) !== String(id));
  if (C) {
    delete C.rows[id]; C.hidden.delete(String(id));
    if (Array.isArray(C.focusedIDs)) C.focusedIDs = C.focusedIDs.filter(value => String(value) !== String(id));
  }
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
  return {
    compareView: C.compareView, overviewChoices: C.overviewChoices, focusedIDs: C.focusedIDs,
    basket: basket.slice(), rows: C.rows, scope: C.scope, layer: C.layer, group: C.group, custom: [...C.custom],
    radarPickerOpen: !!C.radarPickerOpen, radarSelection: [...(C.radarSelection || DEFAULT_RADAR_METRICS)],
    deepMode: C.deepMode, metric: C.metric, role: C.role, sharedMode: C.sharedMode, sharedEdition: C.sharedEdition,
    sharedOrder: C.sharedOrder, sharedLimit: C.sharedLimit, sort: C.sort, hidden: [...C.hidden],
  };
}
const compareScrollContainer = detail => detail?.querySelector?.('.cmp-wrap') || detail?.querySelector?.('.cmpc');

// 只有当 #detail 仍归属对比表时才写入（用户可能已点开单人详情或返回搜索）。
// 排序会重建整张表；重建后恢复横向位置，避免查看后段指标时跳回第一列。
function render(preserveHorizontalScroll = false) {
  if (!C || currentView() !== 'compare') return;
  const d = $('#detail');
  if (!d) return;
  const previousWrap = preserveHorizontalScroll && compareScrollContainer(d);
  const scrollLeft = previousWrap ? previousWrap.scrollLeft : 0;
  d.innerHTML = renderCompareHTML(snapshot());
  if (!preserveHorizontalScroll || !d.querySelector) return;
  const nextWrap = compareScrollContainer(d);
  if (nextWrap) nextWrap.scrollLeft = scrollLeft;
}

// —— 交互（内联 onclick）——
function focusCompareControl(selector) {
  const element = $('#detail')?.querySelector?.(selector);
  if (element && typeof element.focus === 'function') element.focus({ preventScroll: true });
}
function switchCompareView(view, persist) {
  if (!C || !validCompareView(view) || compareViewOf(C) === view) return;
  const previous = compareViewOf(C);
  const wrap = compareScrollContainer($('#detail'));
  C.viewPositions ||= {};
  C.viewPositions[previous] = { x: wrap?.scrollLeft || 0, y: typeof window === 'undefined' ? 0 : window.scrollY || 0 };
  C.compareView = view;
  if (view !== 'full' && C.layer === 'shared') C.sharedMode = 'summary';
  if (persist) saveCompareView(view);
  ensureFull();
  render(false);
  const position = C.viewPositions[view];
  const nextWrap = compareScrollContainer($('#detail'));
  if (nextWrap && position) nextWrap.scrollLeft = position.x;
  focusCompareControl(`[data-compare-view="${view}"]`);
  if (position && typeof window !== 'undefined' && typeof window.scrollTo === 'function') window.scrollTo(0, position.y);
}
export function setCompareView(view) { switchCompareView(view, true); }
export function setCompareOverviewMetric(metric) {
  if (!C) return;
  const state = snapshot();
  if (!colsFor(state).some(row => row.key === metric)) return;
  C.overviewChoices ||= {};
  C.overviewChoices[overviewContext(state)] = { metric, dir: -1 };
  ensureFull();
  render(true);
  focusCompareControl('#cmp-overview-metric');
}
export function toggleCompareOverviewOrder() {
  if (!C) return;
  const state = snapshot();
  const selected = overviewRows(state, buildIR(state).rows);
  if (!selected.primary) return;
  C.overviewChoices ||= {};
  C.overviewChoices[overviewContext(state)] = { metric: selected.primary.key, dir: -selected.dir };
  render(true);
  focusCompareControl('#cmp-overview-direction');
}
export function toggleCompareSpotlight(id) {
  if (!C) return;
  id = String(id);
  const visible = basket.filter(person => !C.hidden.has(String(person.id)));
  if (!visible.some(person => String(person.id) === id)) return;
  const current = focusedCompareIDs(C, visible);
  if (current.includes(id)) C.focusedIDs = current.filter(value => value !== id);
  else if (current.length < 4) C.focusedIDs = [...current, id];
  else return;
  render();
  focusCompareControl(`[data-spotlight-id="${id}"]`);
}
export function setCompareLayer(l) {
  if (!C) return;
  C.layer = l; C.sort = { key: '', dir: -1 };
  ensureFull();
  render();
}
export function setCompareGroup(g) { if (!C) return; C.group = g; C.sort = { key: '', dir: -1 }; ensureFull(); render(); }
// 自定义组：按 (group,key) 增删选中指标。旧 sort.key 若指向已移除列，sortRows 视其缺失、顺序不变，无需特意重置。
export function toggleCompareCustom(group, key) {
  if (!C) return;
  const i = C.custom.findIndex(([g, k]) => g === group && k === key);
  if (i >= 0) C.custom.splice(i, 1); else C.custom.push([group, key]);
  render();
}
export function toggleCompareRadarPicker() { if (!C) return; C.radarPickerOpen = !C.radarPickerOpen; render(true); }
export function toggleCompareRadarMetric(id, checked) {
  if (!C) return;
  C.radarSelection = saveCompareRadarSelection(toggleRadarSelection(C.radarSelection, id, checked));
  render(true);
}
export function resetCompareRadarMetrics() {
  if (!C) return;
  C.radarSelection = saveCompareRadarSelection([...DEFAULT_RADAR_METRICS]);
  render(true);
}
export function setCompareDeepMode(m) { if (!C) return; C.deepMode = m; C.sort = { key: '', dir: -1 }; render(); }
export function setCompareMetric(m) { if (!C) return; C.metric = m; render(true); }    // 换指标：列不变(身份)，排序仍有效
export function setCompareRole(r) { if (!C) return; C.role = r || ''; render(); }
export function setSharedMode(mode) {
  if (!C) return;
  C.sharedMode = mode === 'games' ? 'games' : 'summary'; C.sort = { key: '', dir: -1 };
  if (mode === 'games' && compareViewOf(C) !== 'full') switchCompareView('full', false);
  else render();
}
export function setSharedEdition(edition) { if (!C) return; C.sharedEdition = edition || ''; C.sharedLimit = 10; render(); }
export function setSharedOrder(order) { if (!C) return; C.sharedOrder = order === 'asc' ? 'asc' : 'desc'; render(); }
export function showMoreSharedGames() { if (!C) return; C.sharedLimit += 10; render(); }
export function setCompareScope(kind, val) {
  if (!C) return;
  if (kind === 'zone') C.scope.zone = resolveZone(val, unionJoined(snapshot()));
  else C.scope.season = (String(val).match(/\d+/) || [''])[0];
  C.rows = {};   // 换作用域：丢弃旧作用域的 head/full，避免新表头配旧数据；loadAll 会重新拉取并显示加载/失败态
  C.sharedEdition = ''; C.sharedLimit = 10;
  loadAll(); render();
}
export function sortCompare(key) { if (!C) return; if (C.sort.key === key) C.sort.dir *= -1; else C.sort = { key, dir: -1 }; render(true); }
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

function overviewRoleSample(state = snapshot()) {
  if (state.layer !== 'shallow' || compareViewOf(state) === 'full') return null;
  const metric = state.overviewChoices?.[overviewContext(state)]?.metric;
  if (!colsFor(state).some(column => column.key === metric)) return null;
  return ROLE_RATE_SAMPLES[String(metric || '').split(':').at(-1)] || null;
}
function fullDataNeeded() { return !!C && (compareLayerNeedsFull(C.layer) || !!overviewRoleSample()); }

// loadAll：先读取所有人的浅层概览；按身份、同场对比或需身份样本的重点指标再读取完整详情。
function loadAll() {
  const gen = ++C.gen;
  if (C.abort) C.abort.abort();
  // 上一代队列可能在任务真正启动前被取消；清掉排队标记，让新代际可以重新接管。
  Object.values(C.rows).forEach(r => { r.loadingHead = false; r.loadingFull = false; });
  C.abort = new AbortController();
  const signal = C.abort.signal;
  const stale = () => !C || C.gen !== gen;
  const ids = basket.map(b => b.id);

  ids.forEach(id => fetchHead(id, signal, stale));
  ensureFull();
}

// fetchOne：对比中新增单人（复用当前代际的 signal）。
function fetchOne(id) {
  if (!C || !C.abort) return;
  const gen = C.gen, signal = C.abort.signal, stale = () => !C || C.gen !== gen;
  fetchHead(id, signal, stale);
  if (fullDataNeeded()) fetchFull(id, signal, stale);
}

function ensureFull() {
  if (!C || !C.abort || !fullDataNeeded()) return;
  const gen = C.gen, signal = C.abort.signal, stale = () => !C || C.gen !== gen;
  const ids = basket.map(b => b.id).filter(id => {
    const r = C.rows[id];
    return !r || (!r.full && !r.loadingFull);
  });
  // 排队时即占位，避免快速切换深层页签时把尚未启动的选手重复放进第二个并发池。
  ids.forEach(id => { const r = row(id); r.loadingFull = true; r.fullErr = null; });
  runLimited(ids, 4, id => fetchFull(id, signal, stale), signal);
}

function row(id) { return (C.rows[id] = C.rows[id] || {}); }
function fetchHead(id, signal, stale) {
  const r = row(id); r.loadingHead = true; r.headErr = null;
  return detail(qs(id, 'head'), signal).then(m => {
    if (stale()) return; r.head = m; r.loadingHead = false; ensureFull(); render();
  }).catch(e => {
    if (stale() || ignorable(e)) return; r.loadingHead = false; r.headErr = e.message; render();
  });
}
function fetchFull(id, signal, stale) {
  const r = row(id); r.loadingFull = true; r.fullErr = null;
  return detail(qs(id), signal).then(m => {
    if (stale()) return; r.full = m; r.loadingFull = false; render();
  }).catch(e => {
    if (stale() || ignorable(e)) return; r.loadingFull = false; r.fullErr = e.message; if (fullDataNeeded()) render();
  });
}

// 限并发跑一批异步任务（深层详情用）。任务失败已在各自 .catch 里吞掉，这里不 reject。
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
