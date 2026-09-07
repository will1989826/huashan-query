const themeStore = require('./theme')

const STORAGE_PREFIX = 'huashan-profile-crest:'

function baseTeamName(name) {
  return String(name || '')
    .trim()
    .replace(/[（(][^（()）]*[）)]\s*$/, '')
    .trim()
    .toLocaleLowerCase()
}

function candidates(teamNames) {
  const wanted = new Set((teamNames || []).map(baseTeamName).filter(Boolean))
  return themeStore.THEMES.filter((theme) => (
    theme.template === 'team'
    && (theme.matchNames || [theme.name]).some((name) => wanted.has(baseTeamName(name)))
  ))
}

function load(playerId) {
  try {
    return wx.getStorageSync(STORAGE_PREFIX + String(playerId || '')) || ''
  } catch (_) {
    return ''
  }
}

function save(playerId, choice) {
  try {
    wx.setStorageSync(STORAGE_PREFIX + String(playerId || ''), String(choice || ''))
  } catch (_) {}
}

function resolve(items, choice) {
  if (choice === 'none') return null
  const selected = (items || []).find((theme) => theme.id === choice)
  if (selected) return selected
  return (items || []).length === 1 ? items[0] : null
}

module.exports = { STORAGE_PREFIX, baseTeamName, candidates, load, resolve, save }
