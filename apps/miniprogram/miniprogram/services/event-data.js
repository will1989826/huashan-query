const { baseSect, buildDrawData } = require('./event-model')
const { request } = require('./request')
const shared = require('./shared')
const zoneService = require('./zone')
const { lexical, numeric, round2 } = shared

const PAGE_SIZE = 500
const MAX_PAGES = 20
const ZONES = zoneService.ZONES.filter(([value]) => !['ALL', 'XM'].includes(value)).map(([value, label]) => ({ value, label }))

let catalogCache = null
const availabilityCache = new Map()
const rankingCache = new Map()
const playerCache = new Map()
const drawCache = new Map()
const teamCache = new Map()
const latestSectCache = new Map()

function rows(payload) {
  return shared.rows(payload)
}

function optionRows(payload) {
  return rows(payload).filter((item) => item && !item.deleted).map((item) => ({
    value: String(item.value == null ? '' : item.value),
    label: String(item.text || item.label || ''),
    ordering: Number(item.ordering || 0),
  })).filter((item) => item.value && item.label)
}

function scopeKey(season, type, zone) {
  return [season, type || '', zone || 'SH'].join('|')
}

function query(values) {
  return Object.keys(values).filter((key) => values[key] !== '' && values[key] != null)
    .map((key) => encodeURIComponent(key) + '=' + encodeURIComponent(values[key])).join('&')
}

async function catalog() {
  if (catalogCache) return catalogCache
  const [seasons, types] = await Promise.all([
    request('/system/dicts/suites/season'),
    request('/system/dicts/suites/season.type'),
  ])
  catalogCache = { seasons: optionRows(seasons), seasonTypes: optionRows(types), zones: ZONES }
  return catalogCache
}

async function sectPage(season, type, zone, page, size) {
  const path = '/stats/sect-stats?' + query({
    page: page || 1,
    size: size || PAGE_SIZE,
    season_id: season,
    season_type_id: type || '',
    zone_id: zone || 'SH',
  })
  return request(path)
}

async function probe(season, type, zone) {
  const key = scopeKey(season, type, zone)
  if (availabilityCache.has(key)) return availabilityCache.get(key)
  const payload = await sectPage(season, type, zone, 1, 1)
  const body = payload && payload.data && !Array.isArray(payload.data) ? payload.data : payload
  const available = rows(payload).length > 0 || Number(body && body.total_items) > 0
  availabilityCache.set(key, available)
  return available
}

async function filterAvailable(options, tester, workerCount) {
  const source = options || []
  const result = new Array(source.length).fill(false)
  let next = 0
  async function worker() {
    while (next < source.length) {
      const index = next
      next += 1
      result[index] = await tester(source[index])
    }
  }
  const workers = []
  for (let index = 0; index < Math.min(workerCount || 6, source.length); index += 1) workers.push(worker())
  await Promise.all(workers)
  return source.filter((_, index) => result[index])
}

async function availableSeasons(zone) {
  const data = await catalog()
  return filterAvailable(data.seasons, (item) => probe(item.value, '', zone), 6)
}

async function availableTypes(season, zone) {
  const data = await catalog()
  return filterAvailable(data.seasonTypes, (item) => probe(season, item.value, zone), 6)
}

async function rankings(season, type, zone) {
  const key = scopeKey(season, type, zone)
  if (rankingCache.has(key)) return rankingCache.get(key)
  const all = []
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const payload = await sectPage(season, type, zone, page, PAGE_SIZE)
    const current = rows(payload)
    current.forEach((item) => all.push({
      sectId: Math.trunc(numeric(item.sect_id)),
      sectName: item.sect_name || '未知门派',
      totalPoint: round2(item.total_point || 0),
      mvp: Math.round(numeric(item.mvp)),
      svp: Math.round(numeric(item.svp)),
      bgx: Math.round(numeric(item.bgx)),
    }))
    const body = payload && payload.data && !Array.isArray(payload.data) ? payload.data : payload
    if (current.length < PAGE_SIZE || (body && body.total_items != null && all.length >= Number(body.total_items))) break
    if (page === MAX_PAGES) throw new Error('门派排名数据过多，无法完整读取。')
  }
  all.sort((a, b) => b.totalPoint - a.totalPoint || lexical(a.sectName, b.sectName))
  all.forEach((item, index) => { item.rank = index + 1 })
  rankingCache.set(key, all)
  return all
}

function normalizePlayer(item) {
  return {
    playerId: Math.trunc(numeric(item.player_id)),
    playerName: item.player_name || item.name || '',
    totalRound: Math.trunc(numeric(item.total_round)),
    totalPoint: round2(item.total_point || 0),
    mvp: Math.round(numeric(item.mvp_qty)),
    svp: Math.round(numeric(item.svp_qty)),
    bgx: Math.round(numeric(item.bgx_qty)),
    sectIds: (Array.isArray(item.sects) ? item.sects : []).map((sect) => Math.trunc(numeric(sect && sect.id))).filter(Boolean),
  }
}

async function eventPlayers(season, type, zone) {
  const key = scopeKey(season, type, zone)
  if (playerCache.has(key)) return playerCache.get(key)
  const all = []
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const payload = await request('/stats/players/games?' + query({
      page,
      size: PAGE_SIZE,
      season_id: season,
      season_type_id: type,
      zone_id: zone,
    }))
    const current = rows(payload)
    current.forEach((item) => all.push(normalizePlayer(item)))
    const body = payload && payload.data && !Array.isArray(payload.data) ? payload.data : payload
    const hasTotal = body && body.total_items != null && Number.isFinite(Number(body.total_items))
    if (hasTotal && Math.ceil(Number(body.total_items) / PAGE_SIZE) > MAX_PAGES) {
      throw new Error('参赛选手数据过多，无法完整读取。')
    }
    if (hasTotal ? page * PAGE_SIZE >= Number(body.total_items) : current.length < PAGE_SIZE) break
    if (page === MAX_PAGES) throw new Error('参赛选手数据过多，无法完整读取。')
  }
  playerCache.set(key, all)
  return all
}

function metricsFor(rankRows, playerRows, type) {
  const indexBySect = new Map(rankRows.map((item, index) => [item.sectId, index]))
  const rounds = new Array(rankRows.length).fill(0)
  let incomplete = false
  playerRows.forEach((player) => {
    if (player.totalRound <= 0) return
    const matched = [...new Set(player.sectIds.map((id) => indexBySect.get(id)).filter((index) => index != null))]
    if (matched.length === 1) rounds[matched[0]] += player.totalRound
    else if (matched.length > 1) incomplete = true
  })
  const dayMode = String(type) === '2' || String(type) === '3'
  const teams = rankRows.map((team, index) => {
    const games = rounds[index]
    const days = dayMode && games ? Math.ceil(games / 3) : 0
    const divisor = dayMode ? days : games
    return {
      ...team,
      roundCount: games,
      games: !dayMode && games ? games : null,
      days: dayMode && days ? days : null,
      avg: divisor ? round2(team.totalPoint / divisor) : null,
    }
  })
  const players = playerRows.filter((player) => player.playerId && player.totalRound > 0).map((player) => {
    const days = dayMode ? Math.ceil(player.totalRound / 3) : 0
    const divisor = dayMode ? days : player.totalRound
    return { ...player, games: player.totalRound, days, avg: round2(player.totalPoint / divisor) }
  }).sort((a, b) => b.totalPoint - a.totalPoint || b.games - a.games || lexical(a.playerName, b.playerName))
  players.forEach((player, index) => { player.rank = index + 1 })
  return { teams, players, dayMode, incomplete }
}

async function eventMetrics(season, type, zone, rankRows) {
  const players = await eventPlayers(season, type, zone)
  const result = metricsFor(rankRows, players, type)
  const indexBySect = new Map(rankRows.map((item, index) => [item.sectId, index]))
  const ambiguous = players.filter((player) => (
    player.totalRound > 0
    && [...new Set(player.sectIds.map((id) => indexBySect.get(id)).filter((index) => index != null))].length > 1
  ))
  if (!ambiguous.length) return result
  const fetched = await mapLimit(ambiguous, 8, (player) => latestSect(player.playerId, season, zone))
  let incomplete = false
  fetched.forEach((entry, playerIndex) => {
    if (entry.error) {
      if (entry.error.code === 'TOKEN_EXPIRED') throw entry.error
      incomplete = true
      return
    }
    const player = ambiguous[playerIndex]
    const candidates = [...new Set(player.sectIds.map((id) => indexBySect.get(id)).filter((index) => index != null))]
    const matched = candidates.filter((index) => baseSect(rankRows[index].sectName) === baseSect(entry.value))
    if (matched.length !== 1) { incomplete = true; return }
    const team = result.teams[matched[0]]
    team.roundCount += player.totalRound
    if (result.dayMode) {
      team.days = Math.ceil(team.roundCount / 3)
      team.avg = round2(team.totalPoint / team.days)
    } else {
      team.games = team.roundCount
      team.avg = round2(team.totalPoint / team.games)
    }
  })
  result.incomplete = incomplete
  return result
}

async function latestSect(playerId, season, zone) {
  const key = [season, zone, playerId].join('|')
  if (latestSectCache.has(key)) return latestSectCache.get(key)
  const payload = await requestWithRetry('/stats/players/games/' + encodeURIComponent(playerId) + '/details?' + query({
    page: 1, size: 1, zone_id: zone, season_id: season,
  }))
  const value = (rows(payload)[0] || {}).sect_name || ''
  latestSectCache.set(key, value)
  return value
}

async function eventTeam(season, type, zone, team) {
  const key = scopeKey(season, type, zone) + '|' + team.sectId
  if (teamCache.has(key)) return teamCache.get(key)
  const [players, detailResult, rosterResult] = await Promise.all([
    eventPlayers(season, type, zone),
    request('/werewolves/sects/' + encodeURIComponent(team.sectId)).then((value) => ({ value, error: null })).catch((error) => ({ value: null, error })),
    request('/settings/players?sect_id=' + encodeURIComponent(team.sectId)).then((value) => ({ value, error: null })).catch((error) => ({ value: null, error })),
  ])
  if (detailResult.error) console.error('Optional event team detail unavailable', { sectId: team.sectId })
  if (rosterResult.error) console.error('Optional event team roster unavailable', { sectId: team.sectId })
  const detail = detailResult.value && detailResult.value.data && !Array.isArray(detailResult.value.data)
    ? detailResult.value.data : (detailResult.value || {})
  const rosterLabels = new Map(optionRows(rosterResult.value).map((item) => [String(item.value), item.label]))
  const candidates = players.filter((player) => player.sectIds.includes(Number(team.sectId)))
    .map((player) => ({ ...player, playerName: rosterLabels.get(String(player.playerId)) || player.playerName }))
  const wanted = new Set([team.sectName, detail.name].map(baseSect).filter(Boolean))
  const fetched = await mapLimit(candidates, 8, (player) => fetchEventGames(player.playerId, season, type, zone))
  let incomplete = false
  let checked = 0
  let firstError = null
  const members = []
  fetched.forEach((result, index) => {
    if (result.error) {
      incomplete = true
      if (!firstError) firstError = result.error
      return
    }
    checked += 1
    const player = candidates[index]
    const matched = (result.value || []).filter((game) => (
      String(game.season_id) === String(season)
      && String(game.season_type_id) === String(type)
      && wanted.has(baseSect(game.sect_name))
    ))
    if (!matched.length) return
    const totalPoint = round2(matched.reduce((sum, game) => sum + numeric(game.total_point), 0))
    const count = (field) => matched.filter((game) => numeric(game[field]) === 1).length
    members.push({
      playerId: player.playerId, playerName: player.playerName, games: matched.length,
      totalPoint, avg: round2(totalPoint / matched.length),
      win: Math.round(count('win') / matched.length * 100), mvp: count('mvp'), svp: count('svp'), bgx: count('bgx'),
    })
  })
  if (!checked && firstError) throw firstError
  members.sort((a, b) => b.totalPoint - a.totalPoint || lexical(a.playerName, b.playerName))
  const chief = detail.chief && typeof detail.chief === 'object'
    ? (detail.chief.name || detail.chief.label || '') : String(detail.chief || '')
  const value = { name: detail.name || team.sectName, chief, members, incomplete }
  teamCache.set(key, value)
  return value
}

function requestWithRetry(path) {
  return shared.retry(() => request(path), { delays: [300, 900] })
}

function matchesEvent(game, season, type) {
  return game && game.season_id != null
    && String(game.season_id) === String(season)
    && String(game.season_type_id) === String(type)
}

async function fullZoneGames(playerId, zone) {
  const all = []
  for (let page = 1; page <= 200; page += 1) {
    const payload = await requestWithRetry('/stats/players/games/' + encodeURIComponent(playerId) + '/details?' + query({
      page, size: 100, zone_id: zone,
    }))
    const current = rows(payload)
    all.push(...current)
    const body = payload && payload.data && !Array.isArray(payload.data) ? payload.data : payload
    if (current.length < 100 || (body && body.total_items != null && all.length >= Number(body.total_items))) break
    if (page === 200) throw new Error('逐场数据过多，无法完整读取。')
  }
  return all
}

async function fetchEventGames(playerId, season, type, zone) {
  const path = '/stats/players/games/' + encodeURIComponent(playerId) + '/details?' + query({
    page: 1, size: 100, zone_id: zone, season_id: season, season_type_id: type,
  })
  const payload = await requestWithRetry(path)
  const current = rows(payload)
  const body = payload && payload.data && !Array.isArray(payload.data) ? payload.data : payload
  const total = body && body.total_items != null ? Number(body.total_items) : current.length
  const scoped = total <= current.length && current.every((game) => game.season_id != null && String(game.season_id) === String(season))
  if (scoped) return current.filter((game) => matchesEvent(game, season, type))
  return (await fullZoneGames(playerId, zone)).filter((game) => matchesEvent(game, season, type))
}

async function mapLimit(source, limit, handler) {
  return shared.mapLimitSettled(source, limit, handler)
}

async function drawTool(season, type, zone, progress) {
  const key = scopeKey(season, type, zone)
  if (drawCache.has(key)) return drawCache.get(key)
  const [rankRows, playerRows] = await Promise.all([rankings(season, type, zone), eventPlayers(season, type, zone)])
  if (rankRows.length !== 12) throw new Error('该赛事不是 12 支门派，无法进行抽局模拟。')
  const seen = new Set()
  const participants = playerRows.filter((player) => {
    if (!player.playerId || player.totalRound <= 0 || seen.has(player.playerId)) return false
    seen.add(player.playerId)
    return true
  })
  let done = 0
  const fetched = await mapLimit(participants, 8, async (player) => {
    const value = await fetchEventGames(player.playerId, season, type, zone)
    done += 1
    if (typeof progress === 'function') progress(done, participants.length)
    return value
  })
  const data = buildDrawData(rankRows, participants, fetched, season, type, zone)
  if (data.simulationReady) drawCache.set(key, data)
  return data
}

module.exports = {
  ZONES,
  availableSeasons,
  availableTypes,
  catalog,
  drawTool,
  eventMetrics,
  eventPlayers,
  eventTeam,
  fetchEventGames,
  metricsFor,
  rankings,
  round2,
}
