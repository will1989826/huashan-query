const ZONES = [
  ['ALL', '全部赛区'], ['SH', '上海赛区'], ['BJ', '北京赛区'], ['XM', '厦门赛区'], ['HSXM', '厦门赛区'],
  ['HSGZ', '广州赛区'], ['HSHZ', '杭州赛区'], ['SD', '山东赛区'], ['WH', '武汉赛区'],
  ['CQ', '重庆赛区'], ['NJ', '南京赛区'], ['HF', '安徽赛区'], ['CS', '长沙赛区'],
  ['XA', '西安赛区'], ['NC', '南昌赛区'], ['RANK', '杭州 Rank'], ['HSYXS', '华山英雄赛'],
  ['HZYC', '杭州羊村英雄赛'], ['GZHSYXS', '广州华山英雄赛'], ['HZHSYXS', '杭州英雄赛'],
  ['HSGRS', '华山个人赛'], ['SDGRS', '山东个人赛'],
]
const ZONE_NAMES = new Map(ZONES)

function zoneName(code, joined) {
  const value = String(code || '')
  const match = (joined || []).find((item) => String(item && item.ordering) === value)
  return (match && match.text) || ZONE_NAMES.get(value) || value
}

function honorZoneName(code, joined) {
  return zoneName(code, joined).replace(/赛区$/, '')
}

function resolveZone(value, joined) {
  const text = String(value || '').trim()
  if (!text || text === '全部赛区') return 'ALL'
  const match = (joined || []).find((item) => item && (item.text === text || String(item.ordering) === text))
  if (match) return String(match.ordering)
  const zone = ZONES.find(([code, label]) => code === text || label === text)
  return zone ? zone[0] : 'ALL'
}

function zoneOptions(joined, includeAll) {
  const result = includeAll === false ? [] : [{ value: 'ALL', label: '全部赛区' }]
  const seen = new Set(result.map((item) => item.value))
  ;(joined || []).forEach((item) => {
    const value = String(item && item.ordering || '')
    if (!value || seen.has(value)) return
    seen.add(value)
    result.push({ value, label: item.text || zoneName(value) })
  })
  return result
}

module.exports = { ZONES, honorZoneName, resolveZone, zoneName, zoneOptions }
