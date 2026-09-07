const data = require('./rules-data')

function normalized(value) {
  return String(value || '').toLowerCase().replace(/[\s·，。、“”‘’：；（）()/_-]+/g, '')
}

function textOf(value) {
  if (Array.isArray(value)) return value.map(textOf).join(' ')
  if (value && typeof value === 'object') return Object.keys(value).map((key) => textOf(value[key])).join(' ')
  return String(value == null ? '' : value)
}

function search(query) {
  const term = normalized(query)
  if (!term) return []
  return data.RULE_ARTICLES.map((item) => {
    let score = 0
    const title = normalized(item.title)
    if (title === term) score += 100
    if (title.includes(term)) score += 50
    if (normalized(item.keywords.join(' ')).includes(term)) score += 25
    if (normalized(item.summary + ' ' + textOf(item.blocks)).includes(term)) score += 10
    return { item, score }
  }).filter((hit) => hit.score > 0).sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title, 'zh-CN'))
    .map((hit) => hit.item)
}

function articleView(item) {
  if (!item) return null
  return {
    ...item,
    blocks: item.blocks.map((block) => ({
      ...block,
      rows: block.rows || [],
      pairs: block.items && ['facts', 'formula'].includes(block.type)
        ? block.items.map((pair) => ({ term: pair[0], description: pair[1] })) : [],
      list: block.items && ['list', 'steps'].includes(block.type)
        ? block.items.map((text, index) => ({ index: index + 1, text })) : [],
    })),
  }
}

module.exports = { ...data, articleView, normalized, search }
