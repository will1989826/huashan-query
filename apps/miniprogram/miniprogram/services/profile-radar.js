const STORAGE_KEY = 'huashan-profile-radar-metrics'
const COMPARE_STORAGE_KEY = 'huashan-compare-radar-metrics'
const MIN = 5
const MAX = 7

const METRICS = [
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
]

const DEFAULTS = METRICS.slice(0, MIN).map((metric) => metric.id)
const validIDs = new Set(METRICS.map((metric) => metric.id))

function normalize(ids) {
  const selected = []
  const seen = new Set()
  ;(Array.isArray(ids) ? ids : []).forEach((id) => {
    if (!validIDs.has(id) || seen.has(id) || selected.length >= MAX) return
    seen.add(id)
    selected.push(id)
  })
  DEFAULTS.forEach((id) => {
    if (selected.length >= MIN || seen.has(id)) return
    seen.add(id)
    selected.push(id)
  })
  return METRICS.filter((metric) => seen.has(metric.id)).map((metric) => metric.id)
}

function toggle(ids, id, checked) {
  const selected = new Set(normalize(ids))
  if (checked) {
    if (validIDs.has(id) && selected.size < MAX) selected.add(id)
  } else if (selected.size > MIN) {
    selected.delete(id)
  }
  return METRICS.filter((metric) => selected.has(metric.id)).map((metric) => metric.id)
}

function load() {
  try {
    return normalize(wx.getStorageSync(STORAGE_KEY) || [])
  } catch (_) {
    return DEFAULTS.slice()
  }
}

function save(ids) {
  const selected = normalize(ids)
  try { wx.setStorageSync(STORAGE_KEY, selected) } catch (_) {}
  return selected
}

function loadCompare() {
  try {
    return normalize(wx.getStorageSync(COMPARE_STORAGE_KEY) || [])
  } catch (_) {
    return DEFAULTS.slice()
  }
}

function saveCompare(ids) {
  const selected = normalize(ids)
  try { wx.setStorageSync(COMPARE_STORAGE_KEY, selected) } catch (_) {}
  return selected
}

function groupsFromSections(sections) {
  const groups = { summary: {}, good: {}, wolf: {} }
  ;(sections || []).forEach((section) => {
    if (!groups[section.key]) return
    ;(section.metrics || []).forEach((metric) => { groups[section.key][metric.key] = metric.rawValue })
  })
  return groups
}

function numeric(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function normalizedValue(metric, value) {
  if (value == null) return null
  const maximum = Number(metric.max) || 100
  return Math.max(0, Math.min(100, value / maximum * 100))
}

function valueText(metric, value, missing = '暂无数据') {
  return value == null ? missing : value + (metric.unit || '%')
}

function view(groups, ids) {
  const selection = normalize(ids)
  const selected = new Set(selection)
  const groupLabels = { summary: '综合', good: '好人', wolf: '狼人' }
  const options = METRICS.map((metric) => {
    const value = numeric(groups && groups[metric.group] && groups[metric.group][metric.key])
    const isSelected = selected.has(metric.id)
    return {
      ...metric,
      available: value != null,
      disabled: isSelected ? selection.length <= MIN : (selection.length >= MAX || value == null),
      groupText: groupLabels[metric.group],
      selected: isSelected,
      value,
      valueText: valueText(metric, value),
      normalizedValue: normalizedValue(metric, value),
    }
  })
  const axes = options.filter((metric) => metric.selected)
  const missing = axes.filter((metric) => !metric.available)
  return {
    axes,
    complete: missing.length === 0,
    missingText: missing.length ? '当前范围缺少' + missing.map((metric) => metric.label).join('、') + '，暂时无法绘制完整图形。' : '',
    options,
    selectedCount: axes.length,
  }
}

function compareView(players, ids) {
  const selection = normalize(ids)
  const selected = new Set(selection)
  const people = (players || []).map((player) => ({
    id: String(player.id),
    name: player.name || '#' + player.id,
    groups: player.groups || {},
  }))
  const options = METRICS.map((metric) => {
    const values = people.map((player) => numeric(player.groups[metric.group] && player.groups[metric.group][metric.key]))
    const availableCount = values.filter((value) => value != null).length
    const available = people.length > 0 && availableCount === people.length
    const isSelected = selected.has(metric.id)
    return {
      ...metric,
      available,
      availableCount,
      coverageText: availableCount + '/' + people.length + '人有数据',
      disabled: isSelected ? selection.length <= MIN : (selection.length >= MAX || !available),
      selected: isSelected,
      values,
      valueTexts: values.map((value) => valueText(metric, value, '暂无')),
      normalizedValues: values.map((value) => normalizedValue(metric, value)),
    }
  })
  const axes = options.filter((metric) => metric.selected)
  const missing = axes.filter((metric) => !metric.available)
  return {
    axes,
    complete: people.length >= 2 && people.length <= 4 && missing.length === 0,
    missingText: missing.length ? '当前选手在' + missing.map((metric) => metric.label).join('、') + '上数据不齐。' : '',
    options,
    players: people.map((player, playerIndex) => ({
      ...player,
      playerIndex,
      summary: axes.map((axis) => axis.short + ' ' + axis.valueTexts[playerIndex]).join(' · '),
    })),
    selectedCount: axes.length,
  }
}

function points(count, radius, cx, cy) {
  return Array.from({ length: count }, (_, index) => {
    const angle = -Math.PI / 2 + Math.PI * 2 * index / count
    return [cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius]
  })
}

const PALETTES = {
  dark: { accent: '#65d6b5', fill: 'rgba(101,214,181,.20)', line: '#315048', text: '#dce7e3', muted: '#94a6a1' },
  light: { accent: '#a33d27', fill: 'rgba(163,61,39,.16)', line: '#cdbca3', text: '#51453e', muted: '#675a51' },
  yulehui: { accent: '#0757ce', fill: 'rgba(7,87,206,.15)', line: '#aabde0', text: '#2c3b69', muted: '#46587f' },
  'jinfeng-xiyulou': { accent: '#1e466f', fill: 'rgba(30,70,111,.15)', line: '#a9b9c9', text: '#344d68', muted: '#455c72' },
}

const COMPARE_SERIES = {
  dark: [
    { stroke: '#14b8a6', fill: 'rgba(20,184,166,.10)' },
    { stroke: '#f59e0b', fill: 'rgba(245,158,11,.09)' },
    { stroke: '#3b82f6', fill: 'rgba(59,130,246,.09)' },
    { stroke: '#ef5da8', fill: 'rgba(239,93,168,.08)' },
  ],
  light: [
    { stroke: '#087f73', fill: 'rgba(8,127,115,.09)' },
    { stroke: '#a45c00', fill: 'rgba(164,92,0,.08)' },
    { stroke: '#2563b8', fill: 'rgba(37,99,184,.08)' },
    { stroke: '#b52f72', fill: 'rgba(181,47,114,.07)' },
  ],
  yulehui: [
    { stroke: '#008d9f', fill: 'rgba(0,141,159,.09)' },
    { stroke: '#9a6500', fill: 'rgba(154,101,0,.08)' },
    { stroke: '#0757ce', fill: 'rgba(7,87,206,.08)' },
    { stroke: '#b83280', fill: 'rgba(184,50,128,.07)' },
  ],
  'jinfeng-xiyulou': [
    { stroke: '#237f83', fill: 'rgba(35,127,131,.09)' },
    { stroke: '#8b6200', fill: 'rgba(139,98,0,.08)' },
    { stroke: '#1e5c85', fill: 'rgba(30,92,133,.08)' },
    { stroke: '#a33f70', fill: 'rgba(163,63,112,.07)' },
  ],
}

function draw(canvas, width, height, radar, theme) {
  if (!canvas || !radar || !radar.complete || radar.axes.length < 3) return
  const context = canvas.getContext('2d')
  const dpr = Math.max(1, Number(wx.getSystemInfoSync().pixelRatio) || 1)
  canvas.width = width * dpr
  canvas.height = height * dpr
  context.scale(dpr, dpr)
  context.clearRect(0, 0, width, height)
  const palette = PALETTES[theme] || PALETTES.dark
  const cx = width / 2
  const cy = height / 2 - 7
  const radius = Math.min(width * 0.26, height * 0.34)
  const polygon = (vertices, stroke, fill) => {
    context.beginPath()
    vertices.forEach(([x, y], index) => index ? context.lineTo(x, y) : context.moveTo(x, y))
    context.closePath()
    if (fill) { context.fillStyle = fill; context.fill() }
    context.strokeStyle = stroke
    context.lineWidth = 1
    context.stroke()
  }
  ;[0.25, 0.5, 0.75, 1].forEach((scale) => polygon(points(radar.axes.length, radius * scale, cx, cy), palette.line))
  const outer = points(radar.axes.length, radius, cx, cy)
  outer.forEach(([x, y]) => {
    context.beginPath(); context.moveTo(cx, cy); context.lineTo(x, y)
    context.strokeStyle = palette.line; context.stroke()
  })
  const values = radar.axes.map((axis, index) => {
    return points(radar.axes.length, radius * axis.normalizedValue / 100, cx, cy)[index]
  })
  polygon(values, palette.accent, palette.fill)
  values.forEach(([x, y]) => {
    context.beginPath(); context.arc(x, y, 3, 0, Math.PI * 2)
    context.fillStyle = palette.accent; context.fill()
  })
  context.font = '10px sans-serif'
  points(radar.axes.length, radius + 28, cx, cy).forEach(([x, y], index) => {
    const axis = radar.axes[index]
    context.textAlign = Math.abs(x - cx) < 8 ? 'center' : (x < cx ? 'right' : 'left')
    context.fillStyle = palette.text
    context.fillText(axis.short, x, y)
    context.fillStyle = palette.muted
    context.fillText(axis.valueText, x, y + 14)
  })
}

function drawCompare(canvas, width, height, radar, theme) {
  if (!canvas || !radar || !radar.complete || radar.axes.length < 3) return
  const context = canvas.getContext('2d')
  const dpr = Math.max(1, Number(wx.getSystemInfoSync().pixelRatio) || 1)
  canvas.width = width * dpr
  canvas.height = height * dpr
  context.scale(dpr, dpr)
  context.clearRect(0, 0, width, height)
  const palette = PALETTES[theme] || PALETTES.dark
  const compareSeries = COMPARE_SERIES[theme] || COMPARE_SERIES.dark
  const cx = width / 2
  const cy = height / 2 - 5
  const radius = Math.min(width * 0.27, height * 0.36)
  const polygon = (vertices, stroke, fill, lineWidth) => {
    context.beginPath()
    vertices.forEach(([x, y], index) => index ? context.lineTo(x, y) : context.moveTo(x, y))
    context.closePath()
    if (fill) { context.fillStyle = fill; context.fill() }
    context.strokeStyle = stroke
    context.lineWidth = lineWidth || 1
    context.stroke()
  }
  ;[0.25, 0.5, 0.75, 1].forEach((scale) => polygon(points(radar.axes.length, radius * scale, cx, cy), palette.line))
  const outer = points(radar.axes.length, radius, cx, cy)
  outer.forEach(([x, y]) => {
    context.beginPath(); context.moveTo(cx, cy); context.lineTo(x, y)
    context.strokeStyle = palette.line; context.lineWidth = 1; context.stroke()
  })
  radar.players.forEach((_, playerIndex) => {
    const series = compareSeries[playerIndex]
    const values = radar.axes.map((axis, axisIndex) => {
      return points(radar.axes.length, radius * axis.normalizedValues[playerIndex] / 100, cx, cy)[axisIndex]
    })
    polygon(values, series.stroke, series.fill, 2)
    values.forEach(([x, y]) => {
      context.beginPath(); context.arc(x, y, 2.5, 0, Math.PI * 2)
      context.fillStyle = series.stroke; context.fill()
    })
  })
  context.font = '10px sans-serif'
  points(radar.axes.length, radius + 27, cx, cy).forEach(([x, y], index) => {
    context.textAlign = Math.abs(x - cx) < 8 ? 'center' : (x < cx ? 'right' : 'left')
    context.fillStyle = palette.text
    context.fillText(radar.axes[index].short, x, y)
  })
}

module.exports = {
  DEFAULTS,
  COMPARE_STORAGE_KEY,
  MAX,
  METRICS,
  MIN,
  STORAGE_KEY,
  draw,
  drawCompare,
  groupsFromSections,
  load,
  loadCompare,
  normalize,
  points,
  save,
  saveCompare,
  toggle,
  view,
  compareView,
}
