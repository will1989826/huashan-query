const STORAGE_KEY = 'profile-radar-metrics';
const COMPARE_STORAGE_KEY = 'compare-radar-metrics';

export const RADAR_MIN = 5;
export const RADAR_MAX = 7;

export const RADAR_METRICS = Object.freeze([
  { id: 'summary.win_pct', group: 'summary', key: 'win_pct', label: '综合胜率', short: '综合胜率' },
  { id: 'good.win_pct', group: 'good', key: 'win_pct', label: '好人胜率', short: '好人胜率' },
  { id: 'wolf.win_pct', group: 'wolf', key: 'win_pct', label: '狼人胜率', short: '狼人胜率' },
  { id: 'good.toulang_pct', group: 'good', key: 'toulang_pct', label: '投狼率', short: '投狼率' },
  { id: 'good.zhanbian_pct', group: 'good', key: 'zhanbian_pct', label: '站对边率', short: '站对边率' },
  { id: 'good.round_point_avg', group: 'good', key: 'round_point_avg', label: '好人场均分', short: '好人场均', max: 8.5, unit: '分' },
  { id: 'wolf.round_point_avg', group: 'wolf', key: 'round_point_avg', label: '狼人场均分', short: '狼人场均', max: 8, unit: '分' },
  { id: 'summary.cunhuo_pct', group: 'summary', key: 'cunhuo_pct', label: '综合存活率', short: '综合存活' },
  { id: 'good.cunhuo_pct', group: 'good', key: 'cunhuo_pct', label: '好人存活率', short: '好人存活' },
  { id: 'wolf.cunhuo_pct', group: 'wolf', key: 'cunhuo_pct', label: '狼人存活率', short: '狼人存活' },
  { id: 'good.nvyl_pct', group: 'good', key: 'nvyl_pct', label: '女巫毒狼率', short: '女巫毒狼' },
  { id: 'good.ztfl_pct', group: 'good', key: 'ztfl_pct', label: '侦探翻狼率', short: '侦探翻狼' },
  { id: 'good.yyjyl_pct', group: 'good', key: 'yyjyl_pct', label: '预言家验狼率', short: '预言验狼' },
  { id: 'good.tjh_pct', group: 'good', key: 'tjh_pct', label: '警徽投对率', short: '警徽投对' },
  { id: 'good.lrql_pct', group: 'good', key: 'lrql_pct', label: '猎人带狼率', short: '猎人带狼' },
  { id: 'wolf.molang_pct', group: 'wolf', key: 'molang_pct', label: '摸狼率', short: '摸狼率' },
  { id: 'wolf.hantiao_pct', group: 'wolf', key: 'hantiao_pct', label: '悍跳成功率', short: '悍跳成功' },
  { id: 'wolf.fds_pct', group: 'wolf', key: 'fds_pct', label: '刀神率', short: '刀神率' },
]);

export const DEFAULT_RADAR_METRICS = Object.freeze(RADAR_METRICS.slice(0, RADAR_MIN).map(metric => metric.id));

const metricByID = new Map(RADAR_METRICS.map(metric => [metric.id, metric]));

export function normalizeRadarSelection(ids) {
  const selected = [];
  const seen = new Set();
  for (const id of Array.isArray(ids) ? ids : []) {
    if (!metricByID.has(id) || seen.has(id) || selected.length >= RADAR_MAX) continue;
    seen.add(id);
    selected.push(id);
  }
  for (const id of DEFAULT_RADAR_METRICS) {
    if (selected.length >= RADAR_MIN) break;
    if (!seen.has(id)) {
      seen.add(id);
      selected.push(id);
    }
  }
  return RADAR_METRICS.filter(metric => seen.has(metric.id)).map(metric => metric.id);
}

export function toggleRadarSelection(ids, id, checked) {
  const selected = normalizeRadarSelection(ids);
  const set = new Set(selected);
  if (checked) {
    if (metricByID.has(id) && set.size < RADAR_MAX) set.add(id);
  } else if (set.size > RADAR_MIN) {
    set.delete(id);
  }
  return RADAR_METRICS.filter(metric => set.has(metric.id)).map(metric => metric.id);
}

export function loadRadarSelection() {
  try {
    return normalizeRadarSelection(JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'));
  } catch {
    return [...DEFAULT_RADAR_METRICS];
  }
}

export function saveRadarSelection(ids) {
  const selected = normalizeRadarSelection(ids);
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(selected)); } catch { }
  return selected;
}

export function loadCompareRadarSelection() {
  try {
    return normalizeRadarSelection(JSON.parse(localStorage.getItem(COMPARE_STORAGE_KEY) || '[]'));
  } catch {
    return [...DEFAULT_RADAR_METRICS];
  }
}

export function saveCompareRadarSelection(ids) {
  const selected = normalizeRadarSelection(ids);
  try { localStorage.setItem(COMPARE_STORAGE_KEY, JSON.stringify(selected)); } catch { }
  return selected;
}

function numeric(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizedValue(metric, value) {
  if (value == null) return null;
  const maximum = Number(metric.max) || 100;
  return Math.max(0, Math.min(100, value / maximum * 100));
}

function valueText(metric, value, missing = '暂无数据') {
  return value == null ? missing : `${value}${metric.unit || '%'}`;
}

export function radarGroups(model) {
  const toMap = rows => Object.fromEntries((rows || []).map(item => [item.key, item.val]));
  return {
    summary: toMap(model && model.comprehensive),
    good: toMap(model && model.good),
    wolf: toMap(model && model.wolf),
  };
}

export function radarView(groups, ids) {
  const selected = normalizeRadarSelection(ids);
  const selectedSet = new Set(selected);
  const options = RADAR_METRICS.map(metric => {
    const value = numeric(groups && groups[metric.group] && groups[metric.group][metric.key]);
    return {
      ...metric,
      value,
      valueText: valueText(metric, value),
      normalizedValue: normalizedValue(metric, value),
      available: value != null,
      selected: selectedSet.has(metric.id),
    };
  });
  const axes = options.filter(metric => metric.selected);
  const missing = axes.filter(metric => !metric.available);
  return {
    axes,
    complete: missing.length === 0,
    missing,
    options,
    selectedCount: axes.length,
  };
}

export function compareRadarView(players, ids) {
  const selected = normalizeRadarSelection(ids);
  const selectedSet = new Set(selected);
  const people = (players || []).map(player => ({
    id: String(player.id),
    name: player.name || ('#' + player.id),
    groups: player.groups || {},
  }));
  const options = RADAR_METRICS.map(metric => {
    const values = people.map(player => numeric(player.groups[metric.group] && player.groups[metric.group][metric.key]));
    const availableCount = values.filter(value => value != null).length;
    return {
      ...metric,
      available: people.length > 0 && availableCount === people.length,
      availableCount,
      selected: selectedSet.has(metric.id),
      values,
      valueTexts: values.map(value => valueText(metric, value, '暂无')),
      normalizedValues: values.map(value => normalizedValue(metric, value)),
    };
  });
  const axes = options.filter(metric => metric.selected);
  const missing = axes.filter(metric => !metric.available);
  return {
    axes,
    complete: people.length >= 2 && people.length <= 4 && missing.length === 0,
    missing,
    options,
    players: people,
    selectedCount: axes.length,
  };
}

function point(count, index, radius, cx, cy) {
  const angle = -Math.PI / 2 + Math.PI * 2 * index / count;
  return [cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius];
}

export function radarPoints(count, radius, cx = 180, cy = 156) {
  return Array.from({ length: count }, (_, index) => point(count, index, radius, cx, cy));
}

const pointsAttr = points => points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');

export function radarSVG(view) {
  const count = view.axes.length;
  if (count < 3) return '';
  const cx = 180, cy = 156, radius = 104;
  const outer = radarPoints(count, radius, cx, cy);
  const rings = [0.25, 0.5, 0.75, 1].map(scale =>
    `<polygon class="radar-ring" points="${pointsAttr(radarPoints(count, radius * scale, cx, cy))}"></polygon>`).join('');
  const spokes = outer.map(([x, y]) => `<line class="radar-spoke" x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}"></line>`).join('');
  const labels = radarPoints(count, radius + 31, cx, cy).map(([x, y], index) => {
    const axis = view.axes[index];
    const anchor = Math.abs(x - cx) < 8 ? 'middle' : (x < cx ? 'end' : 'start');
    const value = axis.available ? axis.valueText : '暂无';
    return `<text class="radar-label" x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="${anchor}"><tspan x="${x.toFixed(1)}">${axis.short}</tspan><tspan class="radar-label-value" x="${x.toFixed(1)}" dy="14">${value}</tspan></text>`;
  }).join('');
  let shape = '';
  if (view.complete) {
    const valuePoints = view.axes.map((axis, index) => {
      return point(count, index, radius * axis.normalizedValue / 100, cx, cy);
    });
    shape = `<polygon class="radar-shape" points="${pointsAttr(valuePoints)}"></polygon>`
      + valuePoints.map(([x, y]) => `<circle class="radar-point" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.5"></circle>`).join('');
  }
  const description = view.complete
    ? view.axes.map(axis => `${axis.label} ${axis.valueText}`).join('，')
    : `缺少${view.missing.map(axis => axis.label).join('、')}，暂时无法绘制完整图形`;
  return `<svg class="profile-radar-svg" viewBox="0 0 360 320" role="img" aria-label="个人表现雷达图：${description}">${rings}${spokes}${shape}${labels}</svg>`;
}

export function compareRadarSVG(view) {
  const count = view.axes.length;
  if (!view.complete || count < 3) return '';
  const cx = 180, cy = 156, radius = 104;
  const outer = radarPoints(count, radius, cx, cy);
  const rings = [0.25, 0.5, 0.75, 1].map(scale =>
    `<polygon class="radar-ring" points="${pointsAttr(radarPoints(count, radius * scale, cx, cy))}"></polygon>`).join('');
  const spokes = outer.map(([x, y]) => `<line class="radar-spoke" x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}"></line>`).join('');
  const labels = radarPoints(count, radius + 25, cx, cy).map(([x, y], index) => {
    const anchor = Math.abs(x - cx) < 8 ? 'middle' : (x < cx ? 'end' : 'start');
    return `<text class="radar-label" x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="${anchor}">${view.axes[index].short}</text>`;
  }).join('');
  const shapes = view.players.map((player, playerIndex) => {
    const valuePoints = view.axes.map((axis, axisIndex) => {
      return point(count, axisIndex, radius * axis.normalizedValues[playerIndex] / 100, cx, cy);
    });
    return `<polygon class="compare-radar-shape series-${playerIndex}" points="${pointsAttr(valuePoints)}"></polygon>`
      + valuePoints.map(([x, y]) => `<circle class="compare-radar-point series-${playerIndex}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3"></circle>`).join('');
  }).join('');
  return `<svg class="profile-radar-svg compare-radar-svg" viewBox="0 0 360 320" role="img" aria-label="${view.players.length}名选手的表现雷达图">${rings}${spokes}${shapes}${labels}</svg>`;
}
