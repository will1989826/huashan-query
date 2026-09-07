const STORAGE_PREFIX = 'huashan-draw-projections:'

function storageKey(zone, season, type) {
  return STORAGE_PREFIX + [zone || 'SH', season || '', type || ''].join(':')
}

function merge(data, saved) {
  const result = {}
  ;((data && data.games) || []).forEach((game) => {
    if (game.complete) return
    const row = (saved && (saved[String(game.index)] || saved[game.index])) || {}
    ;((data && data.teams) || []).forEach((team) => {
      const raw = row[String(team.sectId)] != null ? row[String(team.sectId)] : row[team.sectId]
      if (raw == null || raw === '' || !Number.isFinite(Number(raw))) return
      if (!result[game.index]) result[game.index] = {}
      result[game.index][team.sectId] = Number(raw)
    })
  })
  return result
}

function load(data) {
  if (!data) return {}
  try {
    return merge(data, wx.getStorageSync(storageKey(data.zone, data.season, data.seasonType)) || {})
  } catch (_) {
    return {}
  }
}

function save(data, projections) {
  if (!data) return
  try {
    wx.setStorageSync(storageKey(data.zone, data.season, data.seasonType), projections || {})
  } catch (_) {}
}

module.exports = { STORAGE_PREFIX, load, merge, save, storageKey }
