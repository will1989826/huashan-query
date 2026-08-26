// 抽局积分模拟器：官方数据读取与页面交互；所有抽局场景在浏览器本地即时计算。
import { drawTool, eventCatalog, eventSeasons, eventSeasonTypes } from './api.js';
import { esc } from './format.js';
import { EVENT_ZONE_DEFAULT } from './zone.js';

const $ = selector => document.querySelector(selector);
const round2 = value => Math.round((value + Number.EPSILON) * 100) / 100;

let D = {
  catalog: null, seasons: [], types: [], season: '', type: '5', zone: EVENT_ZONE_DEFAULT,
  data: null, projections: {}, removed: 0, editGame: 0, loading: false, optionsLoading: false,
  error: '', abort: null, metaAbort: null, gen: 0,
};

export function projectionStorageKey(zone, season, type) {
  return `huashan-draw-projections:${zone}:${season}:${type}`;
}

export function mergeProjections(data, saved = {}) {
  const merged = {};
  for (const game of data?.games || []) {
    if (game.complete) continue;
    const row = saved[String(game.index)] || saved[game.index] || {};
    for (const team of data?.teams || []) {
      const raw = row[String(team.sect_id)] ?? row[team.sect_id];
      if (raw === '' || raw == null || !Number.isFinite(Number(raw))) continue;
      (merged[game.index] ||= {})[team.sect_id] = Number(raw);
    }
  }
  return merged;
}

function scoreFor(data, projections, gameIndex, teamIndex) {
  const game = (data.games || [])[gameIndex];
  if (!game) return null;
  if (game.complete) return game.scores?.[teamIndex] == null ? null : Number(game.scores[teamIndex]);
  const sectID = data.teams?.[teamIndex]?.sect_id;
  const value = projections?.[game.index]?.[sectID];
  return value == null || !Number.isFinite(Number(value)) ? null : Number(value);
}

export function rankWithTies(rows) {
  const sorted = [...rows].sort((a, b) => {
    if (a.total == null && b.total == null) return 0;
    if (a.total == null) return 1;
    if (b.total == null) return -1;
    return b.total - a.total || String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN');
  });
  let previous = null;
  sorted.forEach((row, index) => {
    if (row.total == null) row.rank = null;
    else if (previous == null || Math.abs(row.total - previous) > 0.001) row.rank = index + 1;
    else row.rank = sorted[index - 1].rank;
    if (row.total != null) previous = row.total;
  });
  return sorted;
}

export function calculateScenario(data, projections = {}, removedIndex = 0) {
  if (!data?.simulation_ready) return [];
  const rows = (data.teams || []).map((team, teamIndex) => {
    let total = Number(team.constant_adjustment || 0);
    let complete = true;
    for (let gameIndex = 0; gameIndex < (data.games || []).length; gameIndex++) {
      if (gameIndex === removedIndex) continue;
      const score = scoreFor(data, projections, gameIndex, teamIndex);
      if (score == null) { complete = false; break; }
      total += score;
    }
    return { sect_id: team.sect_id, name: team.sect_name, total: complete ? round2(total) : null, rank: null };
  });
  return rankWithTies(rows);
}

function loadSaved(data) {
  try {
    const raw = localStorage.getItem(projectionStorageKey(data.zone, data.season, data.season_type));
    return mergeProjections(data, raw ? JSON.parse(raw) : {});
  } catch { return {}; }
}

function saveProjections() {
  if (!D.data) return;
  try { localStorage.setItem(projectionStorageKey(D.data.zone, D.data.season, D.data.season_type), JSON.stringify(D.projections)); } catch {}
}

function defaultSeason(items) {
  const sorted = [...(items || [])].filter(item => /^S\d+$/.test(String(item.label || '')) && Number(item.value) > 0 && Number(item.value) < 1000).sort((a, b) => Number(b.value) - Number(a.value));
  return String(sorted[0]?.value || '');
}

function options(items, selected) {
  return (items || []).map(item => `<option value="${esc(item.value)}"${String(item.value) === String(selected) ? ' selected' : ''}>${esc(item.label)}</option>`).join('');
}

function gameLabel(game) {
  if (!game) return '—';
  const base = `第 ${game.index} 局`;
  if (!game.complete) return `${base} · 待进行`;
  const detail = [game.play_date, game.round ? `第 ${game.round} 场` : ''].filter(Boolean).join(' · ');
  return detail ? `${base} · ${detail}` : base;
}

function formatScore(value) { return value == null ? '—' : String(round2(Number(value))); }
function filtersHTML() {
  const zones = D.catalog?.zones || [{ value: EVENT_ZONE_DEFAULT, label: '上海赛区' }];
  const drawTypes = (D.types || []).filter(item => ['4', '5'].includes(String(item.value)));
  const seasonDisabled = D.optionsLoading || !D.seasons.length;
  const typeDisabled = D.optionsLoading || !drawTypes.length;
  return `<div class="draw-filters">
    <label><span>赛区</span><select id="draw-zone" onchange="syncDrawFilters('zone')">${options(zones, D.zone)}</select></label>
    <label><span>赛季</span><select id="draw-season" onchange="syncDrawFilters('season')"${seasonDisabled ? ' disabled' : ''}>${options(D.seasons, D.season)}</select></label>
    <label><span>比赛类型</span><select id="draw-type" onchange="syncDrawFilters('type')"${typeDisabled ? ' disabled' : ''}>${options(drawTypes, D.type)}</select></label>
    <button onclick="queryDrawTool()"${D.loading || D.optionsLoading || !D.season || !drawTypes.length ? ' disabled' : ''}>${D.loading ? '计算中…' : D.optionsLoading ? '加载赛季…' : '读取比赛数据'}</button>
  </div>`;
}

function scoreCell(data, game, gameIndex, teamIndex) {
  const team = data.teams[teamIndex];
  const selected = gameIndex === D.removed ? ' selected' : '';
  if (game.complete) return `<td class="draw-score official${selected}">${formatScore(game.scores?.[teamIndex])}</td>`;
  const value = D.projections?.[game.index]?.[team.sect_id];
  return `<td class="draw-score projected${selected}"><input class="draw-projection-input" data-game="${game.index}" data-sect="${team.sect_id}" aria-label="${esc(team.sect_name)}第 ${game.index} 局预测分" type="number" step="0.5" inputmode="decimal" value="${value == null ? '' : esc(value)}" oninput="setDrawProjection(${game.index},${team.sect_id},this.value,this)"></td>`;
}

function matrixHTML(data, scenario) {
  const teamIndexes = new Map(data.teams.map((team, index) => [team.sect_id, index]));
  const heads = data.games.map((game, index) => `<th class="draw-game-head${index === D.removed ? ' selected' : ''}"><button onclick="selectDrawRemoved(${index})" aria-pressed="${index === D.removed}"><b>第 ${game.index} 局</b><small>${game.complete ? (game.play_date || '已完成') : '预测'}</small></button></th>`).join('');
  const rows = scenario.map(current => {
    const teamIndex = teamIndexes.get(current.sect_id);
    const team = data.teams[teamIndex];
    const top = current.rank != null && current.rank <= 3 ? ' top' : '';
    return `<tr data-draw-team="${team.sect_id}"><th class="draw-team-name"><span class="draw-inline-rank${top}" data-draw-rank="${team.sect_id}">${current.rank == null ? '—' : current.rank}</span><span>${esc(team.sect_name)}</span></th><td class="draw-adjust draw-carry" title="不随抽局移除的带入积分">${formatScore(team.initial_bonus)}</td><td class="draw-adjust draw-penalty" title="不随抽局移除的赛外违规扣分">${formatScore(team.outside_adjustment)}</td>${data.games.map((game, gameIndex) => scoreCell(data, game, gameIndex, teamIndex)).join('')}<td class="draw-current-total" data-draw-total="${team.sect_id}">${formatScore(current.total)}</td></tr>`;
  }).join('');
  return `<div class="draw-matrix-wrap"><table class="draw-matrix"><thead><tr><th class="draw-team-name">排名 · 门派</th><th class="draw-adjust draw-carry">带入积分</th><th class="draw-adjust draw-penalty">赛外违规扣分</th>${heads}<th class="draw-current-total">抽局积分</th></tr></thead><tbody id="draw-matrix-body" aria-live="polite">${rows}</tbody></table></div>`;
}

function mobileEditorHTML(data, scenario) {
  const game = data.games[D.editGame] || data.games[0];
  const gameIndex = Math.max(0, Number(game?.index || 1) - 1);
  const teamIndexes = new Map(data.teams.map((team, index) => [team.sect_id, index]));
  const rows = scenario.map(current => {
    const teamIndex = teamIndexes.get(current.sect_id);
    const team = data.teams[teamIndex];
    const value = scoreFor(data, D.projections, gameIndex, teamIndex);
    const field = game.complete
      ? `<b>${formatScore(value)}</b><small>官方局分</small>`
      : `<input class="draw-projection-input" data-game="${game.index}" data-sect="${team.sect_id}" aria-label="${esc(team.sect_name)}预测分" type="number" step="0.5" inputmode="decimal" value="${value == null ? '' : esc(value)}" oninput="setDrawProjection(${game.index},${team.sect_id},this.value,this)">`;
    const top = current.rank != null && current.rank <= 3 ? ' class="top"' : '';
    return `<div class="draw-mobile-score" data-draw-team="${team.sect_id}"><span class="draw-mobile-team"><i${top} data-draw-rank="${team.sect_id}">${current.rank == null ? '—' : current.rank}</i><b>${esc(team.sect_name)}</b></span><strong><span data-draw-total="${team.sect_id}">${formatScore(current.total)}</span><small>积分</small></strong><span class="draw-mobile-game-score">${field}</span></div>`;
  }).join('');
  const choices = data.games.map((item, index) => `<option value="${index}"${index === D.removed ? ' selected' : ''}>第 ${item.index} 局</option>`).join('');
  return `<section class="draw-mobile-panel"><div class="draw-mobile-controls"><label><span>抽掉</span><select onchange="selectDrawRemoved(this.value)">${choices}</select></label><label><span>填写或查看局分</span><select onchange="selectDrawEditGame(this.value)">${data.games.map((item, index) => `<option value="${index}"${index === D.editGame ? ' selected' : ''}>${esc(gameLabel(item))}</option>`).join('')}</select></label></div><div id="draw-mobile-ranking" class="draw-mobile-scores" aria-live="polite">${rows}</div></section>`;
}

function resultHTML(data) {
  const scenario = calculateScenario(data, D.projections, D.removed);
  const missing = scenario.filter(row => row.total == null).length;
  const rule = data.season_type === '4' ? '季后赛 15 局取 14 局，带入积分和赛外违规扣分保留。' : '总决赛 16 局取 15 局，赛外违规扣分保留。';
  const history = data.official_draw_applied ? `官方历史抽局：第 ${(data.games.find(game => game.game_id === data.historical_removed_game) || {}).index || '—'} 局。` : '';
  const warnings = (data.warnings || []).map(text => `<div class="draw-warning">${esc(text)}</div>`).join('');
  if (!data.simulation_ready) return `<div class="draw-status"><b>当前数据暂时不能准确模拟</b><span>${esc(rule)}</span></div>${warnings}`;
  return `<div class="draw-status"><b>已完成 ${data.completed_games} / ${data.expected_games} 局</b><span>${esc(rule)} ${esc(history)}</span></div>${warnings}<div id="draw-prompt" class="draw-prompt"${missing ? '' : ' hidden'}>请填写未进行比赛的预测分；抽掉某局时，该局的预测分可以留空。</div><div class="draw-desktop">${matrixHTML(data, scenario)}</div><div class="draw-mobile">${mobileEditorHTML(data, scenario)}</div>`;
}

function reorderDrawRows(container, scenario) {
  if (!container) return;
  for (const row of scenario) {
    const element = container.querySelector(`[data-draw-team="${row.sect_id}"]`);
    if (element) container.appendChild(element);
  }
}

function refreshDrawResults() {
  if (!D.data?.simulation_ready) return;
  const scenario = calculateScenario(D.data, D.projections, D.removed);
  const byTeam = new Map(scenario.map(row => [String(row.sect_id), row]));
  document.querySelectorAll('[data-draw-total]').forEach(cell => { cell.textContent = formatScore(byTeam.get(cell.dataset.drawTotal)?.total); });
  document.querySelectorAll('[data-draw-rank]').forEach(cell => {
    const rank = byTeam.get(cell.dataset.drawRank)?.rank;
    cell.textContent = rank ?? '—';
    cell.classList.toggle('top', rank != null && rank <= 3);
  });
  reorderDrawRows($('#draw-matrix-body'), scenario);
  reorderDrawRows($('#draw-mobile-ranking'), scenario);
  const prompt = $('#draw-prompt');
  if (prompt) prompt.hidden = !scenario.some(row => row.total == null);
}

function paint() {
  const body = $('#draw-tool-body');
  if (!body) return;
  const snapshotNote = '<div class="data-snapshot-note">本次运行会复用首次读取的赛事数据，不会自动更新。如需查看官方最新结果，请重启程序后重新查询。</div>';
  let content = '';
  if (D.error) content = `<div class="err draw-error">获取失败：${esc(D.error)}</div>`;
  else if (D.data) content = resultHTML(D.data);
  else if (D.optionsLoading) content = '<div class="draw-empty"><b>正在读取可用赛季…</b><span>新赛区的赛季列表返回后即可选择查询。</span></div>';
  else content = `<div class="draw-empty"><b>${D.loading ? '正在读取并计算比赛数据…' : '选择赛事后开始模拟'}</b><span>已完成的比赛使用官方局分，未进行的比赛可填写预测分。</span></div>`;
  body.innerHTML = `${filtersHTML()}${snapshotNote}${content}`;
}

function switchToDrawPage() {
  for (const id of ['home', 'personal-page', 'events-page', 'tools-page', 'draw-tool-page']) {
    const page = $('#' + id);
    if (page) page.hidden = id !== 'draw-tool-page';
  }
  window.scrollTo(0, 0);
}

function usableDrawTypes(response) {
  return (response?.season_types || []).filter(item => ['4', '5'].includes(String(item.value)));
}

function preferredDrawType(types, current = '') {
  if (types.some(item => String(item.value) === String(current))) return String(current);
  return String(types.find(item => String(item.value) === '5')?.value || types[0]?.value || '');
}

function cancelDrawRequests() {
  if (D.metaAbort) D.metaAbort.abort();
  if (D.abort) D.abort.abort();
  D.metaAbort = null;
  D.abort = null;
  D.loading = false;
}

async function loadLatestDrawSeason() {
  cancelDrawRequests();
  const controller = new AbortController();
  const gen = ++D.gen;
  const zone = D.zone;
  D.metaAbort = controller;
  D.seasons = []; D.season = ''; D.types = []; D.type = '';
  D.data = null; D.error = ''; D.optionsLoading = true;
  paint();
  try {
    const response = await eventSeasons(zone, controller.signal);
    if (gen !== D.gen) return;
    const seasons = response.seasons || [];
    let season = defaultSeason(seasons);
    let types = season ? usableDrawTypes(await eventSeasonTypes(season, zone, controller.signal)) : [];
    if (gen !== D.gen) return;
    // 最新赛季尚未进入淘汰赛时，回退到最近一个可模拟的赛季。
    if (!types.length) {
      const prior = seasons.filter(item => /^S\d+$/.test(String(item.label || '')) && Number(item.value) > 0 && Number(item.value) < Number(season)).sort((a, b) => Number(b.value) - Number(a.value));
      for (const item of prior) {
        const candidate = String(item.value);
        const candidateTypes = usableDrawTypes(await eventSeasonTypes(candidate, zone, controller.signal));
        if (gen !== D.gen) return;
        if (candidateTypes.length) { season = candidate; types = candidateTypes; break; }
      }
    }
    D.seasons = seasons;
    D.season = season;
    D.types = types;
    D.type = preferredDrawType(types);
  } catch (error) {
    if (gen !== D.gen || error.name === 'AbortError') return;
    D.error = error.message || '可用赛事范围暂时无法读取';
  } finally {
    if (gen === D.gen) {
      D.optionsLoading = false;
      D.metaAbort = null;
      paint();
    }
  }
}

async function loadDrawTypesForSeason() {
  cancelDrawRequests();
  const controller = new AbortController();
  const gen = ++D.gen;
  const zone = D.zone, season = D.season;
  D.metaAbort = controller;
  D.types = []; D.type = ''; D.data = null; D.error = ''; D.optionsLoading = true;
  paint();
  try {
    const types = usableDrawTypes(await eventSeasonTypes(season, zone, controller.signal));
    if (gen !== D.gen) return;
    D.types = types;
    D.type = preferredDrawType(types);
  } catch (error) {
    if (gen !== D.gen || error.name === 'AbortError') return;
    D.error = error.message || '可用比赛类型暂时无法读取';
  } finally {
    if (gen === D.gen) {
      D.optionsLoading = false;
      D.metaAbort = null;
      paint();
    }
  }
}

export async function showDrawTool() {
  switchToDrawPage();
  paint();
  if (D.catalog) {
    if (!D.seasons.length && !D.optionsLoading) await loadLatestDrawSeason();
    return;
  }
  cancelDrawRequests();
  const controller = new AbortController();
  const gen = ++D.gen;
  D.metaAbort = controller;
  D.seasons = []; D.season = ''; D.types = []; D.type = '';
  D.data = null; D.error = ''; D.optionsLoading = true;
  paint();
  try {
    D.catalog = await eventCatalog(controller.signal);
    if (gen !== D.gen) return;
    if (!(D.catalog.zones || []).some(item => item.value === D.zone)) D.zone = EVENT_ZONE_DEFAULT;
    D.metaAbort = null;
    await loadLatestDrawSeason();
  } catch (error) {
    if (gen !== D.gen || error.name === 'AbortError') return;
    D.error = error.message || '赛事资料暂时不可用';
    D.optionsLoading = false;
    D.metaAbort = null;
    paint();
  }
}

export function closeDrawTool() {
  D.gen++;
  cancelDrawRequests();
  D.optionsLoading = false;
  const drawPage = $('#draw-tool-page'), toolsPage = $('#tools-page');
  if (drawPage) drawPage.hidden = true;
  if (toolsPage) toolsPage.hidden = false;
  window.scrollTo(0, 0);
}

export async function syncDrawFilters(kind) {
  if (kind === 'zone') {
    D.zone = $('#draw-zone')?.value || D.zone;
    await loadLatestDrawSeason();
    return;
  }
  if (kind === 'season') {
    D.season = $('#draw-season')?.value || '';
    await loadDrawTypesForSeason();
    return;
  }
  cancelDrawRequests();
  D.gen++;
  D.type = $('#draw-type')?.value || '';
  D.data = null; D.error = ''; D.optionsLoading = false;
  paint();
}

export async function queryDrawTool() {
  if (!D.season || !['4', '5'].includes(String(D.type))) return;
  if (D.abort) D.abort.abort();
  D.abort = new AbortController();
  const gen = ++D.gen;
  D.loading = true; D.error = ''; D.data = null; paint();
  try {
    const data = await drawTool(D.season, D.type, D.zone, D.abort.signal);
    if (gen !== D.gen) return;
    D.data = data;
    D.projections = loadSaved(data);
    const historical = (data.games || []).findIndex(game => game.game_id === data.historical_removed_game);
    D.removed = historical >= 0 ? historical : 0;
    const firstFuture = (data.games || []).findIndex(game => !game.complete);
    D.editGame = firstFuture >= 0 ? firstFuture : D.removed;
  } catch (error) {
    if (gen !== D.gen || error.name === 'AbortError') return;
    D.error = error.message || '比赛数据暂时不可用';
  } finally {
    if (gen === D.gen) { D.loading = false; D.abort = null; paint(); }
  }
}

export function setDrawProjection(gameIndex, sectID, raw, sourceInput) {
  const game = D.data?.games?.find(item => item.index === Number(gameIndex));
  if (!game || game.complete) return;
  if (raw === '' || !Number.isFinite(Number(raw))) {
    if (D.projections[game.index]) delete D.projections[game.index][sectID];
  } else {
    (D.projections[game.index] ||= {})[sectID] = Number(raw);
  }
  saveProjections();
  document.querySelectorAll(`.draw-projection-input[data-game="${game.index}"][data-sect="${sectID}"]`).forEach(input => {
    if (input !== sourceInput && input.value !== raw) input.value = raw;
  });
  refreshDrawResults();
}

export function selectDrawRemoved(index) {
  const value = Number(index);
  if (!D.data?.games?.[value]) return;
  const scrollLeft = $('.draw-matrix-wrap')?.scrollLeft || 0;
  D.removed = value;
  paint();
  const matrix = $('.draw-matrix-wrap');
  if (matrix) matrix.scrollLeft = scrollLeft;
}

export function selectDrawEditGame(index) {
  const value = Number(index);
  if (!D.data?.games?.[value]) return;
  D.editGame = value;
  paint();
}

export function __setDrawState(next) {
  D = { ...D, ...next };
}
