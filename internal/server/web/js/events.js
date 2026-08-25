// 全页面导航与赛事数据：官方排名先显示，派生指标和门派成员再按需读取。
import { eventCatalog, eventSeasons, eventSeasonTypes, eventRankings, eventRankAggregate, eventTeam } from './api.js';
import { esc, sortableTh, sortRows } from './format.js';
import { EVENT_ZONE_DEFAULT } from './zone.js';

const $ = s => document.querySelector(s);
const eventPageSize = () => {
  if (typeof window === 'undefined') return 15;
  if (window.innerWidth <= 760) return 6;
  return Math.max(8, Math.min(15, Math.floor((window.innerHeight - 420) / 35)));
};
const teamRequests = new Map();
const seasonRequests = new Map();
let S = {
  catalog: null, availableSeasons: null, availableTypes: null, rankings: null, season: '', type: '3', zone: EVENT_ZONE_DEFAULT,
  loading: false, metricsLoading: false, metricsReady: false, metricsError: '', metricsNote: '', metricsBlocked: '', showMetrics: false, expandAll: false, error: '', abort: null, gen: 0, page: 1,
  seasonsLoading: false, seasonsError: '', seasonGen: 0,
  typesLoading: false, typesError: '', typeGen: 0, typeAbort: null,
  screen: 'rankings', team: null, teamLoading: false, teamError: '', teamGen: 0, teamAbort: null, teamRequestKey: '', memberSort: { key: 'total_point', dir: -1 },
  rankSort: { key: 'total_point', dir: -1 },
};

const optionsHTML = (items, selected) => (items || []).map(o =>
  `<option value="${esc(o.value)}"${String(o.value) === String(selected) ? ' selected' : ''}>${esc(o.label)}</option>`
).join('');

function defaultSeason(items) {
  const regular = (items || []).filter(o => /^S\d+$/.test(o.label || '') && +o.value > 0 && +o.value < 1000);
  regular.sort((a, b) => +b.value - +a.value);
  return regular.length ? String(regular[0].value) : String((items && items[0] && items[0].value) || '');
}

function optionLabel(items, value, fallback) {
  return ((items || []).find(o => String(o.value) === String(value)) || {}).label || fallback;
}

function scopeLabel(state) {
  const c = state.catalog || {};
  return [
    optionLabel(c.zones, state.zone, '上海赛区'),
    optionLabel(c.seasons, state.season, '未选赛季'),
    optionLabel(c.season_types, state.type, '全部比赛类型'),
  ].join(' · ');
}

function loadZoneSeasons(zone) {
  let request = seasonRequests.get(zone);
  if (!request) {
    request = eventSeasons(zone).catch(error => {
      seasonRequests.delete(zone);
      throw error;
    });
    seasonRequests.set(zone, request);
  }
  return request;
}

async function refreshEventTypes() {
  const season = S.season;
  const zone = S.zone || EVENT_ZONE_DEFAULT;
  if (S.typeAbort) S.typeAbort.abort();
  const controller = new AbortController();
  S.typeAbort = controller;
  const gen = ++S.typeGen;
  S.typesError = '';
  S.availableTypes = null;
  if (!season) {
    S.typeAbort = null;
    S.type = '';
    S.typesLoading = false;
    S.availableTypes = [];
    paint();
    return;
  }
  S.typesLoading = true;
  paint();
  try {
    const data = await eventSeasonTypes(season, zone, controller.signal);
    if (gen !== S.typeGen || season !== S.season || zone !== S.zone) return;
    S.availableTypes = data.season_types || [];
    if (!S.availableTypes.some(option => String(option.value) === String(S.type))) S.type = '';
  } catch (e) {
    if (gen !== S.typeGen || season !== S.season || zone !== S.zone) return;
    S.availableTypes = [];
    S.type = '';
    S.typesError = e.message || '可用比赛类型暂时无法读取，可选择全部比赛类型继续查询。';
  } finally {
    if (gen === S.typeGen && season === S.season && zone === S.zone) {
      S.typeAbort = null;
      S.typesLoading = false;
      paint();
    }
  }
}

async function refreshZoneSeasons() {
  const zone = S.zone || EVENT_ZONE_DEFAULT;
  const gen = ++S.seasonGen;
  if (S.typeAbort) S.typeAbort.abort();
  S.typeAbort = null;
  ++S.typeGen;
  S.seasonsLoading = true; S.seasonsError = ''; S.availableSeasons = null;
  S.typesLoading = false; S.typesError = ''; S.availableTypes = null;
  paint();
  try {
    const data = await loadZoneSeasons(zone);
    if (gen !== S.seasonGen || zone !== S.zone) return;
    S.availableSeasons = data.seasons || [];
    if (!S.availableSeasons.some(option => String(option.value) === String(S.season))) {
      S.season = defaultSeason(S.availableSeasons);
    }
    S.seasonsLoading = false;
    paint();
    await refreshEventTypes();
  } catch (e) {
    if (gen !== S.seasonGen || zone !== S.zone) return;
    S.availableSeasons = [];
    S.season = '';
    S.availableTypes = [];
    S.type = '';
    S.typesLoading = false;
    S.seasonsError = e.message || '可用赛季暂时无法读取';
  } finally {
    if (gen === S.seasonGen && zone === S.zone) { S.seasonsLoading = false; paint(); }
  }
}

function teamKey(id) {
  return [id, S.season, S.type, S.zone].join('|');
}

function loadEventTeam(id, signal) {
  const key = teamKey(id);
  let request = teamRequests.get(key);
  if (!request) {
    request = eventTeam(id, S.season, S.type, S.zone, signal).catch(error => {
      if (teamRequests.get(key) === request) teamRequests.delete(key);
      throw error;
    });
    teamRequests.set(key, request);
  }
  return request;
}

function cancelTeamRequest() {
  S.teamGen++;
  if (S.teamAbort) S.teamAbort.abort();
  if (S.teamRequestKey) teamRequests.delete(S.teamRequestKey);
  S.teamAbort = null;
  S.teamRequestKey = '';
}

function cancelRankingRequest() {
  S.gen++;
  if (S.abort) S.abort.abort();
  S.abort = null;
  S.loading = false;
  // 清空派生指标的全部状态，避免旧赛区的天数/均分或“计算中”提示串到新范围（切赛区/赛季、离开页面都会经过这里）。
  S.metricsLoading = false;
  S.metricsReady = false;
  S.metricsError = '';
  S.metricsNote = '';
  S.metricsBlocked = '';
  S.showMetrics = false;
  S.expandAll = false;
}

export function renderEventTeamHTML(team, state = S) {
  if (!team) return '';
  const sort = state.memberSort || { key: 'total_point', dir: -1 };
  const members = sortRows(team.members || [], sort.key, sort.dir, sort.key === 'label' ? 'str' : 'num');
  const th = (key, label) => sortableTh('setEventMemberSort', key, label, sort);
  const value = v => v == null ? '—' : v;
  const rows = members.map(m => `<tr>
    <td data-label="成员"><button class="event-member-link" data-player="${esc(m.value)}" onclick="showPersonal();openPlayer(this.dataset.player)"><b>${esc(m.label)}</b><small>#${esc(m.value)} · 查看个人数据</small></button></td>
    <td data-label="场次">${m.matches == null ? '—' : m.matches + ' 场'}</td><td data-label="总分">${value(m.total_point)}</td><td data-label="场均分">${value(m.avg)}</td><td data-label="胜率">${m.win == null ? '—' : m.win + '%'}</td>
    <td data-label="MVP">${m.mvp || '—'}</td><td data-label="尽力">${m.svp || '—'}</td><td data-label="背锅">${m.bgx || '—'}</td>
  </tr>`).join('');
  const memberTable = rows ? `<div class="event-member-table"><table><thead><tr>${th('label', '成员')}${th('matches', '场次')}${th('total_point', '总分')}${th('avg', '场均分')}${th('win', '胜率')}${th('mvp', 'MVP')}${th('svp', '尽力')}${th('bgx', '背锅')}</tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="event-empty compact"><b>该范围暂无出场成员</b><span>仅显示在当前赛事中有出场记录的成员。</span></div>';
  const warning = team.incomplete ? '<div class="event-note warn">部分成员的战绩读取失败，当前名单可能不完整。</div>' : '';
  return `<div class="event-team-page">
    <button class="page-back event-rank-back" onclick="closeEventTeam()">← 返回门派排名</button>
    <div class="event-team-title"><div><small>${esc(scopeLabel(state))}</small><h2>${esc(team.name || ('#' + team.id))}</h2></div><span>${(team.members || []).length} 名出场成员</span></div>
    <div class="event-team-meta">${team.chief ? `<span>掌门 <b>${esc(team.chief)}</b></span>` : ''}<span>门派编号 #${team.id}</span></div>
    ${warning}
    ${memberTable}
    <div class="event-note">成员数据按当前赛事范围统计。点击列名可排序，点击成员可查看个人数据。</div>
  </div>`;
}

// 天数/日均分默认不显示：先秒出总分排名，派生指标随后算出，算好后由“查看”按钮展开（见 eventMetricControlHTML）。
function rankingHTML(state) {
  if (state.error) return `<div class="err event-error">获取失败：${esc(state.error)}</div>`;
  if (!state.rankings) {
    return `<div class="event-empty"><b>选择赛事范围后查看门派排名</b><span>请选择赛区、赛季和比赛类型。</span></div>`;
  }

  const metricMode = state.rankings.metric_mode || (['2', '3'].includes(String(state.type)) ? 'day' : 'game');
  const countKey = metricMode === 'day' ? 'days' : 'games';
  const countLabel = metricMode === 'day' ? '天数' : '场次';
  const avgLabel = metricMode === 'day' ? '日均分' : '场均分';
  const metricLabel = `${countLabel}与${avgLabel}`;
  const showMetrics = !!(state.showMetrics && state.metricsReady && state.rankings.metrics_available);
  const all = (state.rankings.items || []).map(r => r[countKey] && r.avg == null ? { ...r, avg: 0 } : r);
  const sort = state.rankSort || { key: 'total_point', dir: -1 };
  const sorted = sortRows(all, sort.key, sort.dir);
  const pageSize = eventPageSize();
  const pages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const page = Math.min(Math.max(1, state.page || 1), pages);
  const expandAll = !!state.expandAll;
  const start = expandAll ? 0 : (page - 1) * pageSize;
  const end = expandAll ? sorted.length : start + pageSize;
  const rows = sorted.slice(start, end).map((r, index) => `<tr class="grow" tabindex="0"
    onclick="showEventTeam(${r.sect_id})" onkeydown="if(event.key==='Enter')showEventTeam(${r.sect_id})">
    <td class="event-rank">${start + index + 1}</td><td><b>${esc(r.sect_name)}</b><small>#${r.sect_id}</small></td>
    <td>${r.total_point}</td>${showMetrics ? `<td>${r[countKey] == null ? '—' : r[countKey]}</td><td>${r[countKey] ? (r.avg == null ? 0 : r.avg) : '—'}</td>` : ''}<td>${r.mvp || '—'}</td><td>${r.svp || '—'}</td><td>${r.bgx || '—'}</td></tr>`).join('');
  // 分页条：默认分页，附“展开全部”切到不分页；展开后改为“收起分页”。门派本就一次性全量拉回，展开只是显示更多行、不多发请求。
  let pager;
  if (expandAll) {
    pager = `<div class="event-pager"><span>已显示全部 ${all.length} 支门派</span><button class="ghost" onclick="toggleEventExpand()">收起分页</button></div>`;
  } else if (pages > 1) {
    pager = `<div class="event-pager"><button class="ghost" onclick="setEventPage(${page - 1})"${page <= 1 ? ' disabled' : ''}>上一页</button><span>第 ${page} / ${pages} 页 · 共 ${all.length} 支门派</span><button class="ghost" onclick="setEventPage(${page + 1})"${page >= pages ? ' disabled' : ''}>下一页</button><button class="ghost event-expand" onclick="toggleEventExpand()">展开全部</button></div>`;
  } else {
    pager = `<div class="event-pager single"><span>共 ${all.length} 支门派</span></div>`;
  }
  const th = (key, label) => sortableTh('setEventRankSort', key, label, sort);
  const control = eventMetricControlHTML(state, metricLabel);
  return `<div class="event-result-head"><div><small>当前范围</small><b>${esc(scopeLabel(state))}</b></div><span>点击门派查看出场成员</span></div>
    ${control}
    ${rows ? `<div class="event-rank-table"><table><thead><tr><th>排名</th><th>门派</th>${th('total_point', '总分')}${showMetrics ? `${th(countKey, countLabel)}${th('avg', avgLabel)}` : ''}${th('mvp', 'MVP')}${th('svp', '尽力')}${th('bgx', '背锅')}</tr></thead><tbody>${rows}</tbody></table></div>${pager}` : '<div class="event-empty"><b>当前范围暂无门派数据</b><span>可更换赛区、赛季或比赛类型后重试。</span></div>'}`;
}

// eventMetricControlHTML 渲染“查看天数与日均分”按钮及其旁的面向用户提示。
// 计算中：按钮不可点 + “正在为你计算…”；算好且有数据：可点，展开/收起两列；无数据或失败：按钮不可点并说明原因。
function eventMetricControlHTML(state, label) {
  const r = state.rankings;
  if (!r || !(r.items || []).length) return '';
  const bar = inner => `<div class="event-metric-bar">${inner}</div>`;
  const btn = (disabled, text) => `<button class="ghost"${disabled ? ' disabled' : ' onclick="toggleEventMetrics()"'}>${text}</button>`;
  const hint = t => t ? `<span class="event-metric-hint">${esc(t)}</span>` : '';
  // 全部比赛类型：不同赛制无统一口径，不提供派生指标，只提示选择具体类型。
  if (state.metricsBlocked) return bar(hint(state.metricsBlocked));
  if (state.metricsLoading) return bar(btn(true, `查看${label}`) + hint(`正在为你计算${label}，请稍候…`));
  if (state.metricsError) return bar(btn(true, `查看${label}`) + hint(state.metricsError));
  if (state.metricsReady) {
    if (!r.metrics_available) return bar(btn(true, `查看${label}`) + hint('当前赛事暂无可统计的参赛数据。'));
    return bar(btn(false, `${state.showMetrics ? '收起' : '查看'}${label}`) + hint(state.showMetrics ? (state.metricsNote || '') : (state.metricsNote || `点击查看每支门派的${label}。`)));
  }
  return bar(btn(true, `查看${label}`));
}

export function renderEventsHTML(state) {
  if (state.screen === 'team') {
    if (state.teamLoading) return `<div class="event-team-page"><button class="page-back event-rank-back" onclick="closeEventTeam()">← 返回门派排名</button><div class="event-loading"><span class="loading-pulse"></span><div><b>正在获取出场成员</b><span>请稍候，名单将在获取完成后显示。</span></div></div></div>`;
    if (state.teamError) return `<div class="event-team-page"><button class="page-back event-rank-back" onclick="closeEventTeam()">← 返回门派排名</button><div class="err event-error">成员名单获取失败：${esc(state.teamError)}</div></div>`;
    return renderEventTeamHTML(state.team, state);
  }

  const c = state.catalog;
  if (!c) return '<div class="event-loading"><span class="loading-pulse"></span><div><b>正在获取赛事资料</b><span>请稍候。</span></div></div>';
  const seasons = state.availableSeasons == null ? c.seasons : state.availableSeasons;
  const types = state.availableTypes == null ? c.season_types : state.availableTypes;
  const seasonStatus = state.seasonsLoading
    ? `<div class="event-note event-ranking-note">正在读取${esc(optionLabel(c.zones, state.zone, '当前赛区'))}的可用赛季…</div>`
    : state.seasonsError ? `<div class="err event-error">${esc(state.seasonsError)}</div>` : '';
  const typeStatus = state.typesLoading && !state.seasonsLoading
    ? '<div class="event-note event-ranking-note">正在读取当前赛区和赛季的可用比赛类型…</div>'
    : state.typesError ? `<div class="err event-error">${esc(state.typesError)}</div>` : '';
  const filters = `<div class="event-filters">
    <label><span>赛区</span><select id="event-zone" onchange="syncEventFilters('zone')">${optionsHTML(c.zones, state.zone)}</select></label>
    <label><span>赛季</span><select id="event-season" onchange="syncEventFilters('season')"${state.seasonsLoading ? ' disabled' : ''}>${optionsHTML(seasons, state.season)}</select></label>
    <label><span>比赛类型</span><select id="event-type" onchange="syncEventFilters('type')"${state.seasonsLoading || state.typesLoading || !state.season ? ' disabled' : ''}><option value="">全部比赛类型</option>${optionsHTML(types, state.type)}</select></label>
    <button onclick="queryEvents()"${state.loading || state.seasonsLoading || state.typesLoading || !state.season ? ' disabled' : ''}>${state.loading ? '查询中…' : '查看门派排名'}</button>
  </div>`;
  return `${filters}${seasonStatus}${typeStatus}<section class="event-rankings">${rankingHTML(state)}</section>`;
}

function paint() {
  const el = $('#events-body');
  if (el) el.innerHTML = renderEventsHTML(S);
}

function switchPage(id) {
  for (const page of ['home', 'personal-page', 'events-page', 'tools-page']) {
    const el = $('#' + page);
    if (el) el.hidden = page !== id;
  }
  window.scrollTo(0, 0);
}

export function showHome() {
  cancelRankingRequest();
  cancelTeamRequest();
  switchPage('home');
}

export function showPersonal() {
  cancelRankingRequest();
  cancelTeamRequest();
  switchPage('personal-page');
  const q = $('#q');
  if (q) q.focus();
}

export function showTools() {
  cancelRankingRequest();
  cancelTeamRequest();
  switchPage('tools-page');
}

export async function showEvents() {
  cancelTeamRequest();
  switchPage('events-page');
  S.screen = 'rankings'; S.error = '';
  paint();
  if (S.catalog) return;
  const gen = ++S.gen;
  try {
    const catalog = await eventCatalog();
    if (gen !== S.gen) return;
    S.catalog = catalog;
    if (!(catalog.zones || []).some(option => option.value === S.zone)) S.zone = EVENT_ZONE_DEFAULT;
    S.season = defaultSeason(catalog.seasons);
    if (!(catalog.season_types || []).some(o => String(o.value) === S.type)) S.type = '';
    paint();
    await refreshZoneSeasons();
  } catch (e) {
    if (gen !== S.gen) return;
    S.error = e.message || '赛事资料暂时不可用';
    S.catalog = { seasons: [], season_types: [], zones: [{ value: EVENT_ZONE_DEFAULT, label: '上海赛区' }], editions: [], roles: [] };
    S.availableTypes = [];
    paint();
  }
}

// 筛选变化只读取可用范围；排名和派生指标仍在用户点击查询后读取。
export function syncEventFilters(kind) {
  const seasonEl = $('#event-season'), typeEl = $('#event-type'), zoneEl = $('#event-zone');
  cancelRankingRequest();
  if (seasonEl) S.season = seasonEl.value;
  if (typeEl) S.type = typeEl.value;
  if (zoneEl) S.zone = zoneEl.value || EVENT_ZONE_DEFAULT;
  S.rankings = null; S.metricsLoading = false; S.page = 1; S.error = '';
  paint();
  if (kind === 'zone') return refreshZoneSeasons();
  if (kind === 'season') return refreshEventTypes();
}

export function closeEvents() {
  const page = $('#events-page');
  if (!page || page.hidden) return;
  if (S.screen === 'team') closeEventTeam(); else showHome();
}

export async function queryEvents() {
  const season = $('#event-season'), type = $('#event-type'), zone = $('#event-zone');
  if (!season || !season.value || S.seasonsLoading || S.typesLoading) return;
  S.season = season.value; S.type = type ? type.value : ''; S.zone = zone ? zone.value : EVENT_ZONE_DEFAULT;
  cancelRankingRequest();
  S.abort = new AbortController();
  const gen = ++S.gen;
  S.loading = true; S.metricsLoading = false; S.error = ''; S.rankings = null; S.page = 1; S.screen = 'rankings'; paint();
  try {
    const data = await eventRankings(S.season, S.type, S.zone, S.abort.signal);
    if (gen !== S.gen) return;
    S.rankings = data;
    const metricKey = data.metric_mode === 'day' ? 'days' : 'games';
    if (S.rankSort.key === 'days' || S.rankSort.key === 'games') S.rankSort.key = metricKey;
    // 全部比赛类型混合了不同赛制、没有统一的天数/场次口径，不计算派生指标，只提示选择具体类型。
    if (S.type) S.metricsLoading = true;
    else S.metricsBlocked = '选择具体比赛类型后可查看参赛量与均分。';
  } catch (e) {
    if (gen !== S.gen || e.name === 'AbortError') return;
    S.error = e.message || '门派排名暂时不可用';
  } finally {
    if (gen === S.gen) { S.loading = false; paint(); }
  }
  if (gen !== S.gen || !S.rankings || !S.type) return;
  // 参赛量与均分由 Go 统一聚合（含"3 局=1 天"换算与门派归属），页面只按 sect_id 关联展示。
  // 后台计算期间“查看天数与日均分”按钮不可点，算好后才可点开（见 eventMetricControlHTML）。
  try {
    const metrics = await eventRankAggregate(S.season, S.type, S.zone, S.abort.signal);
    if (gen !== S.gen) return;
    const key = (metrics.metric_mode || S.rankings.metric_mode) === 'day' ? 'days' : 'games';
    const byId = new Map((metrics.items || []).map(m => [m.sect_id, m]));
    S.rankings.items = (S.rankings.items || []).map(item => {
      const m = byId.get(item.sect_id);
      return m ? { ...item, [key]: m[key], avg: m.avg } : item;
    });
    S.rankings.metrics_available = !!metrics.metrics_available;
    S.metricsReady = true;
    S.metricsNote = metrics.metrics_incomplete ? '部分门派的参赛数据暂时无法确认，其余门派正常显示。' : '';
  } catch (e) {
    if (gen !== S.gen || e.name === 'AbortError') return;
    const label = S.rankings.metric_mode === 'day' ? '天数与日均分' : '场次与场均分';
    S.metricsError = `${label}暂时无法显示，门派总分不受影响。`;
  } finally {
    if (gen === S.gen) { S.metricsLoading = false; paint(); }
  }
}

export function setEventPage(page) {
  const total = Math.max(1, Math.ceil(((S.rankings && S.rankings.items) || []).length / eventPageSize()));
  S.page = Math.min(Math.max(1, Number(page) || 1), total);
  paint();
  window.scrollTo(0, 0);
}

// toggleEventExpand 在“分页”与“一次看全部门派”之间切换；门派数据本就全量在手，展开只是显示更多行、不发请求。收起时回到第 1 页。
export function toggleEventExpand() {
  S.expandAll = !S.expandAll;
  if (!S.expandAll) S.page = 1;
  paint();
  window.scrollTo(0, 0);
}

export function setEventRankSort(key) {
  if (!new Set(['total_point', 'days', 'games', 'avg', 'mvp', 'svp', 'bgx']).has(key)) return;
  const sort = S.rankSort || { key: 'total_point', dir: -1 };
  S.rankSort = sort.key === key ? { key, dir: sort.dir * -1 } : { key, dir: -1 };
  S.page = 1;
  paint();
}

// toggleEventMetrics 展开/收起天数与日均分两列；仅在已算好且有数据时可用（按钮此时才可点）。
// 收起时若正按天数/均分排序，回退到按总分排序，避免列消失后停留在无对应列的排序上。
export function toggleEventMetrics() {
  if (!S.metricsReady || !(S.rankings && S.rankings.metrics_available)) return;
  S.showMetrics = !S.showMetrics;
  if (!S.showMetrics && ['days', 'games', 'avg'].includes(S.rankSort.key)) {
    S.rankSort = { key: 'total_point', dir: -1 };
    S.page = 1;
  }
  paint();
}

export function setEventMemberSort(key) {
  const allowed = new Set(['label', 'matches', 'total_point', 'avg', 'win', 'mvp', 'svp', 'bgx']);
  if (!allowed.has(key)) return;
  const sort = S.memberSort || { key: 'total_point', dir: -1 };
  S.memberSort = sort.key === key ? { key, dir: sort.dir * -1 } : { key, dir: key === 'label' ? 1 : -1 };
  paint();
}

export async function showEventTeam(id) {
  cancelTeamRequest();
  const gen = S.teamGen;
  const controller = new AbortController();
  S.teamAbort = controller;
  S.teamRequestKey = teamKey(id);
  S.screen = 'team'; S.team = null; S.teamLoading = true; S.teamError = ''; paint();
  window.scrollTo(0, 0);
  try {
    const team = await loadEventTeam(id, controller.signal);
    if (gen !== S.teamGen || S.screen !== 'team') return;
    S.team = team;
  } catch (e) {
    if (gen !== S.teamGen || S.screen !== 'team' || e.name === 'AbortError') return;
    S.teamError = e.message || '成员名单暂时不可用';
  } finally {
    if (gen === S.teamGen && S.screen === 'team') {
      S.teamAbort = null;
      S.teamRequestKey = '';
      S.teamLoading = false;
      paint();
    }
  }
}

export function closeEventTeam() {
  cancelTeamRequest();
  S.screen = 'rankings'; S.team = null; S.teamLoading = false; S.teamError = ''; paint();
  window.scrollTo(0, 0);
}

export function __setEventsState(v) { S = { ...S, ...v }; }
