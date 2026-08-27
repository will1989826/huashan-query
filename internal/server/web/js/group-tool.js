// 分组模拟器：按后端种子排名逐队抽取，本地随机分配到仍有名额的 A/B/C/D 组。
import { eventCatalog, eventSeasons, eventSeasonTypes, groupDrawTool } from './api.js';
import { esc } from './format.js';
import { EVENT_ZONE_DEFAULT } from './zone.js';

const $ = selector => document.querySelector(selector);
const GROUP_NAMES = ['A', 'B', 'C', 'D'];

let G = {
  catalog: null, seasons: [], types: [], season: '', type: '3', zone: EVENT_ZONE_DEFAULT,
  data: null, assignments: [], lastSectID: 0,
  loading: false, optionsLoading: false, error: '', abort: null, gen: 0,
};

function defaultSeason(items) {
  const seasons = [...(items || [])].filter(item => /^S\d+$/.test(String(item.label || '')) && Number(item.value) > 0 && Number(item.value) < 1000);
  seasons.sort((a, b) => Number(b.value) - Number(a.value));
  return String(seasons[0]?.value || '');
}

function options(items, selected) {
  return (items || []).map(item => `<option value="${esc(item.value)}"${String(item.value) === String(selected) ? ' selected' : ''}>${esc(item.label)}</option>`).join('');
}

export function usableGroupTypes(response) {
  return (response?.season_types || []).filter(item => ['2', '3'].includes(String(item.value)));
}

function preferredGroupType(types) {
  return String(types.find(item => String(item.value) === '3')?.value || types[0]?.value || '');
}

function score(value) {
  const number = Number(value || 0);
  return String(Math.round((number + Number.EPSILON) * 100) / 100);
}

export function groupCapacities(teamCount) {
  const base = Math.floor(Math.max(0, Number(teamCount) || 0) / GROUP_NAMES.length);
  const remainder = Math.max(0, Number(teamCount) || 0) % GROUP_NAMES.length;
  return GROUP_NAMES.map((_, index) => base + (index < remainder ? 1 : 0));
}

export function drawNextAssignment(teams, assignments, random = Math.random) {
  const list = teams || [];
  const drawn = assignments || [];
  if (drawn.length >= list.length) return null;
  const capacities = groupCapacities(list.length);
  const counts = GROUP_NAMES.map(group => drawn.filter(item => item.group === group).length);
  const available = GROUP_NAMES.map((group, index) => ({ group, index })).filter(item => counts[item.index] < capacities[item.index]);
  if (!available.length) return null;
  const value = Number(random());
  const pick = Math.min(available.length - 1, Math.max(0, Math.floor((Number.isFinite(value) ? value : 0) * available.length)));
  const team = list[drawn.length];
  return { sect_id: team.sect_id, group: available[pick].group };
}

function teamByID(data) {
  return new Map((data?.teams || []).map(team => [team.sect_id, team]));
}

function filtersHTML() {
  const zones = G.catalog?.zones || [{ value: EVENT_ZONE_DEFAULT, label: '上海赛区' }];
  return `<div class="group-filters">
    <label><span>赛区</span><select id="group-zone" onchange="syncGroupFilters('zone')">${options(zones, G.zone)}</select></label>
    <label><span>赛季</span><select id="group-season" onchange="syncGroupFilters('season')"${G.optionsLoading || !G.seasons.length ? ' disabled' : ''}>${options(G.seasons, G.season)}</select></label>
    <label><span>比赛类型</span><select id="group-type" onchange="syncGroupFilters('type')"${G.optionsLoading || !G.types.length ? ' disabled' : ''}>${options(G.types, G.type)}</select></label>
    <button onclick="queryGroupTool()"${G.loading || G.optionsLoading || !G.season || !G.type ? ' disabled' : ''}>${G.loading ? '整理排名中…' : G.optionsLoading ? '加载赛事…' : '读取分组排名'}</button>
  </div>`;
}

function seedTableHTML(data, assignmentByTeam, state) {
  const rows = (data.teams || []).map(team => {
    const assigned = assignmentByTeam.get(team.sect_id);
    const next = !assigned && state.assignments.length === team.rank - 1;
    return `<tr class="${assigned ? 'assigned' : next ? 'next' : ''}">
      <td><b>${team.rank}</b></td><td><strong>${esc(team.sect_name)}</strong></td><td>${score(team.total_point)}</td>
      <td>${team.mvp || '—'}</td><td>${team.svp || '—'}</td><td>${team.bgx || '—'}</td>
      <td><span class="group-seed-status${assigned ? ' done' : ''}">${assigned ? assigned.group + ' 组' : next ? '下一队' : '待抽取'}</span></td>
    </tr>`;
  }).join('');
  return `<section class="group-seeds"><div class="group-section-head"><div><small>SEED ORDER</small><h3>抽签顺序</h3></div><span>总分 → MVP → 尽力 → 少背锅 → 门派编号</span></div><div class="group-seed-table"><table><thead><tr><th>排名</th><th>门派</th><th>总分</th><th>MVP</th><th>尽力</th><th>背锅</th><th>状态</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

function groupCardsHTML(data, state) {
  const byID = teamByID(data);
  const capacities = groupCapacities((data.teams || []).length);
  return `<div class="group-board" aria-live="polite">${GROUP_NAMES.map((name, index) => {
    const members = state.assignments.filter(item => item.group === name).map(item => byID.get(item.sect_id)).filter(Boolean);
    const rows = members.map((team, memberIndex) => `<li class="${team.sect_id === state.lastSectID ? 'just-drawn' : ''}"><span>${memberIndex + 1}</span><div><b>${esc(team.sect_name)}</b><small>总排名 ${team.rank} · ${score(team.total_point)} 分</small></div></li>`).join('');
    return `<section class="group-card group-${name.toLowerCase()}"><header><span>${name}</span><div><small>GROUP</small><h3>${name} 组</h3></div><b>${members.length} / ${capacities[index]}</b></header><ol>${rows || '<li class="group-placeholder">等待抽取门派</li>'}</ol></section>`;
  }).join('')}</div>`;
}

export function renderGroupToolHTML(state = G) {
  if (!state.data) return '';
  const assignments = new Map((state.assignments || []).map(item => [item.sect_id, item]));
  const complete = state.assignments.length >= (state.data.teams || []).length;
  const next = state.data.teams[state.assignments.length];
  return `<div class="group-summary"><div><small>${complete ? 'DRAW COMPLETE' : 'NEXT SEED'}</small><b>${complete ? '四组分组已完成' : `下一队：${esc(next?.sect_name || '—')}`}</b><span>${complete ? `共 ${state.assignments.length} 支门派，组内已按种子排名排列。` : `总排名第 ${next?.rank || '—'}，点击后随机抽取一个仍有名额的小组。`}</span></div><div class="group-actions"><button onclick="drawNextTeam()"${complete ? ' disabled' : ''}>抽取下一队</button><button class="secondary" onclick="finishGroupDraw()"${complete ? ' disabled' : ''}>完成剩余分组</button><button class="ghost" onclick="resetGroupDraw()"${state.assignments.length ? '' : ' disabled'}>重新分组</button></div></div>${groupCardsHTML(state.data, state)}${seedTableHTML(state.data, assignments, state)}`;
}

function paint() {
  const body = $('#group-tool-body');
  if (!body) return;
  const snapshot = '<div class="data-snapshot-note">每次只使用当前选择的常规赛或踢馆赛数据，并为全部上榜门派分组。本次运行会复用首次读取的结果，如需更新请重启程序。</div>';
  let content;
  if (G.error) content = `<div class="err group-error"><span>获取失败：${esc(G.error)}</span><button class="secondary" onclick="retryGroupTool()">重新尝试</button></div>`;
  else if (G.data) content = renderGroupToolHTML(G);
  else if (G.optionsLoading) content = '<div class="group-empty"><b>正在读取可用赛事…</b><span>赛季和比赛类型准备好后即可选择排名范围。</span></div>';
  else if (G.season && !G.types.length) content = '<div class="group-empty"><b>当前范围没有可模拟的比赛</b><span>该赛区和赛季没有常规赛或踢馆赛数据，请选择其他范围。</span></div>';
  else content = `<div class="group-empty"><b>${G.loading ? '正在整理所选赛事排名…' : '选择赛事后开始分组'}</b><span>排名准备完成后，可以逐队抽取，也可以一次完成剩余分组。</span></div>`;
  body.innerHTML = `${filtersHTML()}${snapshot}${content}`;
}

function switchToGroupPage() {
  for (const id of ['home', 'personal-page', 'events-page', 'tools-page', 'draw-tool-page', 'group-tool-page']) {
    const page = $('#' + id);
    if (page) page.hidden = id !== 'group-tool-page';
  }
  window.scrollTo(0, 0);
}

function cancelRequest() {
  if (G.abort) G.abort.abort();
  G.abort = null;
  G.loading = false;
}

async function loadSeasons() {
  cancelRequest();
  const controller = new AbortController();
  const gen = ++G.gen;
  G.abort = controller; G.optionsLoading = true; G.seasons = []; G.types = []; G.season = ''; G.type = ''; G.data = null; G.assignments = []; G.error = '';
  paint();
  try {
    const response = await eventSeasons(G.zone, controller.signal);
    if (gen !== G.gen) return;
    G.seasons = response.seasons || [];
    G.season = defaultSeason(G.seasons);
    const typeResponse = G.season ? await eventSeasonTypes(G.season, G.zone, controller.signal) : { season_types: [] };
    if (gen !== G.gen) return;
    G.types = usableGroupTypes(typeResponse);
    G.type = preferredGroupType(G.types);
  } catch (error) {
    if (gen !== G.gen || error.name === 'AbortError') return;
    G.error = error.message || '可用赛事范围暂时无法读取';
  } finally {
    if (gen === G.gen) { G.optionsLoading = false; G.abort = null; paint(); }
  }
}

export async function showGroupTool() {
  switchToGroupPage();
  paint();
  if (G.catalog) {
    if (!G.seasons.length && !G.optionsLoading) await loadSeasons();
    return;
  }
  const controller = new AbortController();
  const gen = ++G.gen;
  G.abort = controller; G.optionsLoading = true; G.error = '';
  paint();
  try {
    G.catalog = await eventCatalog(controller.signal);
    if (gen !== G.gen) return;
    if (!(G.catalog.zones || []).some(item => item.value === G.zone)) G.zone = EVENT_ZONE_DEFAULT;
    G.abort = null;
    await loadSeasons();
  } catch (error) {
    if (gen !== G.gen || error.name === 'AbortError') return;
    G.error = error.message || '赛事资料暂时不可用';
    G.optionsLoading = false; G.abort = null; paint();
  }
}

export function closeGroupTool() {
  G.gen++;
  cancelRequest();
  G.optionsLoading = false;
  const page = $('#group-tool-page'), tools = $('#tools-page');
  if (page) page.hidden = true;
  if (tools) tools.hidden = false;
  window.scrollTo(0, 0);
}

export async function syncGroupFilters(kind) {
  if (kind === 'zone') {
    G.zone = $('#group-zone')?.value || G.zone;
    await loadSeasons();
    return;
  }
  if (kind === 'season') {
    cancelRequest();
    const controller = new AbortController();
    const gen = ++G.gen;
    G.abort = controller; G.season = $('#group-season')?.value || ''; G.types = []; G.type = '';
    G.data = null; G.assignments = []; G.lastSectID = 0; G.error = ''; G.optionsLoading = true;
    paint();
    try {
      const response = await eventSeasonTypes(G.season, G.zone, controller.signal);
      if (gen !== G.gen) return;
      G.types = usableGroupTypes(response);
      G.type = preferredGroupType(G.types);
    } catch (error) {
      if (gen !== G.gen || error.name === 'AbortError') return;
      G.error = error.message || '可用比赛类型暂时无法读取';
    } finally {
      if (gen === G.gen) { G.optionsLoading = false; G.abort = null; paint(); }
    }
    return;
  }
  cancelRequest();
  G.gen++;
  G.type = $('#group-type')?.value || '';
  G.data = null; G.assignments = []; G.lastSectID = 0; G.error = '';
  paint();
}

export async function queryGroupTool() {
  if (!G.season || !['2', '3'].includes(String(G.type))) return;
  cancelRequest();
  const controller = new AbortController();
  const gen = ++G.gen;
  G.abort = controller; G.loading = true; G.error = ''; G.data = null; G.assignments = []; G.lastSectID = 0;
  paint();
  try {
    G.data = await groupDrawTool(G.season, G.type, G.zone, controller.signal);
  } catch (error) {
    if (gen !== G.gen || error.name === 'AbortError') return;
    G.error = error.message || '分组排名暂时不可用';
  } finally {
    if (gen === G.gen) { G.loading = false; G.abort = null; paint(); }
  }
}

export async function retryGroupTool() {
  if (!G.catalog) {
    await showGroupTool();
    return;
  }
  if (!G.seasons.length) {
    await loadSeasons();
    return;
  }
  if (!G.types.length) {
    await syncGroupFilters('season');
    return;
  }
  await queryGroupTool();
}

export function drawNextTeam(random = Math.random) {
  const assignment = drawNextAssignment(G.data?.teams, G.assignments, random);
  if (!assignment) return;
  G.assignments.push(assignment);
  G.lastSectID = assignment.sect_id;
  paint();
}

export function finishGroupDraw(random = Math.random) {
  let assignment;
  while ((assignment = drawNextAssignment(G.data?.teams, G.assignments, random))) G.assignments.push(assignment);
  G.lastSectID = G.assignments.at(-1)?.sect_id || 0;
  paint();
}

export function resetGroupDraw() {
  G.assignments = [];
  G.lastSectID = 0;
  paint();
}

export function __setGroupState(next) {
  G = { ...G, ...next };
}
