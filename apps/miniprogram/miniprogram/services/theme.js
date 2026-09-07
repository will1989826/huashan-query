const STORAGE_KEY = 'huashan-display-theme'

const THEMES = [
  {
    id: 'dark',
    name: '青崖夜',
    kind: '深色',
    desc: '青黑底色与薄荷高光，适合夜间查看。',
    navBackground: '#0b1515',
    navText: 'white',
  },
  {
    id: 'light',
    name: '朱砂笺',
    kind: '浅色',
    desc: '暖纸底色与朱砂强调，清爽柔和。',
    navBackground: '#f3ede2',
    navText: 'black',
  },
  {
    id: 'yulehui',
    name: '鱼乐会',
    englishName: 'YULEHUI CLUB',
    kind: '战队',
    template: 'team',
    matchNames: ['鱼乐会'],
    desc: '队服白、海军蓝与皇家蓝，金色点睛。',
    crest: '/assets/yulehui-crest.png',
    navBackground: '#f2f6fc',
    navText: 'black',
  },
  {
    id: 'jinfeng-xiyulou',
    name: '金风细雨楼',
    englishName: 'JINFENG XIYULOU',
    kind: '战队',
    template: 'team',
    matchNames: ['金风细雨楼'],
    desc: '队服白与藏青渐变，天青和金色点缀。',
    crest: '/assets/jinfeng-xiyulou-crest.png',
    navBackground: '#f2f5f8',
    navText: 'black',
  },
]

function find(id) {
  return THEMES.find((theme) => theme.id === String(id || '')) || null
}

function current() {
  try {
    return find(wx.getStorageSync(STORAGE_KEY)) || THEMES[0]
  } catch (_) {
    return THEMES[0]
  }
}

function applyNavigationBar(theme) {
  if (!theme || typeof wx === 'undefined' || typeof wx.setNavigationBarColor !== 'function') return
  wx.setNavigationBarColor({
    backgroundColor: theme.navBackground,
    frontColor: theme.navText === 'black' ? '#000000' : '#ffffff',
  })
  if (typeof wx.setBackgroundColor === 'function') {
    wx.setBackgroundColor({
      backgroundColor: theme.navBackground,
      backgroundColorBottom: theme.navBackground,
      backgroundColorTop: theme.navBackground,
    })
  }
}

function pageData() {
  const theme = current()
  applyNavigationBar(theme)
  return {
    theme: theme.id,
    themeCrest: theme.crest || '',
    themeName: theme.name,
    themeEnglishName: theme.englishName || '',
    teamTheme: theme.template === 'team',
  }
}

function select(id) {
  const theme = find(id)
  if (!theme) return null
  try {
    wx.setStorageSync(STORAGE_KEY, theme.id)
  } catch (_) {}
  applyNavigationBar(theme)
  return theme
}

function runtimeDetails() {
  const details = {}
  try {
    const system = wx.getSystemInfoSync()
    details.platform = system.platform || ''
    details.system = system.system || ''
    details.wechatVersion = system.version || ''
    details.SDKVersion = system.SDKVersion || ''
  } catch (_) {}
  try {
    const account = wx.getAccountInfoSync()
    details.environment = account.miniProgram && account.miniProgram.envVersion || ''
    details.appVersion = account.miniProgram && account.miniProgram.version || ''
  } catch (_) {}
  return details
}

function crestEventDetails(event) {
  const currentTarget = event && event.currentTarget || {}
  const dataset = currentTarget.dataset || {}
  const detail = event && event.detail || {}
  let route = ''
  try {
    const pages = getCurrentPages()
    route = pages.length ? pages[pages.length - 1].route || '' : ''
  } catch (_) {}
  return {
    route,
    kind: String(dataset.crestKind || 'unknown'),
    src: String(dataset.crestSrc || currentTarget.src || ''),
    theme: current().id,
    width: Number(detail.width) || 0,
    height: Number(detail.height) || 0,
    errMsg: String(detail.errMsg || ''),
    ...runtimeDetails(),
  }
}

function onCrestImageLoad(event) {
  console.info('Crest image loaded', crestEventDetails(event))
}

function onCrestImageError(event) {
  console.error('Crest image load failed', crestEventDetails(event))
}

function logCrestRuntime() {
  console.info('Crest diagnostics initialized', {
    ...runtimeDetails(),
    assets: THEMES.filter((theme) => theme.crest).map((theme) => ({
      id: theme.id,
      src: theme.crest,
    })),
  })
}

module.exports = {
  STORAGE_KEY,
  THEMES,
  current,
  find,
  logCrestRuntime,
  onCrestImageError,
  onCrestImageLoad,
  pageData,
  select,
}
