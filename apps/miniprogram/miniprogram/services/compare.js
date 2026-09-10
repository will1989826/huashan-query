const huashan = require('./huashan')
const shared = require('./shared')

const GROUPS = [
  { key: 'summary', label: '综合' },
  { key: 'good', label: '好人' },
  { key: 'wolf', label: '狼人' },
]
const DEFAULT_CUSTOM = [
  ['summary', 'round_total'],
  ['summary', 'round_point_avg'],
  ['summary', 'win_pct'],
  ['good', 'toulang_pct'],
  ['good', 'zhanbian_pct'],
]
const ROLE_METRICS = [
  { key: 'games', label: '场次' },
  { key: 'avg', label: '场均分', normalized: true },
  { key: 'winValue', label: '胜率', percent: true, normalized: true },
  { key: 'mvp', label: 'MVP' },
  { key: 'svp', label: '尽力' },
  { key: 'bgx', label: '背锅' },
]
const SHARED_METRICS = [
  { key: 'total', label: '总分', direction: 1 },
  { key: 'avg', label: '场均分', direction: 1 },
  { key: 'win', label: '胜率', direction: 1, percent: true },
  { key: 'mvp', label: 'MVP', direction: 1 },
  { key: 'svp', label: '尽力', direction: 1 },
  { key: 'bgx', label: '背锅', direction: -1 },
]
const GROUP_PREFIX = { summary: '综合', good: '好人', wolf: '狼人' }

function cloneDefaultCustom() {
  return DEFAULT_CUSTOM.map((pair) => pair.slice())
}

function sectionMap(head) {
  const result = {}
  ;((head && head.overviewSections) || []).forEach((section) => {
    result[section.key] = section.metrics || []
  })
  return result
}

function valueMap(metrics) {
  const result = {}
  ;(metrics || []).forEach((metric) => {
    result[metric.key] = metric.rawValue
  })
  return result
}

function metricUnion(records, group, selected) {
  const found = []
  const seen = new Set()
  ;(records || []).forEach((record) => {
    const metrics = sectionMap(record.head)[group] || []
    metrics.forEach((metric) => {
      if (!seen.has(metric.key)) {
        seen.add(metric.key)
        found.push({ key: metric.key, label: metric.label })
      }
    })
  })
  ;(selected || []).filter((pair) => pair[0] === group).forEach((pair) => {
    if (seen.has(pair[1])) return
    seen.add(pair[1])
    found.push({ key: pair[1], label: huashan.metricLabel(pair[1]) })
  })
  return found
}

function customOptions(records, selected) {
  const chosen = new Set((selected || []).map((pair) => pair.join(':')))
  return GROUPS.map((group) => ({
    ...group,
    metrics: metricUnion(records, group.key, selected).map((metric) => ({
      ...metric,
      selected: chosen.has(group.key + ':' + metric.key),
    })),
  })).filter((group) => group.metrics.length)
}

function shallowColumns(records, group, selected) {
  if (group === 'custom') {
    return (selected || []).map(([sourceGroup, key]) => ({
      key: sourceGroup + ':' + key,
      sourceGroup,
      sourceKey: key,
      label: (GROUP_PREFIX[sourceGroup] || sourceGroup) + '·' + huashan.metricLabel(key),
      normalized: key.endsWith('_pct') || key === 'round_point_avg',
      percent: key.endsWith('_pct'),
    }))
  }
  return metricUnion(records, group).map((metric) => ({
    ...metric,
    sourceGroup: group,
    sourceKey: metric.key,
    normalized: metric.key.endsWith('_pct') || metric.key === 'round_point_avg',
    percent: metric.key.endsWith('_pct'),
  }))
}

function rawValue(record, column) {
  const values = valueMap(sectionMap(record.head)[column.sourceGroup])
  return values[column.sourceKey]
}

function display(value, percent) {
  if (value == null || value === '' || Number.isNaN(Number(value))) return '—'
  return String(value) + (percent ? '%' : '')
}

function sortedRecords(records, key, direction, getter) {
  if (!key) return (records || []).slice()
  const dir = direction === 'asc' ? 1 : -1
  return (records || []).map((record, index) => ({ record, index })).sort((left, right) => {
    const a = getter(left.record, key)
    const b = getter(right.record, key)
    const am = a == null || a === '' || Number.isNaN(Number(a))
    const bm = b == null || b === '' || Number.isNaN(Number(b))
    if (am && bm) return left.index - right.index
    if (am) return 1
    if (bm) return -1
    const difference = Number(a) - Number(b)
    return difference ? dir * difference : left.index - right.index
  }).map((entry) => entry.record)
}

function winnerIds(records, getter, direction) {
  if (!direction) return new Set()
  const values = (records || []).map((record) => ({
    id: record.player.playerId,
    value: getter(record),
  })).filter((item) => item.value != null && item.value !== '' && !Number.isNaN(Number(item.value)))
  if (values.length < 2) return new Set()
  const best = direction > 0
    ? Math.max(...values.map((item) => Number(item.value)))
    : Math.min(...values.map((item) => Number(item.value)))
  return new Set(values.filter((item) => Number(item.value) === best).map((item) => item.id))
}

function visibleRecords(records, hidden) {
  const excluded = hidden instanceof Set ? hidden : new Set(hidden || [])
  return (records || []).filter((record) => !excluded.has(record.player.playerId))
}

function makeRows(records, columns, getter) {
  const winners = {}
  columns.forEach((column) => {
    winners[column.key] = winnerIds(records, (record) => getter(record, column), column.direction)
  })
  return records.map((record) => ({
    ...record.player,
    power: record.head ? record.head.power : '—',
    honors: record.head ? record.head.honors : [],
    error: record.headError || record.fullError || '',
    loading: !!record.loadingHead || !!record.loadingFull,
    values: columns.map((column) => ({
      key: column.key,
      label: column.label,
      rawValue: getter(record, column),
      value: display(getter(record, column), column.percent),
      best: winners[column.key].has(record.player.playerId),
    })),
  }))
}

function shallowView(records, group, custom, hidden, sort) {
  const columns = shallowColumns(records, group, custom).map((column) => ({
    ...column,
    direction: column.normalized ? 1 : 0,
  }))
  let visible = visibleRecords(records, hidden)
  visible = sortedRecords(visible, sort && sort.key, sort && sort.direction, (record, key) => {
    const column = columns.find((item) => item.key === key)
    return column ? rawValue(record, column) : null
  })
  return { columns, players: makeRows(visible, columns, rawValue) }
}

function roleRows(record) {
  return (record.full && record.full.roles) || []
}

function roleUnion(records) {
  const seen = new Set()
  const roles = []
  ;(records || []).forEach((record) => roleRows(record).forEach((row) => {
    if (seen.has(row.name)) return
    seen.add(row.name)
    roles.push(row.name)
  }))
  return roles
}

function roleValue(record, role, metric) {
  const row = roleRows(record).find((item) => item.name === role)
  return row ? row[metric] : null
}

function identityMatrix(records, metric, hidden, sort) {
  const definition = ROLE_METRICS.find((item) => item.key === metric) || ROLE_METRICS[1]
  const columns = roleUnion(records).map((role) => ({
    key: role,
    label: role,
    primaryLabel: role,
    contextLabel: definition.label,
    role,
    direction: definition.normalized ? 1 : 0,
    percent: definition.percent,
  }))
  let visible = visibleRecords(records, hidden)
  visible = sortedRecords(visible, sort && sort.key, sort && sort.direction,
    (record, role) => roleValue(record, role, definition.key))
  return {
    columns,
    players: makeRows(visible, columns, (record, column) => roleValue(record, column.role, definition.key)),
  }
}

function identitySingle(records, role, hidden, sort) {
  const columns = ROLE_METRICS.map((metric) => ({
    ...metric,
    primaryLabel: metric.label,
    contextLabel: role,
    direction: metric.normalized ? 1 : 0,
    percent: metric.percent,
  }))
  let visible = visibleRecords(records, hidden)
  visible = sortedRecords(visible, sort && sort.key, sort && sort.direction,
    (record, key) => roleValue(record, role, key))
  return {
    columns,
    players: makeRows(visible, columns, (record, column) => roleValue(record, role, column.key)),
  }
}

function sharedGames(records) {
  if (!records || !records.length) return []
  const entries = records.map((record) => ({
    playerId: record.player.playerId,
    games: (record.full && record.full.games) || [],
  }))
  const base = entries.reduce((left, right) => left.games.length <= right.games.length ? left : right)
  const candidates = new Map()
  base.games.forEach((game) => {
    if (game.gameId && !candidates.has(game.gameId)) {
      candidates.set(game.gameId, { gameId: game.gameId, meta: game, byPlayer: { [base.playerId]: game } })
    }
  })
  entries.forEach((entry) => {
    if (entry === base) return
    const seen = new Set()
    entry.games.forEach((game) => {
      const candidate = candidates.get(game.gameId)
      if (!candidate || seen.has(game.gameId)) return
      candidate.byPlayer[entry.playerId] = game
      seen.add(game.gameId)
    })
    candidates.forEach((_, gameId) => {
      if (!seen.has(gameId)) candidates.delete(gameId)
    })
  })
  return [...candidates.values()]
}

function sharedStats(games, playerId) {
  const rows = (games || []).map((game) => game.byPlayer[playerId]).filter(Boolean)
  if (!rows.length) return {}
  const total = rows.reduce((sum, row) => sum + (Number(row.pointValue) || 0), 0)
  const count = (key) => rows.filter((row) => !!row[key]).length
  return {
    total: shared.round2(total),
    avg: shared.round2(total / rows.length),
    win: Math.round(count('won') / rows.length * 100),
    mvp: count('mvp'),
    svp: count('svp'),
    bgx: count('bgx'),
  }
}

function sharedSummary(records, games, hidden, sort) {
  const stats = new Map(records.map((record) => [record.player.playerId, sharedStats(games, record.player.playerId)]))
  const columns = SHARED_METRICS.map((metric) => ({ ...metric }))
  let visible = visibleRecords(records, hidden)
  visible = sortedRecords(visible, sort && sort.key, sort && sort.direction,
    (record, key) => stats.get(record.player.playerId)[key])
  return {
    columns,
    players: makeRows(visible, columns,
      (record, column) => stats.get(record.player.playerId)[column.key]),
  }
}

function sharedDetails(records, games, hidden, edition, order, limit) {
  const excluded = hidden instanceof Set ? hidden : new Set(hidden || [])
  const visible = records.filter((record) => !excluded.has(record.player.playerId))
  const editions = [...new Set((games || []).map((game) => game.meta.edition).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, 'zh-CN'))
  let filtered = edition ? games.filter((game) => game.meta.edition === edition) : games.slice()
  filtered.sort((left, right) => {
    const date = String(left.meta.date || '').localeCompare(String(right.meta.date || ''))
    const id = Number(left.gameId) - Number(right.gameId)
    const result = date || id
    return order === 'asc' ? result : -result
  })
  const shown = filtered.slice(0, Math.max(10, limit || 10)).map((game) => ({
    gameId: game.gameId,
    date: game.meta.date,
    edition: game.meta.edition,
    season: game.meta.season,
    round: game.meta.round,
    players: visible.map((record) => {
      const row = game.byPlayer[record.player.playerId]
      return {
        playerId: record.player.playerId,
        name: record.player.name,
        seat: row ? row.seat : '—',
        role: row ? row.role : '身份未知',
        point: row ? row.point : '—',
        result: row ? row.result : '结果未知',
        resultClass: row ? row.resultClass : 'unknown',
        marks: row ? row.marks : '',
      }
    }),
  }))
  return { editions, filteredCount: filtered.length, hasMore: filtered.length > shown.length, shown }
}

function seasonOptions(records) {
  const seasons = new Set()
  ;(records || []).forEach((record) => {
    ;((record.full && record.full.seasonCandidates) || []).forEach((season) => seasons.add(Number(season)))
  })
  return [...seasons].filter(Number.isFinite).sort((a, b) => b - a)
}

module.exports = {
  DEFAULT_CUSTOM,
  GROUPS,
  ROLE_METRICS,
  SHARED_METRICS,
  cloneDefaultCustom,
  customOptions,
  identityMatrix,
  identitySingle,
  roleUnion,
  seasonOptions,
  sharedDetails,
  sharedGames,
  sharedStats,
  sharedSummary,
  shallowView,
  sortedRecords,
  winnerIds,
}
