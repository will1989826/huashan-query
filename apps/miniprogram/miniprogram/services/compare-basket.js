const MAX = 12

let basket = []

function normalize(player) {
  const source = player || {}
  const playerId = String(source.playerId != null ? source.playerId : (source.id || '')).trim()
  if (!playerId) return null
  return {
    playerId,
    name: source.name || ('#' + playerId),
    avatar: source.avatar || '',
    sect: source.sect || '暂无门派信息',
  }
}

function items() {
  return basket.map((player) => ({ ...player }))
}

function count() {
  return basket.length
}

function has(playerId) {
  const id = String(playerId || '')
  return basket.some((player) => player.playerId === id)
}

function add(player) {
  const normalized = normalize(player)
  if (!normalized || has(normalized.playerId) || basket.length >= MAX) return false
  basket.push(normalized)
  return true
}

function addMany(players) {
  let added = 0
  ;(players || []).forEach((player) => {
    if (add(player)) added += 1
  })
  return added
}

function remove(playerId) {
  const id = String(playerId || '')
  const next = basket.filter((player) => player.playerId !== id)
  const changed = next.length !== basket.length
  basket = next
  return changed
}

function clear() {
  basket = []
}

module.exports = { MAX, add, addMany, clear, count, has, items, remove }
