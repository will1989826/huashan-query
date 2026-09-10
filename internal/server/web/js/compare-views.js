import { esc, sortRows, kvMap } from './format.js';
import { loadProfileCrestChoice, profileCrestCandidates, resolveProfileCrest } from './profile-crest.js';
import { rateDescription, rateOf } from './panel-metrics.js';

export const COMPARE_VIEWS = Object.freeze([
  { id: 'cards', label: '全景概览', note: '浏览选手照片与核心表现，可按关注的指标排列。' },
  { id: 'focus', label: '焦点对照', note: '保留全员名单，选择最多 4 人放大对照。' },
  { id: 'full', label: '数据详览', note: '查看完整指标，保留原有表格和少人数卡片。' },
]);
const STORAGE_KEY = 'compare-view';
export const validCompareView = view => COMPARE_VIEWS.some(item => item.id === view);
export function loadCompareView() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (validCompareView(saved)) return saved;
  } catch { }
  return 'cards';
}
export function saveCompareView(view) {
  if (validCompareView(view)) { try { localStorage.setItem(STORAGE_KEY, view); } catch { } }
}

export const overviewContext = state => [state.layer, state.group, state.deepMode, state.metric, state.role].join('|');
export const compareViewOf = state => validCompareView(state.compareView) ? state.compareView : 'full';
export function focusedCompareIDs(state, people) {
  const available = new Set(people.map(p => String(p.id)));
  const ids = Array.isArray(state.focusedIDs) ? state.focusedIDs : people.slice(0, 4).map(p => p.id);
  return [...new Set(ids.map(String))].filter(id => available.has(id)).slice(0, 4);
}

export function compareViewPickerHTML(state) {
  const view = compareViewOf(state);
  return `<div class="cmp-view-picker" role="group" aria-label="比较视图">${COMPARE_VIEWS.map((item, i) => `<button type="button" data-compare-view="${item.id}" aria-pressed="${view === item.id}" onclick="setCompareView(this.dataset.compareView)"><span aria-hidden="true">0${i + 1}</span><b>${item.label}</b></button>`).join('')}</div><p class="cmp-view-note">${COMPARE_VIEWS.find(item => item.id === view).note}</p>`;
}

export function compareNumber(value) {
  if (value == null || typeof value === 'boolean' || (typeof value === 'string' && !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

// All bars for a metric share a zero-based domain, including the negative side.
export function compareBarScale(row, people) {
  const values = people.map(p => compareNumber(row.rawFor(p.id))).filter(v => v != null);
  const percent = String(row.render(1)).endsWith('%');
  const min = Math.min(0, ...values);
  const fixedMax = compareNumber(row.barMax);
  const max = fixedMax > 0 ? fixedMax : Math.max(percent ? 100 : 0, ...values);
  return { min, max, span: max - min || 1, percent };
}
export function compareBarPosition(value, scale) {
  const number = compareNumber(value);
  const zero = -scale.min / scale.span * 100;
  if (number == null) return { zero, start: zero, width: 0, missing: true };
  const end = Math.max(0, Math.min(100, (number - scale.min) / scale.span * 100));
  return { zero, start: Math.min(zero, end), width: Math.abs(end - zero), missing: false };
}

function preferredRows(rows) {
  const priority = ['round_point_avg', 'avg', 'win_pct', 'win', 'round_total', 'n', 'toulang_pct', 'zhanbian_pct', 'molang_pct', 'mvp_pct', 'mvp_num', 'mvp'];
  const weight = row => {
    const i = priority.indexOf(row.key.split(':').at(-1));
    return i < 0 ? priority.length : i;
  };
  return [...rows].sort((a, b) => weight(a) - weight(b));
}
export function overviewRows(state, rows) {
  const preference = (state.overviewChoices || {})[overviewContext(state)] || {};
  const ordered = preferredRows(rows);
  const primary = rows.find(row => row.key === preference.metric) || ordered[0];
  const support = primary?.overviewSupport?.();
  return {
    primary, rows: primary ? [primary, ...(support?.rows || ordered.filter(row => row !== primary))].slice(0, state.layer === 'deep' ? 8 : 5) : [],
    note: support?.note || '', dir: preference.dir === 1 ? 1 : -1,
  };
}

export function comparePersonCrest(person, state) {
  const row = (state.rows || {})[person.id] || {};
  const head = row.head || {};
  const sects = String(person.sect || '').split(/\s*·\s*/).filter(Boolean);
  const model = row.full || ((head.sect || (head.sect_cands || []).length || (head.teams || []).length) ? head : { ...head, sect_cands: sects });
  return resolveProfileCrest(profileCrestCandidates(model), loadProfileCrestChoice(person.id));
}

function portraitHTML(person, state, crest = false) {
  const image = person.avatar ? `<img class="cmp-overview-photo" src="${esc(person.avatar)}" alt="${esc(person.name)}的照片" decoding="async" onerror="this.hidden=true">` : '';
  const team = crest && comparePersonCrest(person, state);
  return `<div class="cmp-portrait"><span class="cmp-photo-fallback" aria-hidden="true">${esc(Array.from(person.name || '?').slice(0, 2).join(''))}</span>${image}${team ? `<img class="cmp-overview-crest" src="${esc(team.crest)}" alt="${esc(team.name)}队徽">` : ''}</div>`;
}
function nameHTML(person) {
  return `<button type="button" class="cmp-nm" title="${esc(person.name || ('#' + person.id))}" data-player-id="${esc(person.id)}" onclick="openPlayer(this.dataset.playerId)">${esc(person.name || ('#' + person.id))}</button>`;
}
function countHTML(person, state, primary) {
  const data = (state.rows || {})[person.id] || {};
  let value;
  if (state.layer === 'shared') value = (state.sharedGames || []).length;
  else if (state.layer === 'deep') value = ((data.full || {}).roles || []).find(role => role.role === (state.deepMode === 'matrix' ? primary?.key : state.role))?.n;
  else value = kvMap((data.head || {})[state.group === 'custom' ? primary?.key.split(':')[0] : state.group]).round_total;
  return compareNumber(value) == null ? '' : `<small class="cmp-sample">${esc(value)} 场</small>`;
}
function statusHTML(person) {
  if (person.loading) return '<span class="cmp-person-status" role="status">读取中…</span>';
  if (person.err) return '<span class="cmp-person-status error">数据读取失败</span>';
  if (person.warning) return `<span class="cmp-person-status" role="status">${esc(person.warning)}</span>`;
  return '';
}
function valueHTML(row, person) {
  if (person.loading) return '…';
  if (person.err || !row || compareNumber(row.rawFor(person.id)) == null) return '—';
  return esc(row.render(row.rawFor(person.id)));
}
function barHTML(row, person, scale) {
  const point = compareBarPosition(person.loading || person.err ? null : row.rawFor(person.id), scale);
  if (point.missing) return '<div class="cmp-meter missing" aria-hidden="true"></div>';
  return `<div class="cmp-meter" aria-hidden="true"><span class="cmp-meter-zero" style="left:${point.zero}%"></span><i style="left:${point.start}%;width:${point.width}%"></i></div>`;
}
function metricHTML(row, person, scales, winners, bar = true) {
  const best = winners.get(row.key).has(person.id);
  const rate = rateOf(row.rateKey || row.key.split(':').at(-1));
  const source = row.sourceFor?.(person.id);
  return `<div class="cmp-overview-stat${row.cardLabel ? ' has-identity-context' : ''}${best ? ' best' : ''}" data-overview-metric="${esc(row.key)}"${rate ? ` title="${esc(rateDescription(rate.key))}"` : ''}><div><span>${esc(row.cardLabel || row.label)}</span><b>${valueHTML(row, person)}</b></div>${source ? `<small class="identity-source">${esc(source)}</small>` : ''}${best ? '<span class="cmp-sr-only">此项为最优值</span>' : ''}${bar ? barHTML(row, person, scales.get(row.key)) : ''}</div>`;
}
function actionsHTML(person) {
  return `<div class="cmp-overview-actions"><button type="button" data-player-id="${esc(person.id)}" aria-label="隐藏${esc(person.name)}" onclick="toggleCompareFocus(this.dataset.playerId)">隐藏</button><button type="button" data-player-id="${esc(person.id)}" aria-label="将${esc(person.name)}移出对比" onclick="removeFromBasket(this.dataset.playerId)">移出</button></div>`;
}

export function renderCompareOverview(people, allRows, state, winnersFor) {
  const view = compareViewOf(state);
  const selected = overviewRows(state, allRows);
  const primary = selected.primary;
  const focusIDs = focusedCompareIDs(state, people);
  let displayed = view === 'focus' ? people.filter(p => focusIDs.includes(String(p.id))) : people;
  // Sorting uses the same raw values as the detailed table, with invalid values kept last.
  if (primary && view !== 'focus') {
    displayed = sortRows(people.map(p => ({ ...p, overviewValue: p.loading || p.err ? null : compareNumber(primary.rawFor(p.id)) })), 'overviewValue', selected.dir);
  }
  const scales = new Map(selected.rows.map(row => [row.key, compareBarScale(row, people.filter(p => !p.loading && !p.err))]));
  const winners = new Map(selected.rows.map(row => [row.key, winnersFor(row, displayed.filter(p => !p.loading && !p.err && compareNumber(row.rawFor(p.id)) != null))]));
  const metricSelector = primary ? `<label for="cmp-overview-metric">${state.layer === 'deep' && state.deepMode === 'matrix' ? '重点身份' : '重点指标'}<select id="cmp-overview-metric" class="qsel" onchange="setCompareOverviewMetric(this.value)">${allRows.map(row => `<option value="${esc(row.key)}"${row.key === primary.key ? ' selected' : ''}>${esc(row.label)}</option>`).join('')}</select></label>` : '';
  const sortButton = primary && view !== 'focus' ? `<button type="button" class="qf" id="cmp-overview-direction" onclick="toggleCompareOverviewOrder()">${selected.dir < 0 ? '从高到低 ↓' : '从低到高 ↑'}</button>` : '';
  const loading = people.filter(p => p.loading).length;
  const note = loading ? `正在读取 ${loading} 名选手的数据，当前顺序可能变化。` : primary ? '' : '当前范围暂无可比较指标';
  const controls = `<div class="cmp-overview-controls">${metricSelector}${sortButton}${note ? `<span role="status">${esc(note)}</span>` : ''}</div>${selected.note ? `<p class="panel-rate-note">${esc(selected.note)}</p>` : ''}`;
  const roster = view === 'focus' ? `<div class="cmp-focus-roster" role="group" aria-label="选择焦点对照选手">${people.map(p => {
    const active = focusIDs.includes(String(p.id));
    return `<button type="button" class="cmp-focus-person" title="${esc(p.name)}" data-spotlight-id="${esc(p.id)}" aria-pressed="${active}" aria-label="${esc(p.name)}，${active ? '取消' : '加入'}焦点对照"${!active && focusIDs.length >= 4 ? ' disabled' : ''} onclick="toggleCompareSpotlight(this.dataset.spotlightId)">${portraitHTML(p, state)}<span>${esc(p.name)}</span></button>`;
  }).join('')}</div><div class="cmp-focus-heading"><b>焦点对照 ${focusIDs.length} / 4 人</b><span role="status">${focusIDs.length >= 4 ? '先取消一位，再选择其他选手。' : '点击名单中的选手加入焦点对照。'}${state.layer === 'shared' ? '共同对局仍按全部已选选手计算。' : ''}</span></div>` : '';

  const cards = displayed.map(p => `<article class="cmp-overview-person" data-overview-person="${esc(p.id)}">${portraitHTML(p, state, true)}<div class="cmp-overview-content"><div class="cmp-overview-name">${nameHTML(p)}${countHTML(p, state, primary)}</div>${statusHTML(p)}${primary ? `<div class="cmp-overview-primary">${metricHTML(primary, p, scales, winners)}</div>` : ''}<div class="cmp-overview-facts">${selected.rows.slice(1).map(row => metricHTML(row, p, scales, winners, view === 'focus')).join('')}</div>${actionsHTML(p)}</div></article>`).join('');
  const empty = view === 'focus' && !displayed.length ? '<div class="cmp-focus-empty">从上方名单选择选手，最多同时比较 4 人。</div>' : '';
  const count = Math.max(1, displayed.length);
  return controls + roster + `<div class="cmp-overview-grid${view === 'focus' ? ' cmp-spotlight-grid' : ''}" style="--people:${Math.min(view === 'focus' ? 4 : 6, count)};--people-medium:${Math.min(4, count)};--people-narrow:${Math.min(3, count)};--people-small:${Math.min(2, count)}">${cards}${empty}</div>`;
}
