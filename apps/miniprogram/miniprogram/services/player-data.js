const { request } = require('./request')
const shared = require('./shared')
const tokenStore = require('./token')

const GAMES_PAGE_SIZE = 100
const GAMES_MAX_PAGES = 200
const GAMES_WORKERS = 4
const STATS_CACHE_LIMIT = 20
const GAMES_CACHE_LIMIT = 16
const GAME_CACHE_LIMIT = 30
const statsCache = new Map()
const gamesCache = new Map()
const gameCache = new Map()
const statsPending = new Map()
const gamesPending = new Map()
const gamePending = new Map()
const playerRequestTasks = new Map()
let cacheGeneration = 0

async function validateToken(raw) {
  const token = tokenStore.normalizeToken(raw)
  if (!token) {
    throw new Error('请输入完整的 Token。')
  }
  if (!tokenStore.isCompactJWT(token)) {
    throw new Error('Token 似乎没有粘贴完整，请重新复制后粘贴。')
  }
  clearDataCache()
  tokenStore.setToken(token)
  try {
    const profile = await request('/user/profile')
    if (!profile || (!profile.player_id && !profile.nickname)) {
      throw new Error('华山服务器返回了无法识别的账号信息。')
    }
    tokenStore.setProfile(profile)
    return profile
  } catch (error) {
    tokenStore.clearSession()
    throw error
  }
}

function searchPlayers(name) {
  const query = encodeURIComponent(String(name || '').trim())
  return request('/stats/club-players?page=1&size=30&player_name=' + query, { auth: false })
}

async function searchPlayerById(playerId) {
  const id = String(playerId || '').trim()
  if (!/^\d+$/.test(id)) {
    const error = new Error('ID 需为纯数字；要按名字找人请切到“按名字”。')
    error.code = 'INVALID_PLAYER_ID'
    throw error
  }
  const stats = objectPayload(await playerStats(id))
  const player = stats.player || {}
  if (!player.name) {
    const error = new Error('没有找到这个选手 ID。')
    error.code = 'PLAYER_NOT_FOUND'
    throw error
  }
  const summary = stats.summary || {}
  return {
    playerId: id,
    name: player.name,
    avatar: player.avatar || '',
    sect: '暂无门派信息',
    point: summary.total_point == null ? '' : String(summary.total_point),
  }
}

function cacheGet(cache, key) {
  if (!cache.has(key)) return undefined
  const value = cache.get(key)
  cache.delete(key)
  cache.set(key, value)
  return value
}

function cacheSet(cache, key, value, limit) {
  cache.delete(key)
  cache.set(key, value)
  while (cache.size > limit) cache.delete(cache.keys().next().value)
}

function normalizedScope(scope) {
  const source = scope || {}
  const zone = String(source.zone || 'ALL').trim() || 'ALL'
  const season = String(source.season || '').replace(/^S/i, '').trim()
  return { zone, season }
}

function playerKey(playerId, scope, includeSeason) {
  const selected = normalizedScope(scope)
  return [String(playerId || '').trim(), selected.zone, includeSeason ? selected.season : ''].join('|')
}

function trackPlayerRequest(playerId, task) {
  const key = String(playerId || '').trim()
  if (!task || typeof task.abort !== 'function') return task
  if (!playerRequestTasks.has(key)) playerRequestTasks.set(key, new Set())
  const tasks = playerRequestTasks.get(key)
  tasks.add(task)
  const cleanup = () => {
    tasks.delete(task)
    if (!tasks.size) playerRequestTasks.delete(key)
  }
  task.then(cleanup, cleanup)
  return task
}

function cancelPlayerRequests(playerId) {
  const id = String(playerId || '').trim()
  const prefix = id + '|'
  cacheGeneration += 1
  ;(playerRequestTasks.get(id) || []).forEach((task) => task.abort())
  playerRequestTasks.delete(id)
  ;[statsPending, gamesPending].forEach((cache) => {
    ;[...cache.keys()].forEach((key) => {
      if (key.startsWith(prefix)) cache.delete(key)
    })
  })
}

function clearPlayerDataCache(playerId) {
  const prefix = String(playerId || '').trim() + '|'
  cancelPlayerRequests(playerId)
  ;[statsCache, gamesCache].forEach((cache) => {
    ;[...cache.keys()].forEach((key) => {
      if (key.startsWith(prefix)) cache.delete(key)
    })
  })
}

function clearDataCache() {
  cacheGeneration += 1
  playerRequestTasks.forEach((tasks) => tasks.forEach((task) => task.abort()))
  playerRequestTasks.clear()
  statsCache.clear()
  gamesCache.clear()
  gameCache.clear()
  statsPending.clear()
  gamesPending.clear()
  gamePending.clear()
}

function playerStats(playerId, scope) {
  const selected = normalizedScope(scope)
  const key = playerKey(playerId, selected, true)
  const cached = cacheGet(statsCache, key)
  if (cached !== undefined) return Promise.resolve(cached)
  if (statsPending.has(key)) return statsPending.get(key)
  const id = encodeURIComponent(String(playerId || '').trim())
  const generation = cacheGeneration
  let path = '/stats/games/players/' + id + '?zone_id=' + encodeURIComponent(selected.zone) + '&leagueTier=1'
  if (selected.season) path += '&season_id=' + encodeURIComponent(selected.season)
  const requestTask = trackPlayerRequest(playerId, request(path))
  const pending = requestTask
    .then((payload) => {
      if (generation === cacheGeneration) cacheSet(statsCache, key, payload, STATS_CACHE_LIMIT)
      return payload
    })
    .finally(() => {
      if (statsPending.get(key) === pending) statsPending.delete(key)
    })
  statsPending.set(key, pending)
  pending.abort = requestTask.abort
  return pending
}

function playerGamesPage(playerId, page, scope) {
  const id = encodeURIComponent(String(playerId || '').trim())
  const pageNumber = Math.max(1, Number(page) || 1)
  const selected = normalizedScope(scope)
  let path = '/stats/players/games/' + id + '/details?page=' + pageNumber + '&size=' + GAMES_PAGE_SIZE
  if (selected.zone !== 'ALL') path += '&zone_id=' + encodeURIComponent(selected.zone)
  return trackPlayerRequest(playerId, request(path))
}

function playerGame(gameId) {
  const key = String(gameId || '').trim()
  const cached = cacheGet(gameCache, key)
  if (cached !== undefined) return Promise.resolve(cached)
  if (gamePending.has(key)) return gamePending.get(key)
  const generation = cacheGeneration
  const pending = request('/werewolves/games/' + encodeURIComponent(key))
    .then((payload) => {
      if (generation === cacheGeneration) cacheSet(gameCache, key, payload, GAME_CACHE_LIMIT)
      return payload
    })
    .finally(() => {
      if (gamePending.get(key) === pending) gamePending.delete(key)
    })
  gamePending.set(key, pending)
  return pending
}

function searchItems(payload) {
  return shared.rows(payload)
}

function objectPayload(payload) {
  return shared.unwrap(payload)
}

function gamesPageInfo(payload) {
  const body = objectPayload(payload)
  const rawTotal = body && body.total_items
  const totalKnown = rawTotal != null && rawTotal !== '' && Number.isFinite(Number(rawTotal))
  return {
    items: searchItems(payload),
    total: totalKnown ? Math.max(0, Number(rawTotal)) : 0,
    totalKnown,
  }
}

function playerGamesPageWithRetry(playerId, page, scope) {
  return shared.retry(() => playerGamesPage(playerId, page, scope), { delays: [250, 700] })
}

function notify(callback, value) {
  if (typeof callback === 'function') callback(value)
}

async function fetchAllPlayerGames(playerId, callbacks, scope) {
  const events = callbacks || {}
  const firstPayload = await playerGamesPageWithRetry(playerId, 1, scope)
  const first = gamesPageInfo(firstPayload)
  notify(events.onFirstPage, first)

  if (!first.totalKnown) {
    const items = first.items.slice()
    const failedPages = []
    let loadedPages = 1
    let truncated = false
    while (first.items.length === GAMES_PAGE_SIZE && loadedPages < GAMES_MAX_PAGES) {
      const page = loadedPages + 1
      let payload
      try {
        payload = await playerGamesPageWithRetry(playerId, page, scope)
      } catch (error) {
        if (error && error.code === 'TOKEN_EXPIRED') throw error
        failedPages.push(page)
        truncated = true
        break
      }
      const current = gamesPageInfo(payload).items
      items.push(...current)
      loadedPages = page
      notify(events.onProgress, {
        loadedItems: items.length,
        loadedPages,
        total: 0,
        totalKnown: false,
        totalPages: 0,
      })
      if (current.length < GAMES_PAGE_SIZE) break
    }
    const limitReached = loadedPages >= GAMES_MAX_PAGES && items.length >= GAMES_PAGE_SIZE * GAMES_MAX_PAGES
    if (limitReached) truncated = true
    return { items, total: items.length, totalKnown: false, truncated, failedPages, limitReached }
  }

  const expectedPages = Math.ceil(first.total / GAMES_PAGE_SIZE)
  const totalPages = Math.max(1, Math.min(expectedPages, GAMES_MAX_PAGES))
  const results = new Array(totalPages)
  results[0] = first.items
  const failedPages = []
  let nextPage = 2
  let loadedItems = first.items.length
  let loadedPages = 1
  let authError = null

  async function worker() {
    while (!authError) {
      const page = nextPage
      nextPage += 1
      if (page > totalPages) return
      try {
        const payload = await playerGamesPageWithRetry(playerId, page, scope)
        const current = gamesPageInfo(payload).items
        results[page - 1] = current
        loadedItems += current.length
      } catch (error) {
        if (error && error.code === 'TOKEN_EXPIRED') {
          authError = error
          return
        }
        failedPages.push(page)
        results[page - 1] = []
      }
      loadedPages += 1
      notify(events.onProgress, {
        loadedItems,
        loadedPages,
        total: first.total,
        totalKnown: true,
        totalPages,
      })
    }
  }

  const workers = []
  const workerCount = Math.min(GAMES_WORKERS, Math.max(0, totalPages - 1))
  for (let index = 0; index < workerCount; index += 1) workers.push(worker())
  await Promise.all(workers)
  if (authError) throw authError

  const items = results.flat()
  const truncated = expectedPages > GAMES_MAX_PAGES
    || failedPages.length > 0
    || items.length !== first.total
  return {
    items,
    total: first.total,
    totalKnown: true,
    truncated,
    failedPages,
    limitReached: expectedPages > GAMES_MAX_PAGES,
  }
}

function filterGamesScope(result, scope) {
  const selected = normalizedScope(scope)
  const seasons = result.seasonCandidates || [...new Set((result.items || []).map((game) => Number(game && game.season_id)).filter(Number.isFinite))]
    .sort((a, b) => b - a)
  const normalized = result.seasonCandidates ? result : { ...result, seasonCandidates: seasons }
  if (!selected.season) return normalized
  return {
    ...normalized,
    items: (result.items || []).filter((game) => String(game && game.season_id) === selected.season),
  }
}

function loadAllPlayerGames(playerId, callbacks, scope) {
  const selected = normalizedScope(scope)
  const key = playerKey(playerId, selected, false)
  const cached = cacheGet(gamesCache, key)
  if (cached !== undefined) return Promise.resolve(filterGamesScope(cached, selected))
  if (gamesPending.has(key)) return gamesPending.get(key).then((result) => filterGamesScope(result, selected))
  const generation = cacheGeneration
  const pending = fetchAllPlayerGames(playerId, callbacks, selected)
    .then((result) => {
      const normalized = filterGamesScope(result, { zone: selected.zone })
      if (generation === cacheGeneration) cacheSet(gamesCache, key, normalized, GAMES_CACHE_LIMIT)
      return normalized
    })
    .finally(() => {
      if (gamesPending.get(key) === pending) gamesPending.delete(key)
    })
  gamesPending.set(key, pending)
  return pending.then((result) => filterGamesScope(result, selected))
}

module.exports = {
  GAMES_MAX_PAGES,
  GAMES_PAGE_SIZE,
  cancelPlayerRequests,
  clearDataCache,
  clearPlayerDataCache,
  gamesPageInfo,
  loadAllPlayerGames,
  playerGame,
  playerGamesPage,
  playerStats,
  searchItems,
  searchPlayerById,
  searchPlayers,
  validateToken,
}
