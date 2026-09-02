// 全页面导航与赛事数据：官方排名先显示，派生指标和门派成员再按需读取。
import { eventCatalog, eventSeasons, eventSeasonTypes, eventRankings, eventRankAggregate, eventTeam, prewarmDrawTool } from './api.js';
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
  catalog: null, availableSeasons: null, availableTypes: null, rankings: null, players: [], season: '', type: '3', zone: EVENT_ZONE_DEFAULT,
  loading: false, metricsLoading: false, metricsReady: false, metricsError: '', metricsNote: '', eventTab: 'sects', expandAll: false, error: '', abort: null, gen: 0, page: 1,
  seasonsLoading: false, seasonsError: '', seasonGen: 0,
  typesLoading: false, typesError: '', typeGen: 0, typeAbort: null,
  screen: 'rankings', team: null, teamLoading: false, teamError: '', teamGen: 0, teamAbort: null, teamRequestKey: '', memberSort: { key: 'total_point', dir: -1 },
  rankSort: { key: 'total_point', dir: -1 },
  playerSort: { key: 'total_point', dir: -1 },
};
let personalReturn = null;

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
    optionLabel(c.season_types, state.type, '未选比赛类型'),
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
    S.typesError = e.message || '可用比赛类型暂时无法读取，请稍后重试。';
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
  S.eventTab = 'sects';
  S.players = [];
  S.expandAll = false;
}

export function renderEventTeamHTML(team, state = S) {
  if (!team) return '';
  const sort = state.memberSort || { key: 'total_point', dir: -1 };
  const members = sortRows(team.members || [], sort.key, sort.dir, sort.key === 'label' ? 'str' : 'num');
  const th = (key, label) => sortableTh('setEventMemberSort', key, label, sort);
  const value = v => v == null ? '—' : v;
  const rows = members.map(m => `<tr>
    <td data-label="成员"><button class="event-member-link" data-player="${esc(m.value)}" onclick="showPersonal('events');openPlayer(this.dataset.player)"><b>${esc(m.label)}</b><small>#${esc(m.value)} · 查看个人数据</small></button></td>
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

function eventTabsHTML(state, active) {
  const averageReady = !!(state.metricsReady && state.rankings.metrics_available);
  const playersReady = !!(state.metricsReady && state.rankings.players_available && (state.players || []).length);
  const tab = (key, label, enabled = true) => `<button id="event-tab-${key}" class="detail-tab${active === key ? ' active' : ''}" role="tab" aria-selected="${active === key}" aria-controls="event-panel-${key}"${enabled ? ` onclick="setEventTab('${key}')"` : ' disabled aria-disabled="true"'}>${label}</button>`;
  let status = '';
  if (state.metricsLoading) status = '正在计算参赛数据，完成后即可查看。';
  else if (state.metricsError) status = state.metricsError;
  else if (state.metricsReady && (!averageReady || !playersReady)) status = '当前赛事暂无完整的参赛数据。';
  else if (state.metricsNote) status = state.metricsNote;
  return `<div class="detail-tabs event-tabs" role="tablist" aria-label="赛事数据分类">${tab('sects', '门派排名')}${tab('averages', '门派均分', averageReady)}${tab('players', '选手排名', playersReady)}</div>${status ? `<div class="event-tab-status">${esc(status)}</div>` : ''}`;
}

function eventPagerHTML(total, noun, page, pages, expandAll) {
  if (expandAll) return `<div class="event-pager"><span>已显示全部 ${total} ${noun}</span><button class="ghost" onclick="toggleEventExpand()">收起分页</button></div>`;
  if (pages > 1) return `<div class="event-pager"><button class="ghost" onclick="setEventPage(${page - 1})"${page <= 1 ? ' disabled' : ''}>上一页</button><span>第 ${page} / ${pages} 页 · 共 ${total} ${noun}</span><button class="ghost" onclick="setEventPage(${page + 1})"${page >= pages ? ' disabled' : ''}>下一页</button><button class="ghost event-expand" onclick="toggleEventExpand()">展开全部</button></div>`;
  return `<div class="event-pager single"><span>共 ${total} ${noun}</span></div>`;
}

function rankingHTML(state) {
  if (state.error) return `<div class="err event-error">获取失败：${esc(state.error)}</div>`;
  if (!state.rankings) return `<div class="event-empty"><b>选择赛事范围后查看赛事数据</b><span>请选择赛区、赛季和一种比赛类型。</span></div>`;

  const metricMode = state.rankings.metric_mode || (['2', '3'].includes(String(state.type)) ? 'day' : 'game');
  const countKey = metricMode === 'day' ? 'days' : 'games';
  const countLabel = metricMode === 'day' ? '天数' : '场次';
  const avgLabel = metricMode === 'day' ? '日均分' : '场均分';
  const averageReady = !!(state.metricsReady && state.rankings.metrics_available);
  const playersReady = !!(state.metricsReady && state.rankings.players_available && (state.players || []).length);
  let active = ['sects', 'averages', 'players'].includes(state.eventTab) ? state.eventTab : 'sects';
  if ((active === 'averages' && !averageReady) || (active === 'players' && !playersReady)) active = 'sects';

  const isPlayers = active === 'players';
  const all = isPlayers ? (state.players || []) : (state.rankings.items || []);
  const sort = isPlayers ? (state.playerSort || { key: 'total_point', dir: -1 }) : (state.rankSort || { key: active === 'averages' ? 'avg' : 'total_point', dir: -1 });
  const normalized = all.map(row => row[countKey] && row.avg == null ? { ...row, avg: 0 } : row);
  const sorted = sortRows(normalized, sort.key, sort.dir, ['player_name', 'sect_name'].includes(sort.key) ? 'str' : 'num');
  const pageSize = eventPageSize();
  const pages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const page = Math.min(Math.max(1, state.page || 1), pages);
  const expandAll = !!state.expandAll;
  const start = expandAll ? 0 : (page - 1) * pageSize;
  const visible = sorted.slice(start, expandAll ? sorted.length : start + pageSize);
  const rankTh = (key, label) => sortableTh('setEventRankSort', key, label, sort);
  const playerTh = (key, label) => sortableTh('setEventPlayerSort', key, label, sort);

  let head = '';
  let rows = '';
  let noun = '支门派';
  if (active === 'sects') {
    head = `<th>排名</th><th>门派</th>${rankTh('total_point', '总分')}${rankTh('mvp', 'MVP')}${rankTh('svp', '尽力')}${rankTh('bgx', '背锅')}`;
    rows = visible.map((r, index) => `<tr class="grow" role="button" tabindex="0" aria-label="查看${esc(r.sect_name)}出场成员" onclick="showEventTeam(${r.sect_id})" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();showEventTeam(${r.sect_id})}"><td class="event-rank">${start + index + 1}</td><td><b>${esc(r.sect_name)}</b><small>#${r.sect_id}</small></td><td>${r.total_point}</td><td>${r.mvp || '—'}</td><td>${r.svp || '—'}</td><td>${r.bgx || '—'}</td></tr>`).join('');
  } else if (active === 'averages') {
    head = `<th>排名</th><th>门派</th>${rankTh(countKey, countLabel)}${rankTh('total_point', '总分')}${rankTh('avg', avgLabel)}`;
    rows = visible.map((r, index) => `<tr class="grow" role="button" tabindex="0" aria-label="查看${esc(r.sect_name)}出场成员" onclick="showEventTeam(${r.sect_id})" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();showEventTeam(${r.sect_id})}"><td class="event-rank">${start + index + 1}</td><td><b>${esc(r.sect_name)}</b><small>#${r.sect_id}</small></td><td>${r[countKey] == null ? '—' : r[countKey]}</td><td>${r.total_point}</td><td>${r[countKey] ? (r.avg == null ? 0 : r.avg) : '—'}</td></tr>`).join('');
  } else {
    noun = '名选手';
    head = `<th>排名</th>${playerTh('player_name', '选手')}${playerTh(countKey, countLabel)}${playerTh('total_point', '总分')}${playerTh('avg', avgLabel)}${playerTh('mvp', 'MVP')}${playerTh('svp', '尽力')}${playerTh('bgx', '背锅')}`;
    rows = visible.map((r, index) => `<tr><td class="event-rank">${start + index + 1}</td><td><button class="event-member-link" data-player="${r.player_id}" onclick="showPersonal('events');openPlayer(this.dataset.player)"><b>${esc(r.player_name || ('#' + r.player_id))}</b><small>#${r.player_id} · 查看个人数据</small></button></td><td>${r[countKey] == null ? '—' : r[countKey]}</td><td>${r.total_point}</td><td>${r[countKey] ? (r.avg == null ? 0 : r.avg) : '—'}</td><td>${r.mvp || '—'}</td><td>${r.svp || '—'}</td><td>${r.bgx || '—'}</td></tr>`).join('');
  }

  const action = isPlayers ? '点击选手查看个人数据' : '点击门派查看出场成员';
  const empty = isPlayers ? '当前范围暂无选手数据' : '当前范围暂无门派数据';
  const panel = rows
    ? `<div id="event-panel-${active}" class="event-rank-table${isPlayers ? ' event-player-table' : ''}" role="tabpanel" aria-labelledby="event-tab-${active}"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>${eventPagerHTML(all.length, noun, page, pages, expandAll)}`
    : `<div id="event-panel-${active}" class="event-empty" role="tabpanel" aria-labelledby="event-tab-${active}"><b>${empty}</b><span>可更换赛区、赛季或比赛类型后重试。</span></div>`;
  return `<div class="event-result-head"><div><small>当前范围</small><b>${esc(scopeLabel(state))}</b></div><span>${action}</span></div>
    ${eventTabsHTML(state, active)}
    ${panel}`;
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
    : state.typesError ? `<div class="event-note warn event-type-error"><span>${esc(state.typesError)}</span><button class="ghost" onclick="retryEventTypes()">重新读取比赛类型</button></div>`
      : state.season && Array.isArray(types) && !types.length ? '<div class="event-note warn">当前赛区和赛季没有可查询的比赛类型。</div>' : '';
  const filters = `<div class="event-filters">
    <label><span>赛区</span><select id="event-zone" onchange="syncEventFilters('zone')">${optionsHTML(c.zones, state.zone)}</select></label>
    <label><span>赛季</span><select id="event-season" onchange="syncEventFilters('season')"${state.seasonsLoading ? ' disabled' : ''}>${optionsHTML(seasons, state.season)}</select></label>
    <label><span>比赛类型</span><select id="event-type" onchange="syncEventFilters('type')" required aria-required="true"${state.seasonsLoading || state.typesLoading || !state.season ? ' disabled' : ''}><option value="" disabled${state.type ? '' : ' selected'}>请选择比赛类型</option>${optionsHTML(types, state.type)}</select></label>
    <button onclick="queryEvents()"${state.loading || state.seasonsLoading || state.typesLoading || !state.season || !state.type ? ' disabled' : ''}>${state.loading ? '查询中…' : '查看赛事数据'}</button>
  </div>`;
  const snapshotNote = '<div class="data-snapshot-note">本次运行会复用首次读取的赛事数据，不会自动更新。如需查看官方最新结果，请点首页“退出程序”，看到“程序已退出”后重新打开。</div>';
  return `${filters}${snapshotNote}${seasonStatus}${typeStatus}<section class="event-rankings">${rankingHTML(state)}</section>`;
}

function paint() {
  const el = $('#events-body');
  if (el) el.innerHTML = renderEventsHTML(S);
}

function switchPage(id) {
  for (const page of ['home', 'personal-page', 'events-page', 'tools-page', 'draw-tool-page', 'group-tool-page']) {
    const el = $('#' + page);
    if (el) el.hidden = page !== id;
  }
  window.scrollTo(0, 0);
}

export function showHome() {
  cancelRankingRequest();
  cancelTeamRequest();
  personalReturn = null;
  switchPage('home');
}

export function showPersonal(origin = 'home') {
  const back = $('#personal-back');
  if (origin === 'events') {
    personalReturn = { scrollY: window.scrollY || 0, screen: S.screen };
    if (back) back.textContent = S.screen === 'team' ? '← 返回门派成员' : '← 返回赛事数据';
  } else {
    cancelRankingRequest();
    cancelTeamRequest();
    personalReturn = null;
    if (back) back.textContent = '← 首页';
  }
  switchPage('personal-page');
  const q = $('#q');
  if (q) q.focus();
}

export function closePersonal() {
  if (!personalReturn) { showHome(); return; }
  const restore = personalReturn;
  personalReturn = null;
  switchPage('events-page');
  S.screen = restore.screen;
  paint();
  const scrollBack = () => window.scrollTo(0, restore.scrollY);
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(scrollBack); else scrollBack();
}

export function showTools() {
  cancelRankingRequest();
  cancelTeamRequest();
  switchPage('tools-page');
  prewarmDrawTool().catch(() => {});
}

export async function showEvents() {
  cancelTeamRequest();
  switchPage('events-page');
  S.screen = 'rankings'; S.error = '';
  paint();
  if (S.catalog) {
    if (S.typesError && S.season) await retryEventTypes();
    return;
  }
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

export function retryEventTypes() {
  if (!S.catalog || !S.season || S.seasonsLoading || S.typesLoading) return;
  return refreshEventTypes();
}

// 筛选变化只读取可用范围；排名和派生指标仍在用户点击查询后读取。
export function syncEventFilters(kind) {
  const seasonEl = $('#event-season'), typeEl = $('#event-type'), zoneEl = $('#event-zone');
  cancelRankingRequest();
  if (seasonEl) S.season = seasonEl.value;
  if (typeEl) S.type = typeEl.value;
  if (zoneEl) S.zone = zoneEl.value || EVENT_ZONE_DEFAULT;
  S.rankings = null; S.players = []; S.metricsLoading = false; S.eventTab = 'sects'; S.page = 1; S.error = '';
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
  if (!season || !season.value || !type || !type.value || S.seasonsLoading || S.typesLoading) return;
  S.season = season.value; S.type = type.value; S.zone = zone ? zone.value : EVENT_ZONE_DEFAULT;
  cancelRankingRequest();
  S.abort = new AbortController();
  const gen = ++S.gen;
  S.loading = true; S.metricsLoading = false; S.error = ''; S.rankings = null; S.players = []; S.eventTab = 'sects'; S.page = 1; S.screen = 'rankings'; paint();
  try {
    const data = await eventRankings(S.season, S.type, S.zone, S.abort.signal);
    if (gen !== S.gen) return;
    S.rankings = data;
    const metricKey = data.metric_mode === 'day' ? 'days' : 'games';
    if (S.rankSort.key === 'days' || S.rankSort.key === 'games') S.rankSort.key = metricKey;
    S.metricsLoading = true;
  } catch (e) {
    if (gen !== S.gen || e.name === 'AbortError') return;
    S.error = e.message || '门派排名暂时不可用';
  } finally {
    if (gen === S.gen) { S.loading = false; paint(); }
  }
  if (gen !== S.gen || !S.rankings || !S.type) return;
  // 门派均分与选手排名共用同一份选手汇总；计算完成前两个 Tab 保持禁用。
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
    S.rankings.players_available = !!metrics.players_available;
    S.players = metrics.players || [];
    S.metricsReady = true;
    S.metricsNote = metrics.metrics_incomplete ? '部分门派的参赛数据暂时无法确认，其余门派正常显示。' : '';
  } catch (e) {
    if (gen !== S.gen || e.name === 'AbortError') return;
    S.metricsError = '参赛数据未能完成，请重新查询；门派排名仍可正常查看。';
  } finally {
    if (gen === S.gen) { S.metricsLoading = false; paint(); }
  }
}

export function setEventPage(page) {
  const items = S.eventTab === 'players' ? S.players : ((S.rankings && S.rankings.items) || []);
  const total = Math.max(1, Math.ceil((items || []).length / eventPageSize()));
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

export function setEventTab(tab) {
  if (!new Set(['sects', 'averages', 'players']).has(tab)) return;
  if (tab === 'averages' && (!S.metricsReady || !(S.rankings && S.rankings.metrics_available))) return;
  if (tab === 'players' && (!S.metricsReady || !(S.rankings && S.rankings.players_available) || !S.players.length)) return;
  S.eventTab = tab;
  S.rankSort = { key: tab === 'averages' ? 'avg' : 'total_point', dir: -1 };
  S.playerSort = { key: 'total_point', dir: -1 };
  S.page = 1;
  S.expandAll = false;
  paint();
  window.scrollTo(0, 0);
}

export function setEventPlayerSort(key) {
  const allowed = new Set(['player_name', 'days', 'games', 'total_point', 'avg', 'mvp', 'svp', 'bgx']);
  if (!allowed.has(key)) return;
  const sort = S.playerSort || { key: 'total_point', dir: -1 };
  S.playerSort = sort.key === key ? { key, dir: sort.dir * -1 } : { key, dir: key === 'player_name' ? 1 : -1 };
  S.page = 1;
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
