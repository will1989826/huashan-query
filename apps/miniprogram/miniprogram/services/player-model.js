const shared = require('./shared')
const zoneService = require('./zone')

const METRIC_LABELS = {
  total_point: '总分',
  round_total: '总场次',
  round_point_avg: '场均分',
  win_pct: '胜率',
  cunhuo_pct: '存活率',
  renming_num: '人命值',
  mvp_num: 'MVP次数',
  svp_num: '尽力次数',
  bgx_num: '背锅次数',
  jingzhang_num: '警长次数',
  toulang_pct: '投狼率',
  zhanbian_snum: '站对边数',
  zhanbian_total: '站边次数',
  zhanbian_pct: '站对边率',
  molang_pct: '摸狼率',
  nvyl_pct: '女巫毒狼率',
  ztfl_pct: '侦探翻狼率',
  yyjyl_pct: '预言家验狼率',
  tjh_pct: '警徽投对率',
  lrql_pct: '猎人带狼率',
  htsp_num: '悍跳神牌次数',
  wei_hantiao_num: '未悍跳次数',
  hantiao_snum: '悍跳成功次数',
  hantiao_total: '悍跳次数',
  hantiao_pct: '悍跳成功率',
  zidao_num: '自刀次数',
  fds_snum: '刀神次数',
  fds_total: '刀人次数',
  fds_pct: '刀神率',
}

function playerSearchVariants(name) {
  const original = String(name || '').trim()
  if (!original) return []
  const capitalized = original.charAt(0).toUpperCase() + original.slice(1)
  return [...new Set([original, capitalized])]
}

function mergePlayerSearchResults(results) {
  const merged = []
  const seen = new Set()
  ;(results || []).forEach((payload) => {
    shared.rows(payload).forEach((player) => {
      const id = player && player.player_id
      if (id == null) {
        merged.push(player)
        return
      }
      const key = String(id)
      if (seen.has(key)) return
      seen.add(key)
      merged.push(player)
    })
  })
  return merged
}

function rankPlayerSearchResults(players, query) {
  const original = String(query || '').trim()
  if (!original) return (players || []).slice()
  const foldedQuery = original.toLocaleLowerCase()
  function score(player) {
    const name = String((player && player.player_name) || '').trim()
    const foldedName = name.toLocaleLowerCase()
    if (name === original) return 0
    if (foldedName === foldedQuery) return 0.5
    if (foldedName.startsWith(foldedQuery)) return 1
    const index = foldedName.indexOf(foldedQuery)
    return index >= 0 ? 2 + Math.min(index, 99) / 100 : 3
  }
  return (players || []).map((player, index) => ({ player, index })).sort((left, right) => {
    const scoreDifference = score(left.player) - score(right.player)
    if (scoreDifference) return scoreDifference
    const leftName = String((left.player && left.player.player_name) || '')
    const rightName = String((right.player && right.player.player_name) || '')
    if (leftName.length !== rightName.length) return leftName.length - rightName.length
    const pointDifference = Number((right.player && right.player.total_point) || 0)
      - Number((left.player && left.player.total_point) || 0)
    return pointDifference || left.index - right.index
  }).map((entry) => entry.player)
}

function playerView(player) {
  const id = player && player.player_id != null ? String(player.player_id) : ''
  const sects = Array.isArray(player && player.sects)
    ? player.sects.map((sect) => sect && (sect.name || sect.sect_name)).filter(Boolean)
    : []
  return {
    playerId: id,
    name: (player && player.player_name) || (id ? '#' + id : '未知选手'),
    avatar: (player && player.player_avatar) || '',
    sect: sects.join(' · ') || '暂无门派信息',
    point: player && player.total_point != null ? String(player.total_point) : '',
  }
}

function mergeTeamNames(...sources) {
  const names = []
  const seen = new Set()
  sources.forEach((source) => {
    const values = Array.isArray(source) ? source : String(source || '').split(/·/)
    values.forEach((value) => {
      const name = String(value && typeof value === 'object' ? (value.name || value.sect_name || '') : value).trim()
      if (!name || name === '暂无门派信息' || seen.has(name)) return
      seen.add(name)
      names.push(name)
    })
  })
  return names
}


function displayValue(value, percent) {
  if (value == null || value === '') return '—'
  return String(value) + (percent ? '%' : '')
}

function metricItems(source, hidden) {
  const values = source && typeof source === 'object' ? source : {}
  const excluded = new Set(hidden || [])
  return Object.keys(values).filter((key) => key && !excluded.has(key)).map((key) => ({
    key,
    label: metricLabel(key),
    rawValue: values[key],
    value: displayValue(values[key], key.endsWith('_pct')),
  }))
}

function playerDetailView(payload, fallback) {
  const stats = shared.unwrap(payload)
  const player = stats.player || {}
  const summary = stats.summary || {}
  const good = stats.haoren || {}
  const base = fallback || {}
  const joined = Array.isArray(stats.joined_zone_ids) ? stats.joined_zone_ids : []
  return {
    playerId: String(base.playerId || player.id || ''),
    name: player.name || base.name || '未知选手',
    avatar: player.avatar || base.avatar || '',
    sect: base.sect || '暂无门派信息',
    joined,
    honors: (Array.isArray(stats.honors) ? stats.honors : []).map((honor) => ({
      text: zoneService.honorZoneName(honor && honor.zone_id, joined)
        + (honor && honor.season_id != null ? ' S' + honor.season_id : '')
        + (String(honor && honor.code) === '1' ? ' 冠军' : (honor && honor.code != null ? ' 第' + honor.code + '名' : '')),
    })).filter((honor) => honor.text.trim()),
    power: displayValue(stats.power, false),
    metrics: [
      { key: 'round_total', label: '总场次', value: displayValue(summary.round_total, false) },
      { key: 'round_point_avg', label: '场均分', value: displayValue(summary.round_point_avg, false) },
      { key: 'win_pct', label: '胜率', value: displayValue(summary.win_pct, true) },
      { key: 'toulang_pct', label: '投狼率', value: displayValue(good.toulang_pct, true) },
      { key: 'zhanbian_pct', label: '站对边率', value: displayValue(good.zhanbian_pct, true) },
    ],
    overviewSections: [
      { key: 'summary', title: '综合', metrics: metricItems(summary) },
      { key: 'good', title: '好人', metrics: metricItems(good, ['htsp_num']) },
      { key: 'wolf', title: '狼人', metrics: metricItems(stats.langren, ['bgx_num']) },
    ],
  }
}

function metricLabel(key) {
  return METRIC_LABELS[key] || key
}

function isGoodRole(role) {
  return shared.isGoodCamp(role)
}

function gameItems(payload) {
  const source = Array.isArray(payload) ? payload : shared.rows(payload)
  return source.map((game) => {
    const marks = []
    if (Number(game && game.mvp) === 1) marks.push('MVP')
    if (Number(game && game.svp) === 1) marks.push('尽力')
    if (Number(game && game.bgx) === 1) marks.push('背锅')
    const hasResult = game && game.win != null && game.win !== ''
    const point = game && game.total_point
    return {
      gameId: String((game && game.game_id) || ''),
      date: (game && game.play_date) || '日期未知',
      edition: (game && game.edition_name) || '版型未知',
      role: (game && game.rpt_name) || '身份未知',
      sect: (game && game.sect_name) || '门派未知',
      season: game && game.season_id != null ? 'S' + game.season_id : '',
      round: game && game.round != null ? '第 ' + game.round + ' 轮' : '',
      seat: game && game.seat != null ? game.seat + '号' : '',
      point: point == null || point === '' ? '—' : String(point),
      pointValue: point == null || point === '' ? null : Number(point),
      result: hasResult ? (Number(game.win) === 1 ? '胜' : '负') : '结果未知',
      won: hasResult && Number(game.win) === 1,
      hasResult,
      resultClass: hasResult ? (Number(game.win) === 1 ? 'won' : 'lost') : 'unknown',
      camp: isGoodRole(game && game.rpt_name) ? 'good' : 'wolf',
      mvp: Number(game && game.mvp) === 1,
      svp: Number(game && game.svp) === 1,
      bgx: Number(game && game.bgx) === 1,
      marks: marks.join(' · '),
    }
  })
}

function gameFilterOptions(games) {
  const rows = games || []
  return {
    roles: [...new Set(rows.map((game) => game.role).filter((role) => role && role !== '身份未知'))].sort(),
    sects: [...new Set(rows.map((game) => game.sect).filter((sect) => sect && sect !== '门派未知'))].sort(),
  }
}

function filteredGames(games, filters, sort) {
  const selected = filters || {}
  const ordering = sort || { key: 'date', direction: 'desc' }
  let rows = (games || []).filter((game) => {
    if (selected.role && game.role !== selected.role) return false
    if (selected.sect && game.sect !== selected.sect) return false
    if (selected.result === 'win' && !game.won) return false
    if (selected.result === 'loss' && (!game.hasResult || game.won)) return false
    if (selected.camp && game.camp !== selected.camp) return false
    if (selected.mark && !game[selected.mark]) return false
    return true
  })
  const direction = ordering.direction === 'asc' ? 1 : -1
  const key = ordering.key === 'point' ? 'pointValue' : 'date'
  rows = rows.map((game, index) => ({ game, index })).sort((left, right) => {
    const a = left.game[key]
    const b = right.game[key]
    const aMissing = a == null || a === '' || (key === 'pointValue' && !Number.isFinite(a))
    const bMissing = b == null || b === '' || (key === 'pointValue' && !Number.isFinite(b))
    if (aMissing && bMissing) return left.index - right.index
    if (aMissing) return 1
    if (bMissing) return -1
    if (a === b) return left.index - right.index
    return direction * (a < b ? -1 : 1)
  }).map((entry) => entry.game)
  return rows
}

function breakdown(games, key, options) {
  const config = options || {}
  const groups = new Map()
  ;(games || []).forEach((game) => {
    const name = game[key]
    if (!name || (config.skipUnknown && name === config.skipUnknown)) return
    if (!groups.has(name)) {
      groups.set(name, { name, games: 0, points: 0, wins: 0, wolves: 0, mvp: 0, svp: 0, bgx: 0 })
    }
    const row = groups.get(name)
    row.games += 1
    row.points += Number.isFinite(game.pointValue) ? game.pointValue : 0
    if (game.won) row.wins += 1
    if (game.camp === 'wolf') row.wolves += 1
    if (game.mvp) row.mvp += 1
    if (game.svp) row.svp += 1
    if (game.bgx) row.bgx += 1
  })
  return Array.from(groups.values()).map((row) => ({
    name: row.name,
    games: row.games,
    totalPoint: shared.round2(row.points),
    avg: shared.round2(row.points / row.games),
    winValue: Math.round(row.wins / row.games * 100),
    win: Math.round(row.wins / row.games * 100) + '%',
    wolfRateValue: Math.round(row.wolves / row.games * 100),
    wolfRate: Math.round(row.wolves / row.games * 100) + '%',
    mvp: row.mvp,
    svp: row.svp,
    bgx: row.bgx,
  })).sort((left, right) => right.games - left.games)
}

function baseSectName(name) {
  return String(name || '').trim().replace(/[（(][^（()）]*[）)]\s*$/, '').trim()
}

function aggregateMetrics(games) {
  const rows = games || []
  if (!rows.length) return {}
  const total = rows.reduce((sum, game) => sum + (Number.isFinite(game.pointValue) ? game.pointValue : 0), 0)
  const count = (key) => rows.filter((game) => !!game[key]).length
  return {
    round_total: rows.length,
    total_point: shared.round2(total),
    round_point_avg: shared.round2(total / rows.length),
    win_pct: Math.round(count('won') / rows.length * 100),
    mvp_num: count('mvp'),
    svp_num: count('svp'),
    bgx_num: count('bgx'),
  }
}

function scopedGames(games, scope) {
  const selected = scope || {}
  const season = String(selected.season || '').replace(/^S/i, '')
  const sect = String(selected.sect || '')
  return (games || []).filter((game) => (
    (!season || String(game.season || '').replace(/^S/i, '') === season)
    && (!sect || baseSectName(game.sect) === sect)
  ))
}

function scopeCandidates(games, scope) {
  const selected = scope || {}
  const season = String(selected.season || '').replace(/^S/i, '')
  const sect = String(selected.sect || '')
  const seasonSource = sect ? (games || []).filter((game) => baseSectName(game.sect) === sect) : (games || [])
  const sectSource = season ? (games || []).filter((game) => String(game.season || '').replace(/^S/i, '') === season) : (games || [])
  const seasons = [...new Set(seasonSource.map((game) => Number(String(game.season || '').replace(/^S/i, ''))).filter(Number.isFinite))].sort((a, b) => b - a)
  const sects = [...new Set(sectSource.map((game) => baseSectName(game.sect)).filter((name) => name && name !== '门派未知'))]
    .sort((left, right) => left.localeCompare(right, 'zh-CN'))
  if (season && !seasons.some((item) => String(item) === season)) seasons.unshift(Number(season))
  if (sect && !sects.includes(sect)) sects.unshift(sect)
  return { seasons, sects }
}

function playerDetailForSect(payload, fallback, games, sect) {
  const view = playerDetailView(payload, fallback)
  if (!sect) return view
  const selected = scopedGames(games, { sect })
  const good = selected.filter((game) => game.camp === 'good')
  const wolf = selected.filter((game) => game.camp === 'wolf')
  const summaryMetrics = aggregateMetrics(selected)
  const goodMetrics = aggregateMetrics(good)
  const wolfMetrics = aggregateMetrics(wolf)
  view.metrics = [
    { key: 'round_total', label: '总场次', value: displayValue(summaryMetrics.round_total, false) },
    { key: 'round_point_avg', label: '场均分', value: displayValue(summaryMetrics.round_point_avg, false) },
    { key: 'win_pct', label: '胜率', value: displayValue(summaryMetrics.win_pct, true) },
    { key: 'toulang_pct', label: '投狼率', value: '—' },
    { key: 'zhanbian_pct', label: '站对边率', value: '—' },
  ]
  view.overviewSections = [
    { key: 'summary', title: '综合', metrics: metricItems(summaryMetrics) },
    { key: 'good', title: '好人', metrics: metricItems(goodMetrics, ['htsp_num']) },
    { key: 'wolf', title: '狼人', metrics: metricItems(wolfMetrics, ['bgx_num']) },
  ]
  return view
}

function roleBreakdown(games) {
  return breakdown(games, 'role').map((row) => ({
    ...row,
    camp: isGoodRole(row.name) ? 'good' : 'wolf',
  }))
}

function editionBreakdown(games) {
  return breakdown(games, 'edition', { skipUnknown: '版型未知' })
}

function filteredBreakdown(rows, filters, sort) {
  const selected = filters || {}
  const ordering = sort || { key: 'games', direction: 'desc' }
  const query = String(selected.query || '').trim().toLocaleLowerCase()
  const allowed = new Set(['games', 'totalPoint', 'avg', 'winValue', 'wolfRateValue', 'mvp', 'svp', 'bgx'])
  const key = allowed.has(ordering.key) ? ordering.key : 'games'
  const direction = ordering.direction === 'asc' ? 1 : -1
  return (rows || []).filter((row) => {
    if (selected.camp && row.camp !== selected.camp) return false
    if (query && !String(row.name || '').toLocaleLowerCase().includes(query)) return false
    return true
  }).map((row, index) => ({ row, index })).sort((left, right) => {
    const a = Number(left.row[key])
    const b = Number(right.row[key])
    if (a === b) return left.index - right.index
    return direction * (a - b)
  }).map((entry) => entry.row)
}

function recentGameItems(payload) {
  return gameItems(payload).slice(0, 5)
}

module.exports = {
  editionBreakdown,
  filteredBreakdown,
  filteredGames,
  gameFilterOptions,
  gameItems,
  metricLabel,
  mergeTeamNames,
  mergePlayerSearchResults,
  playerSearchVariants,
  playerView,
  rankPlayerSearchResults,
  playerDetailForSect,
  playerDetailView,
  recentGameItems,
  roleBreakdown,
  scopeCandidates,
  scopedGames,
}
