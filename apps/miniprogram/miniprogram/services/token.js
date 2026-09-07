let currentToken = ''
let currentProfile = null

function normalizeToken(raw) {
  let token = String(raw || '').trim()
  if (/^Bearer$/i.test(token)) return ''
  token = token.replace(/^Bearer\s+/i, '').trim()
  if (!token || token.length > 32 * 1024 || /\s/.test(token)) return ''
  return token
}

function isCompactJWT(token) {
  const periods = (String(token || '').match(/\./g) || []).length
  return periods === 2 || periods === 4
}

function setToken(raw) {
  const token = normalizeToken(raw)
  if (!token) return false
  currentToken = token
  currentProfile = null
  return true
}

function getToken() {
  return currentToken
}

function hasToken() {
  return currentToken !== ''
}

function setProfile(profile) {
  currentProfile = profile || null
}

function getProfile() {
  return currentProfile
}

function clearSession() {
  currentToken = ''
  currentProfile = null
}

module.exports = {
  clearSession,
  getProfile,
  getToken,
  hasToken,
  isCompactJWT,
  normalizeToken,
  setProfile,
  setToken,
}
