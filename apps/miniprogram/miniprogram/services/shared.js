const WOLF_ROLES = new Set(['石像鬼', '血月使徒', '梦魇'])

function round2(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  return Math.sign(number) * Math.round(Math.abs(number) * 100) / 100
}

function numeric(value) {
  if (value === true) return 1
  if (value === false || value == null || value === '') return 0
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

function lexical(left, right) {
  const a = String(left || '')
  const b = String(right || '')
  return a < b ? -1 : (a > b ? 1 : 0)
}

function retryable(error) {
  return Boolean(error) && error.code !== 'TOKEN_EXPIRED'
    && (error.code === 'NETWORK_ERROR' || error.statusCode === 429 || error.statusCode >= 500)
}

async function retry(operation, options) {
  const delays = Array.isArray(options && options.delays) ? options.delays : []
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation(attempt)
    } catch (error) {
      if (!retryable(error) || attempt >= delays.length) throw error
      const delay = Math.max(0, Number(delays[attempt]) || 0)
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
}

function isGoodCamp(role) {
  const name = String(role || '')
  return !name.includes('狼') && !WOLF_ROLES.has(name)
}

function rows(payload) {
  if (Array.isArray(payload)) return payload
  if (payload && Array.isArray(payload.items)) return payload.items
  if (payload && payload.data && Array.isArray(payload.data.items)) return payload.data.items
  return []
}

function unwrap(payload) {
  if (payload && payload.data && !Array.isArray(payload.data)) return payload.data
  return payload || {}
}

async function mapLimit(source, limit, handler) {
  const items = source || []
  const result = new Array(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const index = next
      next += 1
      result[index] = await handler(items[index], index)
    }
  }
  const workers = []
  for (let index = 0; index < Math.min(Math.max(1, limit || 1), items.length); index += 1) workers.push(worker())
  await Promise.all(workers)
  return result
}

async function mapLimitSettled(source, limit, handler) {
  return mapLimit(source, limit, async (item, index) => {
    try {
      return { value: await handler(item, index), error: null }
    } catch (error) {
      return { value: null, error }
    }
  })
}

function sameData(left, right) {
  if (left === right) return true
  if (left == null || right == null || typeof left !== 'object' || typeof right !== 'object') return false
  try {
    return JSON.stringify(left) === JSON.stringify(right)
  } catch (_) {
    return false
  }
}

function setDataDiff(page, values, callback) {
  const changed = {}
  Object.keys(values || {}).forEach((key) => {
    if (!sameData(page.data && page.data[key], values[key])) changed[key] = values[key]
  })
  if (Object.keys(changed).length) page.setData(changed, callback)
  else if (typeof callback === 'function') callback()
}

module.exports = {
  WOLF_ROLES,
  isGoodCamp,
  lexical,
  mapLimit,
  mapLimitSettled,
  numeric,
  retry,
  round2,
  rows,
  setDataDiff,
  unwrap,
}
