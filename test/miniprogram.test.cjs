const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const test = require('node:test')

const tokenStore = require('../apps/miniprogram/miniprogram/services/token.js')
const huashan = require('../apps/miniprogram/miniprogram/services/huashan.js')
const replay = require('../apps/miniprogram/miniprogram/services/replay.js')
const compare = require('../apps/miniprogram/miniprogram/services/compare.js')
const compareBasket = require('../apps/miniprogram/miniprogram/services/compare-basket.js')
const themeStore = require('../apps/miniprogram/miniprogram/services/theme.js')
const profileCrest = require('../apps/miniprogram/miniprogram/services/profile-crest.js')
const events = require('../apps/miniprogram/miniprogram/services/events.js')
const drawProjections = require('../apps/miniprogram/miniprogram/services/draw-projections.js')
const rules = require('../apps/miniprogram/miniprogram/services/rules.js')
const shared = require('../apps/miniprogram/miniprogram/services/shared.js')
const zone = require('../apps/miniprogram/miniprogram/services/zone.js')

test('Mini Program service facades keep requests separate from pure models', () => {
  const playerFacade = readFileSync('./apps/miniprogram/miniprogram/services/huashan.js', 'utf8')
  const playerData = readFileSync('./apps/miniprogram/miniprogram/services/player-data.js', 'utf8')
  const playerModel = readFileSync('./apps/miniprogram/miniprogram/services/player-model.js', 'utf8')
  const eventFacade = readFileSync('./apps/miniprogram/miniprogram/services/events.js', 'utf8')
  const eventModel = readFileSync('./apps/miniprogram/miniprogram/services/event-model.js', 'utf8')
  assert.match(playerFacade, /player-data/)
  assert.match(playerFacade, /player-model/)
  assert.doesNotMatch(playerData, /require\('\.\/player-model'\)/)
  assert.doesNotMatch(playerModel, /require\('\.\/request'\)|Cache|Pending/)
  assert.match(eventFacade, /event-data/)
  assert.match(eventFacade, /event-model/)
  assert.doesNotMatch(eventModel, /require\('\.\/request'\)|Cache|Pending/)
})

test('Mini Program shared retry handles transient failures only', async () => {
  let attempts = 0
  const value = await shared.retry(async () => {
    attempts += 1
    if (attempts < 3) throw Object.assign(new Error('temporary'), { code: 'NETWORK_ERROR' })
    return 'ok'
  }, { delays: [0, 0] })
  assert.equal(value, 'ok')
  assert.equal(attempts, 3)

  attempts = 0
  await assert.rejects(shared.retry(async () => {
    attempts += 1
    throw Object.assign(new Error('expired'), { code: 'TOKEN_EXPIRED' })
  }, { delays: [0, 0] }), { code: 'TOKEN_EXPIRED' })
  assert.equal(attempts, 1)
})

test('Mini Program Token normalization accepts raw and Bearer forms without persisting', () => {
  tokenStore.clearSession()
  assert.equal(tokenStore.normalizeToken('  abc.def.ghi  '), 'abc.def.ghi')
  assert.equal(tokenStore.normalizeToken('Bearer abc.def.ghi'), 'abc.def.ghi')
  assert.equal(tokenStore.normalizeToken('Bearer'), '')
  assert.equal(tokenStore.normalizeToken('abc def'), '')
  assert.equal(tokenStore.isCompactJWT('abc.def.ghi'), true)
  assert.equal(tokenStore.isCompactJWT('abc.def'), false)
  assert.equal(tokenStore.isCompactJWT('a.b.c.d.e'), true)
  assert.equal(tokenStore.setToken('abc.def.ghi'), true)
  assert.equal(tokenStore.getToken(), 'abc.def.ghi')
  tokenStore.clearSession()
  assert.equal(tokenStore.hasToken(), false)
})

test('Mini Program Token input does not use the 140-character default limit', () => {
  const input = readFileSync(
    './apps/miniprogram/miniprogram/pages/session/index.wxml',
    'utf8',
  )
  assert.match(input, /class="token-input"[\s\S]*maxlength="-1"/)
})

test('Mini Program themes match desktop choices and persist only the selected theme id', () => {
  const previousWx = global.wx
  const storage = new Map()
  const navigation = []
  global.wx = {
    getStorageSync(key) { return storage.get(key) || '' },
    setStorageSync(key, value) { storage.set(key, value) },
    setNavigationBarColor(options) { navigation.push(options) },
    setBackgroundColor() {},
  }
  try {
    assert.deepEqual(themeStore.THEMES.map((theme) => theme.name), [
      '青崖夜', '朱砂笺', '鱼乐会', '金风细雨楼',
    ])
    assert.equal(themeStore.current().id, 'dark')
    assert.equal(themeStore.select('yulehui').id, 'yulehui')
    assert.equal(storage.size, 1)
    assert.equal(storage.get(themeStore.STORAGE_KEY), 'yulehui')
    assert.deepEqual(themeStore.pageData(), {
      theme: 'yulehui',
      themeCrest: '/assets/yulehui-crest.png',
      themeName: '鱼乐会',
      themeEnglishName: 'YULEHUI CLUB',
      teamTheme: true,
    })
    assert.equal(navigation.at(-1).frontColor, '#000000')
    assert.equal(themeStore.select('missing'), null)
    const styles = readFileSync('./apps/miniprogram/miniprogram/app.wxss', 'utf8')
    for (const id of ['dark', 'light', 'yulehui', 'jinfeng-xiyulou']) {
      assert.match(styles, new RegExp('\\.theme-' + id + '\\s*\\{'))
    }
    assert.ok(readFileSync('./apps/miniprogram/miniprogram/assets/yulehui-crest.png').length > 0)
    assert.ok(readFileSync('./apps/miniprogram/miniprogram/assets/jinfeng-xiyulou-crest.png').length > 0)
    assert.equal(themeStore.find('jinfeng-xiyulou').englishName, 'JINFENG XIYULOU')
    assert.equal(themeStore.find('jinfeng-xiyulou').template, 'team')
  } finally {
    if (previousWx === undefined) delete global.wx
    else global.wx = previousWx
  }
})

test('Mini Program crest assets use iOS-compatible PNG containers', () => {
  for (const name of ['yulehui-crest.png', 'jinfeng-xiyulou-crest.png']) {
    const asset = readFileSync('./apps/miniprogram/miniprogram/assets/' + name)
    assert.deepEqual([...asset.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
  }
})

test('Mini Program packaging keeps dynamically referenced assets and required services', () => {
  const sharedConfig = JSON.parse(readFileSync('./apps/miniprogram/project.config.json', 'utf8'))
  assert.equal(sharedConfig.setting.ignoreDevUnusedFiles, false)
  assert.equal(sharedConfig.setting.ignoreUploadUnusedFiles, false)

  const privateConfigPath = './apps/miniprogram/project.private.config.json'
  try {
    const privateConfig = JSON.parse(readFileSync(privateConfigPath, 'utf8'))
    assert.equal(privateConfig.setting.ignoreDevUnusedFiles, false)
    assert.equal(privateConfig.setting.ignoreUploadUnusedFiles, false)
  } catch (error) {
    if (error && error.code !== 'ENOENT') throw error
  }
})

test('Mini Program crest diagnostics report device image load results', () => {
  const previousWx = global.wx
  const previousGetCurrentPages = global.getCurrentPages
  const previousInfo = console.info
  const previousError = console.error
  const logs = []
  global.wx = {
    getStorageSync() { return 'yulehui' },
    getSystemInfoSync() {
      return { platform: 'ios', system: 'iOS 18', version: '8.0.60', SDKVersion: '3.8.10' }
    },
    getAccountInfoSync() {
      return { miniProgram: { envVersion: 'develop', version: '0.8.0' } }
    },
  }
  global.getCurrentPages = () => [{ route: 'pages/player/index' }]
  console.info = (...args) => logs.push(args)
  console.error = (...args) => logs.push(args)
  try {
    const event = {
      currentTarget: {
        dataset: { crestKind: 'profile', crestSrc: '/assets/yulehui-crest.png' },
      },
      detail: { errMsg: 'Failed to load local image resource' },
    }
    themeStore.onCrestImageError(event)
    assert.equal(logs[0][0], 'Crest image load failed')
    assert.deepEqual(logs[0][1], {
      route: 'pages/player/index',
      kind: 'profile',
      src: '/assets/yulehui-crest.png',
      theme: 'yulehui',
      width: 0,
      height: 0,
      errMsg: 'Failed to load local image resource',
      platform: 'ios',
      system: 'iOS 18',
      wechatVersion: '8.0.60',
      SDKVersion: '3.8.10',
      environment: 'develop',
      appVersion: '0.8.0',
    })
    themeStore.logCrestRuntime()
    assert.equal(logs[1][0], 'Crest diagnostics initialized')

    for (const page of ['home', 'player']) {
      const template = readFileSync(
        './apps/miniprogram/miniprogram/pages/' + page + '/index.wxml',
        'utf8',
      )
      const crestImages = template.match(/<image[^>]*(?:themeCrest|\.crest)[^>]*\/>/g) || []
      assert.ok(crestImages.length > 0)
      crestImages.forEach((image) => {
        assert.match(image, /bindload="onCrestImageLoad"/)
        assert.match(image, /binderror="onCrestImageError"/)
        assert.match(image, /data-crest-src=/)
      })
    }
  } finally {
    console.info = previousInfo
    console.error = previousError
    if (previousWx === undefined) delete global.wx
    else global.wx = previousWx
    if (previousGetCurrentPages === undefined) delete global.getCurrentPages
    else global.getCurrentPages = previousGetCurrentPages
  }
})

test('Mini Program theme text remains readable on every shared surface', () => {
  const styles = readFileSync('./apps/miniprogram/miniprogram/app.wxss', 'utf8')
  function variables(themeId) {
    const start = styles.indexOf('.theme-' + themeId + ' {')
    const block = styles.slice(start, styles.indexOf('}', start))
    return Object.fromEntries([...block.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{6})/g)].map((match) => [match[1], match[2]]))
  }
  function luminance(hex) {
    const channels = hex.slice(1).match(/../g).map((value) => parseInt(value, 16) / 255)
      .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
  }
  function contrast(first, second) {
    const values = [luminance(first), luminance(second)].sort((left, right) => right - left)
    return (values[0] + 0.05) / (values[1] + 0.05)
  }

  for (const themeId of ['dark', 'light', 'yulehui', 'jinfeng-xiyulou']) {
    const palette = variables(themeId)
    const surfaces = ['--theme-bg', '--theme-surface', '--theme-surface-strong', '--theme-surface-soft']
    const foregrounds = [
      '--theme-text', '--theme-text-soft', '--theme-muted', '--theme-muted-strong',
      '--theme-accent', '--theme-gold', '--theme-danger', '--theme-positive',
      '--theme-good', '--theme-wolf',
    ]
    const pairs = foregrounds.flatMap((foreground) => surfaces.map((surface) => [foreground, surface]))
    pairs.push(['--theme-accent', '--theme-on-accent'])
    pairs.push(['--theme-disabled-text', '--theme-disabled-bg'])
    pairs.forEach(([foreground, background]) => {
      assert.ok(
        contrast(palette[foreground], palette[background]) >= 4.5,
        themeId + ' ' + foreground + ' is hard to read on ' + background,
      )
    })
  }
})

test('Mini Program pages use theme tokens instead of dark-theme colors', () => {
  const pages = ['session', 'search', 'player', 'compare', 'events', 'tools', 'rules', 'draw', 'group']
  pages.forEach((page) => {
    const styles = readFileSync('./apps/miniprogram/miniprogram/pages/' + page + '/index.wxss', 'utf8')
    assert.doesNotMatch(styles, /#[0-9a-fA-F]{3,8}|rgba?\(/, page + ' contains a fixed theme color')
  })
  const home = readFileSync('./apps/miniprogram/miniprogram/pages/home/index.wxss', 'utf8')
  const previewStart = home.indexOf('.theme-preview-dark')
  const previewEnd = home.indexOf('.theme-copy')
  assert.ok(previewStart > 0 && previewEnd > previewStart)
  assert.doesNotMatch(home.slice(0, previewStart) + home.slice(previewEnd), /#[0-9a-fA-F]{3,8}|rgba?\(/)
})

test('Mini Program profile crests follow desktop exact team matching and local choice rules', () => {
  const previousWx = global.wx
  const storage = new Map()
  global.wx = {
    getStorageSync(key) { return storage.get(key) || '' },
    setStorageSync(key, value) { storage.set(key, value) },
  }
  try {
    const yulehui = profileCrest.candidates(['鱼乐会（鲁）'])
    assert.deepEqual(yulehui.map((item) => item.id), ['yulehui'])
    assert.equal(profileCrest.resolve(yulehui).id, 'yulehui')
    assert.deepEqual(profileCrest.candidates(['鱼乐会俱乐部']), [])

    const multiple = profileCrest.candidates(['鱼乐会（鲁）', '金风细雨楼(京)'])
    assert.equal(profileCrest.resolve(multiple), null)
    assert.equal(profileCrest.resolve(multiple, 'jinfeng-xiyulou').id, 'jinfeng-xiyulou')
    assert.equal(profileCrest.resolve(multiple, 'none'), null)
    profileCrest.save('109', 'none')
    assert.equal(profileCrest.load('109'), 'none')
    assert.equal(storage.size, 1)
  } finally {
    if (previousWx === undefined) delete global.wx
    else global.wx = previousWx
  }
})

test('Mini Program player search follows desktop name ranking and ID lookup', async () => {
  const searchPage = readFileSync('./apps/miniprogram/miniprogram/pages/search/index.wxml', 'utf8')
  const playerPage = readFileSync('./apps/miniprogram/miniprogram/pages/player/index.wxml', 'utf8')
  assert.match(searchPage, /data-mode="name"[\s\S]*data-mode="id"/)
  assert.match(playerPage, /profileCrest[\s\S]*选择资料页队徽/)
  assert.deepEqual(huashan.playerSearchVariants('will'), ['will', 'Will'])
  const merged = huashan.mergePlayerSearchResults([
    { items: [{ player_id: 2, player_name: 'Willy', total_point: 4 }] },
    { items: [{ player_id: 1, player_name: 'Will', total_point: 3 }, { player_id: 2, player_name: 'Willy' }] },
  ])
  assert.deepEqual(huashan.rankPlayerSearchResults(merged, 'will').map((item) => item.player_id), [1, 2])
  await assert.rejects(huashan.searchPlayerById('10A'), { code: 'INVALID_PLAYER_ID' })

  const previousWx = global.wx
  huashan.clearDataCache()
  tokenStore.setToken('abc.def.ghi')
  global.wx = {
    request(options) {
      assert.match(options.url, /\/stats\/games\/players\/109\?zone_id=ALL&leagueTier=1$/)
      options.success({
        statusCode: 200,
        data: { player: { name: '测试选手', avatar: 'avatar.png' }, summary: { total_point: 12.5 } },
      })
    },
  }
  try {
    assert.deepEqual(await huashan.searchPlayerById('109'), {
      playerId: '109',
      name: '测试选手',
      avatar: 'avatar.png',
      sect: '暂无门派信息',
      point: '12.5',
    })
  } finally {
    huashan.clearDataCache()
    tokenStore.clearSession()
    if (previousWx === undefined) delete global.wx
    else global.wx = previousWx
  }
})

test('Mini Program player search payload is normalized for display', () => {
  const payload = {
    items: [{ player_id: 7, player_name: '测试选手', player_avatar: 'avatar.png', total_point: 12.5, sects: [{ name: '测试门派' }] }],
  }
  const rows = huashan.searchItems(payload).map(huashan.playerView)
  assert.deepEqual(rows, [{
    playerId: '7',
    name: '测试选手',
    avatar: 'avatar.png',
    sect: '测试门派',
    point: '12.5',
  }])
})

test('Mini Program player stats are normalized into the basic detail metrics', () => {
  const detail = huashan.playerDetailView({
    player: { name: '张三', avatar: 'detail.png' },
    power: 1234,
    summary: { round_total: 30, round_point_avg: 4.5, win_pct: 60, internal_field: 999 },
    haoren: { toulang_pct: 72, zhanbian_pct: 66 },
  }, { playerId: '7', name: '搜索名', sect: '测试门派' })

  assert.equal(detail.name, '张三')
  assert.equal(detail.avatar, 'detail.png')
  assert.equal(detail.power, '1234')
  assert.deepEqual(detail.metrics.map((metric) => metric.value), ['30', '4.5', '60%', '72%', '66%'])
  assert.deepEqual(detail.overviewSections.map((section) => section.title), ['综合', '好人', '狼人'])
  assert.deepEqual(detail.overviewSections[0].metrics.map((metric) => metric.label), ['总场次', '场均分', '胜率', 'internal_field'])
})

test('Mini Program personal scope links season and sect and recomputes every performance section', () => {
  const games = huashan.gameItems([
    { game_id: 1, season_id: 30, sect_name: '甲门派（鲁）', rpt_name: '平民', edition_name: '版型甲', total_point: -2.125, win: 1, mvp: 1 },
    { game_id: 2, season_id: 30, sect_name: '乙门派', rpt_name: '狼', edition_name: '版型乙', total_point: 3, win: 0 },
    { game_id: 3, season_id: 29, sect_name: '甲门派（宁）', rpt_name: '预言家', edition_name: '版型甲', total_point: 5, win: 0, svp: 1 },
  ])
  assert.deepEqual(huashan.scopeCandidates(games, { sect: '甲门派' }).seasons, [30, 29])
  assert.deepEqual(huashan.scopeCandidates(games, { season: '30' }).sects, ['甲门派', '乙门派'])
  const selected = huashan.scopedGames(games, { season: '30', sect: '甲门派' })
  assert.deepEqual(selected.map((game) => game.gameId), ['1'])
  assert.equal(huashan.roleBreakdown(selected)[0].totalPoint, -2.13)
  assert.equal(huashan.editionBreakdown(selected)[0].totalPoint, -2.13)

  const detail = huashan.playerDetailForSect({
    player: { name: '测试选手' }, summary: { round_total: 99 }, haoren: { toulang_pct: 88 },
  }, { playerId: '7' }, games, '甲门派')
  assert.equal(detail.overviewSections[0].metrics.find((metric) => metric.key === 'round_total').rawValue, 2)
  assert.equal(detail.overviewSections[0].metrics.find((metric) => metric.key === 'total_point').rawValue, 2.88)
  assert.equal(detail.metrics.find((metric) => metric.key === 'toulang_pct').value, '—')
})

test('Mini Program honors fall back to static zone names after a player leaves a zone', () => {
  assert.equal(zone.honorZoneName('SH', []), '上海')
  assert.equal(zone.honorZoneName('XM', []), '厦门')
  const detail = huashan.playerDetailView({ honors: [{ zone_id: 'SH', season_id: 6, code: 1 }] }, { playerId: '7' })
  assert.equal(detail.honors[0].text, '上海 S6 冠军')
})

test('Mini Program recent games use the shared Werewolf display terms', () => {
  const games = huashan.recentGameItems({
    total_items: 1,
    items: [{
      game_id: 11,
      play_date: '2026-09-01',
      season_id: 30,
      round: 2,
      seat: 7,
      sect_name: '测试门派',
      edition_name: '狼王摄梦人',
      rpt_name: '预言家',
      total_point: 6,
      win: 1,
      mvp: 1,
      svp: 1,
      bgx: 0,
    }],
  })

  assert.deepEqual(games, [{
    gameId: '11',
    date: '2026-09-01',
    edition: '狼王摄梦人',
    role: '预言家',
    sect: '测试门派',
    season: 'S30',
    round: '第 2 轮',
    seat: '7号',
    point: '6',
    pointValue: 6,
    result: '胜',
    won: true,
    hasResult: true,
    resultClass: 'won',
    camp: 'good',
    mvp: true,
    svp: true,
    bgx: false,
    marks: 'MVP · 尽力',
  }])
})

test('Mini Program game filters and date or point sorting use complete normalized rows', () => {
  const games = huashan.gameItems([
    { game_id: 1, play_date: '2026-08-01', rpt_name: '平民', sect_name: '甲', total_point: 2, win: 1, mvp: 1 },
    { game_id: 2, play_date: '2026-09-01', rpt_name: '石像鬼', sect_name: '乙', total_point: 8, win: 0, bgx: 1 },
    { game_id: 3, play_date: '2026-07-01', rpt_name: '预言家', sect_name: '甲', total_point: -1, win: 0, svp: 1 },
  ])

  assert.deepEqual(huashan.gameFilterOptions(games), {
    roles: ['平民', '石像鬼', '预言家'],
    sects: ['乙', '甲'],
  })
  assert.deepEqual(
    huashan.filteredGames(games, { camp: 'wolf' }, { key: 'date', direction: 'desc' }).map((game) => game.gameId),
    ['2'],
  )
  assert.deepEqual(
    huashan.filteredGames(games, { sect: '甲', result: 'loss', mark: 'svp' }, { key: 'point', direction: 'desc' }).map((game) => game.gameId),
    ['3'],
  )
  assert.deepEqual(
    huashan.filteredGames(games, {}, { key: 'point', direction: 'asc' }).map((game) => game.gameId),
    ['3', '1', '2'],
  )
})

test('Desktop and Mini Program both keep unknown results out of win and loss filters', () => {
  const desktop = readFileSync('./internal/server/web/js/ui.js', 'utf8')
  assert.match(desktop, /gf\.result === 'l'[\s\S]{0,140}g\.win != null && g\.win !== ''/)
  assert.match(desktop, /结果未知/)
  const unknown = huashan.gameItems([{ game_id: 1, win: null }])
  assert.equal(huashan.filteredGames(unknown, { result: 'win' }, {}).length, 0)
  assert.equal(huashan.filteredGames(unknown, { result: 'loss' }, {}).length, 0)
})

test('Mini Program role and edition breakdowns match desktop deep-data rounding', () => {
  const games = huashan.gameItems([
    { game_id: 1, rpt_name: '平民', edition_name: '狼王摄梦人', total_point: 5, win: 1, mvp: 1 },
    { game_id: 2, rpt_name: '平民', edition_name: '狼王摄梦人', total_point: 2, win: 0, svp: 1 },
    { game_id: 3, rpt_name: '狼', edition_name: '狼王摄梦人', total_point: -1, win: 0, bgx: 1 },
    { game_id: 4, rpt_name: '预言家', total_point: 6, win: 1 },
  ])

  assert.deepEqual(huashan.roleBreakdown(games), [
    { name: '平民', games: 2, totalPoint: 7, avg: 3.5, winValue: 50, win: '50%', wolfRateValue: 0, wolfRate: '0%', mvp: 1, svp: 1, bgx: 0, camp: 'good' },
    { name: '狼', games: 1, totalPoint: -1, avg: -1, winValue: 0, win: '0%', wolfRateValue: 100, wolfRate: '100%', mvp: 0, svp: 0, bgx: 1, camp: 'wolf' },
    { name: '预言家', games: 1, totalPoint: 6, avg: 6, winValue: 100, win: '100%', wolfRateValue: 0, wolfRate: '0%', mvp: 0, svp: 0, bgx: 0, camp: 'good' },
  ])
  assert.deepEqual(huashan.editionBreakdown(games), [
    { name: '狼王摄梦人', games: 3, totalPoint: 6, avg: 2, winValue: 33, win: '33%', wolfRateValue: 33, wolfRate: '33%', mvp: 1, svp: 1, bgx: 1 },
  ])
})

test('Mini Program role and edition breakdowns can be filtered and sorted', () => {
  const rows = [
    { name: '平民', camp: 'good', games: 10, totalPoint: 30, avg: 3, winValue: 60, wolfRateValue: 0, mvp: 1, svp: 2, bgx: 0 },
    { name: '石像鬼', camp: 'wolf', games: 3, totalPoint: 15, avg: 5, winValue: 67, wolfRateValue: 100, mvp: 2, svp: 0, bgx: 1 },
    { name: '预言家', camp: 'good', games: 5, totalPoint: 40, avg: 8, winValue: 80, wolfRateValue: 0, mvp: 3, svp: 1, bgx: 0 },
  ]

  assert.deepEqual(
    huashan.filteredBreakdown(rows, { camp: 'good' }, { key: 'avg', direction: 'desc' }).map((row) => row.name),
    ['预言家', '平民'],
  )
  assert.deepEqual(
    huashan.filteredBreakdown(rows, { query: '像' }, { key: 'totalPoint', direction: 'asc' }).map((row) => row.name),
    ['石像鬼'],
  )
})

test('Mini Program loads every known player-game page with the official page size', async () => {
  const previousWx = global.wx
  const calls = []
  huashan.clearDataCache()
  tokenStore.setToken('abc.def.ghi')
  global.wx = {
    request(options) {
      const url = new URL(options.url)
      const page = Number(url.searchParams.get('page'))
      const size = Number(url.searchParams.get('size'))
      calls.push([page, size])
      const count = page < 3 ? 100 : 5
      const start = (page - 1) * 100
      options.success({
        statusCode: 200,
        data: {
          total_items: 205,
          items: Array.from({ length: count }, (_, index) => ({ game_id: start + index + 1 })),
        },
      })
    },
  }

  try {
    const progress = []
    const result = await huashan.loadAllPlayerGames('7', {
      onProgress: (state) => progress.push(state),
    })
    assert.equal(result.items.length, 205)
    assert.equal(result.truncated, false)
    assert.deepEqual(result.failedPages, [])
    assert.deepEqual(calls.sort((a, b) => a[0] - b[0]), [[1, 100], [2, 100], [3, 100]])
    assert.equal(progress.at(-1).loadedItems, 205)
  } finally {
    huashan.clearDataCache()
    tokenStore.clearSession()
    if (previousWx === undefined) delete global.wx
    else global.wx = previousWx
  }
})

test('Mini Program reuses player data until the player cache is cleared', async () => {
  const previousWx = global.wx
  let statsCalls = 0
  let gamesCalls = 0
  huashan.clearDataCache()
  tokenStore.setToken('abc.def.ghi')
  global.wx = {
    request(options) {
      if (options.url.includes('/stats/games/players/')) {
        statsCalls += 1
        options.success({ statusCode: 200, data: { power: statsCalls } })
        return
      }
      gamesCalls += 1
      options.success({
        statusCode: 200,
        data: { total_items: 1, items: [{ game_id: gamesCalls }] },
      })
    },
  }

  try {
    const firstStats = await huashan.playerStats('cache-player')
    const secondStats = await huashan.playerStats('cache-player')
    const firstGames = await huashan.loadAllPlayerGames('cache-player')
    const secondGames = await huashan.loadAllPlayerGames('cache-player')
    assert.strictEqual(secondStats, firstStats)
    assert.strictEqual(secondGames, firstGames)
    assert.equal(statsCalls, 1)
    assert.equal(gamesCalls, 1)

    huashan.clearPlayerDataCache('cache-player')
    await huashan.playerStats('cache-player')
    await huashan.loadAllPlayerGames('cache-player')
    assert.equal(statsCalls, 2)
    assert.equal(gamesCalls, 2)
  } finally {
    huashan.clearDataCache()
    tokenStore.clearSession()
    if (previousWx === undefined) delete global.wx
    else global.wx = previousWx
  }
})

test('Mini Program comparison caches games by zone and filters seasons locally', async () => {
  const previousWx = global.wx
  const calls = []
  huashan.clearDataCache()
  tokenStore.setToken('abc.def.ghi')
  global.wx = {
    request(options) {
      const url = new URL(options.url)
      calls.push(url)
      options.success({
        statusCode: 200,
        data: {
          total_items: 2,
          items: [
            { game_id: 1, season_id: 30 },
            { game_id: 2, season_id: 29 },
          ],
        },
      })
    },
  }

  try {
    const season30 = await huashan.loadAllPlayerGames('scope-player', null, { zone: 'SD', season: '30' })
    const season29 = await huashan.loadAllPlayerGames('scope-player', null, { zone: 'SD', season: '29' })
    assert.deepEqual(season30.items.map((game) => game.game_id), [1])
    assert.deepEqual(season29.items.map((game) => game.game_id), [2])
    assert.deepEqual(season29.seasonCandidates, [30, 29])
    assert.equal(calls.length, 1)
    assert.equal(calls[0].searchParams.get('zone_id'), 'SD')

    await huashan.loadAllPlayerGames('scope-player', null, { zone: 'ALL', season: '' })
    assert.equal(calls.length, 2)
    assert.equal(calls[1].searchParams.has('zone_id'), false)

    huashan.cancelPlayerRequests('scope-player')
    await huashan.loadAllPlayerGames('scope-player', null, { zone: 'SD', season: '' })
    assert.equal(calls.length, 2)
  } finally {
    huashan.clearDataCache()
    tokenStore.clearSession()
    if (previousWx === undefined) delete global.wx
    else global.wx = previousWx
  }
})

test('Mini Program does not cache failed player requests', async () => {
  const previousWx = global.wx
  let calls = 0
  huashan.clearDataCache()
  tokenStore.setToken('abc.def.ghi')
  global.wx = {
    request(options) {
      calls += 1
      options.success({
        statusCode: calls === 1 ? 500 : 200,
        data: calls === 1 ? {} : { power: 99 },
      })
    },
  }

  try {
    await assert.rejects(huashan.playerStats('retry-player'))
    assert.deepEqual(await huashan.playerStats('retry-player'), { power: 99 })
    assert.equal(calls, 2)
  } finally {
    huashan.clearDataCache()
    tokenStore.clearSession()
    if (previousWx === undefined) delete global.wx
    else global.wx = previousWx
  }
})

test('Mini Program cancels stale player requests and does not reuse their pending promise', async () => {
  const previousWx = global.wx
  let calls = 0
  let aborts = 0
  huashan.clearDataCache()
  tokenStore.setToken('abc.def.ghi')
  global.wx = {
    request(options) {
      calls += 1
      if (calls > 1) {
        options.success({ statusCode: 200, data: { power: 88 } })
        return {}
      }
      return {
        abort() {
          aborts += 1
          options.fail({ errMsg: 'request:fail abort' })
        },
      }
    },
  }
  try {
    const stale = huashan.playerStats('cancel-player')
    huashan.cancelPlayerRequests('cancel-player')
    await assert.rejects(stale, { code: 'REQUEST_ABORTED' })
    assert.equal(aborts, 1)
    assert.deepEqual(await huashan.playerStats('cancel-player'), { power: 88 })
    assert.equal(calls, 2)
  } finally {
    huashan.clearDataCache()
    tokenStore.clearSession()
    if (previousWx === undefined) delete global.wx
    else global.wx = previousWx
  }
})

test('Mini Program caches a single-match replay for the current session', async () => {
  const previousWx = global.wx
  let calls = 0
  huashan.clearDataCache()
  tokenStore.setToken('abc.def.ghi')
  global.wx = {
    request(options) {
      calls += 1
      assert.match(options.url, /\/werewolves\/games\/game%201$/)
      options.success({ statusCode: 200, data: { id: 'game 1' } })
    },
  }

  try {
    const first = await huashan.playerGame('game 1')
    const second = await huashan.playerGame('game 1')
    assert.strictEqual(second, first)
    assert.equal(calls, 1)
    huashan.clearDataCache()
    await huashan.playerGame('game 1')
    assert.equal(calls, 2)
  } finally {
    huashan.clearDataCache()
    tokenStore.clearSession()
    if (previousWx === undefined) delete global.wx
    else global.wx = previousWx
  }
})

test('Mini Program single-match replay matches desktop seat and day views', () => {
  const game = JSON.parse(readFileSync('./internal/player/testdata/game_44268.json', 'utf8'))
  const view = replay.replayView(game, '109', { bgx: false })
  assert.equal(view.result, '狼人胜')
  assert.equal(view.seatRows.length, 12)
  assert.equal(view.dayRows.length, 4)
  assert.deepEqual(view.roster.map((group) => group.players.length), [4, 4, 4])
  assert.equal(view.mvp, '3号 捌玖^·狼')
  assert.ok(view.seatRows.find((row) => row.playerId === '109').isMe)
  assert.ok(view.dayRows[0].skills.some((skill) => skill.actor === '狼刀' && /9号 Will·平民/.test(skill.target)))
  assert.equal(view.dayRows[0].exileText, '放逐 8号 大葱·狼')
  assert.ok(view.timeline.some((item) => item.cause === '女巫毒'))
  assert.equal(view.points.length, 2)
})

test('Mini Program replay respects official day count and uses the last same-day linked target', () => {
  const game = JSON.parse(readFileSync('./internal/player/testdata/game_44268.json', 'utf8'))
  game.day = 2
  game.form2 = JSON.parse(game.form2)
  game.form2.rows[0].skills.push({ day: 5, name: '预言家', target_seats: [2] })
  assert.equal(replay.replayView(game, '109', null).dayRows.length, 2)

  const rows = Array.from({ length: 12 }, (_, index) => ({
    validForAnalysis: true,
    seat: index + 1,
    role: index === 0 ? '狼美人' : (index < 4 ? '狼' : '平民'),
    skills: index === 0
      ? [{ day: 1, name: '狼美人', targets: [2] }, { day: 1, name: '狼美人', targets: [3] }]
      : [],
    votes: { 1: { seat: index + 1, target: 1, weight: 1, abstain: false } },
    explodeDay: 0,
  }))
  const analysis = replay.analyze({ day: 1 }, rows)
  assert.ok(analysis.deaths.some((death) => death.seat === 3 && death.cause === 'wolfbeauty_link'))
  assert.ok(!analysis.deaths.some((death) => death.seat === 2 && death.cause === 'wolfbeauty_link'))
})

test('Mini Program replay matches desktop when an empty valid game has zero days', () => {
  const rows = Array.from({ length: 12 }, (_, index) => ({
    seat: index + 1,
    rpt_name: index < 4 ? '狼' : '平民',
    skills: [],
  }))
  const view = replay.replayView({ day: 0, form2: JSON.stringify({ rows }) }, '', null)
  assert.equal(view.seatRows.length, 12)
  assert.equal(view.dayRows.length, 0)
})

test('Mini Program registers a player detail page and search cards navigate to it', () => {
  const app = JSON.parse(readFileSync(
    './apps/miniprogram/miniprogram/app.json',
    'utf8',
  ))
  const searchPage = readFileSync(
    './apps/miniprogram/miniprogram/pages/search/index.js',
    'utf8',
  )
  assert.ok(app.pages.includes('pages/player/index'))
  assert.ok(app.pages.includes('pages/home/index'))
  assert.match(searchPage, /wx\.navigateTo\(\{ url: '\/pages\/player\/index\?' \+ query \}\)/)
})

test('Mini Program enters a standalone home before opening personal search', () => {
  const sessionPage = readFileSync(
    './apps/miniprogram/miniprogram/pages/session/index.js',
    'utf8',
  )
  const homePage = readFileSync(
    './apps/miniprogram/miniprogram/pages/home/index.js',
    'utf8',
  )
  const homeTemplate = readFileSync(
    './apps/miniprogram/miniprogram/pages/home/index.wxml',
    'utf8',
  )
  const homeStyles = readFileSync(
    './apps/miniprogram/miniprogram/pages/home/index.wxss',
    'utf8',
  )
  const searchPage = readFileSync(
    './apps/miniprogram/miniprogram/pages/search/index.js',
    'utf8',
  )
  const searchTemplate = readFileSync(
    './apps/miniprogram/miniprogram/pages/search/index.wxml',
    'utf8',
  )
  assert.match(sessionPage, /wx\.reLaunch\(\{ url: '\/pages\/home\/index' \}\)/)
  assert.match(homePage, /wx\.navigateTo\(\{ url: '\/pages\/search\/index' \}\)/)
  assert.match(homeTemplate, /个人数据/)
  assert.match(homeTemplate, /赛事数据/)
  assert.match(homeTemplate, /华山工具箱/)
  assert.match(homeTemplate, /使用说明/)
  assert.match(homeTemplate, />主题</)
  assert.match(homeTemplate, /青崖夜|themeOptions/)
  assert.match(homeTemplate, /open-type="share"/)
  assert.match(homeTemplate, /更新日志/)
  assert.doesNotMatch(homeTemplate, /尚未开放/)
  assert.match(homePage, /pages\/events\/index/)
  assert.match(homePage, /pages\/tools\/index/)
  assert.doesNotMatch(homeTemplate, /class="account-button"/)
  assert.doesNotMatch(searchTemplate, /class="session-button"/)
  assert.match(homeTemplate, /aria-expanded="\{\{actionsOpen\}\}"/)
  assert.match(homeTemplate, /wx:if="\{\{actionsOpen\}\}" id="home-action-menu"/)
  assert.match(homeTemplate, /class="action-arrow">›<\/text>/)
  assert.match(homeStyles, /\.home-action-list button\s*\{[\s\S]*width:\s*100%;[\s\S]*border-bottom:/)
  assert.match(homeStyles, /\.home-action-list button:last-child\s*\{[\s\S]*border-bottom:\s*0;/)
  assert.doesNotMatch(homeStyles, /\.home-action-list\s*\{[^}]*grid-template-columns:/)
  assert.doesNotMatch(homeStyles, /\.home-action-list button\s*\{[^}]*border-radius:\s*17rpx;/)
  assert.match(homeStyles, /\.home-note\s*\{[^}]*border-top:[^}]*background:\s*transparent;/)
  assert.doesNotMatch(homeStyles, /\.home-note\s*\{[^}]*border-left:/)
  assert.doesNotMatch(homeTemplate, /home-sun/)
  assert.doesNotMatch(homeTemplate, /检查更新|退出程序/)
  assert.match(homePage, /onShareAppMessage\(\)/)
  assert.match(homePage, /openHelp\(\)/)
  assert.match(homePage, /openChangelog\(\)/)
  assert.match(homePage, /selectTheme\(event\)/)
  assert.match(homePage, /actionsOpen:\s*false/)
  assert.match(homePage, /toggleActions\(\)\s*\{[\s\S]*actionsOpen:\s*!this\.data\.actionsOpen/)
  assert.match(homeTemplate, /open-type="share" bindtap="closeActions"/)
  assert.match(homePage, /closeActions\(\)\s*\{[\s\S]*actionsOpen:\s*false/)
  assert.doesNotMatch(homePage, /accountName|resetSession|getProfile/)
  assert.doesNotMatch(searchPage, /accountName|resetSession|getProfile/)

  for (const page of ['session', 'home', 'search', 'player', 'compare']) {
    const template = readFileSync(`./apps/miniprogram/miniprogram/pages/${page}/index.wxml`, 'utf8')
    const script = readFileSync(`./apps/miniprogram/miniprogram/pages/${page}/index.js`, 'utf8')
    assert.match(template, /theme-\{\{theme\}\}/)
    assert.match(template, /teamTheme \? 'theme-team'/)
    assert.match(template, /class="team-watermark/)
    assert.match(template, /class="team-brand/)
    assert.match(template, /class="team-brand-crest" src="\{\{themeCrest\}\}"/)
    assert.match(template, /\{\{themeEnglishName\}\}/)
    assert.match(script, /services\/theme/)
    assert.match(script, /themeStore\.pageData\(\)/)
  }
})

test('Mini Program team themes use one branded stripe template and no login sun', () => {
  const globalStyles = readFileSync('./apps/miniprogram/miniprogram/app.wxss', 'utf8')
  const sessionTemplate = readFileSync('./apps/miniprogram/miniprogram/pages/session/index.wxml', 'utf8')
  const sessionStyles = readFileSync('./apps/miniprogram/miniprogram/pages/session/index.wxss', 'utf8')
  assert.match(globalStyles, /\.theme-team\.screen\s*\{[\s\S]*linear-gradient\([\s\S]*118deg/)
  assert.match(globalStyles, /\.team-brand\s*\{/)
  assert.match(globalStyles, /\.team-watermark\s*\{/)
  assert.doesNotMatch(globalStyles, /\.theme-yulehui\s+\.team-brand|\.theme-jinfeng-xiyulou\s+\.team-brand/)
  assert.doesNotMatch(sessionTemplate, /class="sun"/)
  assert.doesNotMatch(sessionStyles, /\.sun\s*\{/)
})

test('Mini Program informational states stay flat instead of becoming theme cards', () => {
  const globalStyles = readFileSync('./apps/miniprogram/miniprogram/app.wxss', 'utf8')
  const sessionStyles = readFileSync('./apps/miniprogram/miniprogram/pages/session/index.wxss', 'utf8')
  const searchStyles = readFileSync('./apps/miniprogram/miniprogram/pages/search/index.wxss', 'utf8')
  const playerStyles = readFileSync('./apps/miniprogram/miniprogram/pages/player/index.wxss', 'utf8')
  const compareStyles = readFileSync('./apps/miniprogram/miniprogram/pages/compare/index.wxss', 'utf8')

  assert.match(globalStyles, /\.screen \.privacy-note,[\s\S]*\.screen \.person-error\s*\{[\s\S]*background:\s*transparent !important;[\s\S]*box-shadow:\s*none !important;/)
  assert.match(sessionStyles, /\.privacy-note\s*\{[^}]*background:\s*transparent;/)
  assert.match(searchStyles, /\.first-state\s*\{[^}]*background:\s*transparent;/)
  assert.match(searchStyles, /\.help-card\s*\{[^}]*background:\s*transparent;[^}]*box-shadow:\s*none;/)
  assert.match(playerStyles, /\.section-warning\s*\{[^}]*background:\s*transparent;/)
  assert.match(playerStyles, /\.games-progress\s*\{[^}]*background:\s*transparent;/)
  assert.match(compareStyles, /\.hidden-note\s*\{[^}]*background:\s*transparent;/)
  assert.match(compareStyles, /\.shared-intro\s*\{[^}]*background:\s*transparent;/)
  assert.match(compareStyles, /\.warning-panel,[\s\S]*\.person-error\s*\{[^}]*background:\s*transparent;/)
})

test('Mini Program player page waits for complete history before enabling filters', () => {
  const playerPage = readFileSync(
    './apps/miniprogram/miniprogram/pages/player/index.js',
    'utf8',
  )
  const playerTemplate = readFileSync(
    './apps/miniprogram/miniprogram/pages/player/index.wxml',
    'utf8',
  )
  assert.match(playerPage, /huashan\.loadAllPlayerGames/)
  assert.match(playerPage, /filterReady: true/)
  assert.match(playerTemplate, /filterReady &&/)
  assert.match(playerTemplate, /加载更多/)
  assert.match(playerTemplate, /日期 \{\{dateSortMark\}\}/)
  assert.match(playerTemplate, /得分 \{\{pointSortMark\}\}/)
  assert.doesNotMatch(playerTemplate, /浅数据|深数据|下拉可重新读取|安全上限|分页读取/)
})

test('Mini Program player page exposes cache refresh, complete teams, and performance tools', () => {
  const playerPage = readFileSync(
    './apps/miniprogram/miniprogram/pages/player/index.js',
    'utf8',
  )
  const playerTemplate = readFileSync(
    './apps/miniprogram/miniprogram/pages/player/index.wxml',
    'utf8',
  )
  const playerStyles = readFileSync(
    './apps/miniprogram/miniprogram/pages/player/index.wxss',
    'utf8',
  )
  const playerConfig = JSON.parse(readFileSync(
    './apps/miniprogram/miniprogram/pages/player/index.json',
    'utf8',
  ))
  assert.equal(playerConfig.enablePullDownRefresh, false)
  assert.doesNotMatch(playerPage, /onPullDownRefresh/)
  assert.match(playerPage, /huashan\.clearPlayerDataCache\(this\.playerId\)/)
  const zoneHandler = playerPage.match(/onScopeZoneChange\(event\) \{[\s\S]*?\n  \},\n\n  onScopeSeasonChange/)[0]
  assert.match(zoneHandler, /huashan\.cancelPlayerRequests\(this\.playerId\)/)
  assert.doesNotMatch(zoneHandler, /clearPlayerDataCache/)
  assert.match(playerTemplate, /bindtap="toggleTeams"/)
  assert.match(playerTemplate, /展开全部/)
  assert.match(playerPage, /createSelectorQuery\(\)\.in\(this\)/)
  assert.match(playerPage, /rowTops\.length <= 3/)
  assert.doesNotMatch(playerPage, /teamExpanded \? this\.teamNames\.length : 3/)
  assert.match(playerStyles, /\.team-chip\s*\{[^}]*white-space:\s*normal;/)
  assert.doesNotMatch(playerStyles, /\.team-chip\s*\{[^}]*text-overflow:\s*ellipsis;/)
  assert.match(playerTemplate, /bindtap="setRoleCamp"/)
  assert.match(playerTemplate, /bindchange="onRoleSortChange"/)
  assert.match(playerTemplate, /bindinput="onEditionQuery"/)
  assert.match(playerTemplate, /bindchange="onEditionSortChange"/)
  assert.match(playerTemplate, />总分<\/text>/)
  assert.match(playerTemplate, />摸狼率<\/text>/)
})

test('Mini Program match rows open a desktop-aligned single-match replay', () => {
  const playerPage = readFileSync(
    './apps/miniprogram/miniprogram/pages/player/index.js',
    'utf8',
  )
  const playerTemplate = readFileSync(
    './apps/miniprogram/miniprogram/pages/player/index.wxml',
    'utf8',
  )
  assert.match(playerPage, /huashan\.playerGame\(gameId\)/)
  assert.match(playerPage, /replay\.replayView/)
  assert.match(playerTemplate, /bindtap="openReplay"/)
  assert.match(playerTemplate, />按人<\/button>/)
  assert.match(playerTemplate, />按天<\/button>/)
  assert.match(playerTemplate, /出局顺序/)
  assert.match(playerTemplate, /警徽竞选/)
  assert.match(playerTemplate, /违规扣分/)
})

test('Mini Program game filters remain visible on narrow phone screens', () => {
  const playerTemplate = readFileSync(
    './apps/miniprogram/miniprogram/pages/player/index.wxml',
    'utf8',
  )
  const playerStyles = readFileSync(
    './apps/miniprogram/miniprogram/pages/player/index.wxss',
    'utf8',
  )
  assert.match(playerTemplate, />全部<\/button>[\s\S]*>胜<\/button>[\s\S]*>负<\/button>/)
  assert.match(playerTemplate, />全部<\/button>[\s\S]*>好人<\/button>[\s\S]*>狼人<\/button>/)
  assert.match(playerTemplate, />MVP<\/button>[\s\S]*>尽力<\/button>[\s\S]*>背锅<\/button>/)
  assert.doesNotMatch(playerTemplate, /===/)
  assert.match(playerStyles, /\.filter-chips\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*wrap;/)
  assert.doesNotMatch(playerStyles, /\.filter-chips\s*\{[^}]*grid-template-columns:/)
  assert.match(playerStyles, /\.sort-row\s*\{[^}]*flex-wrap:\s*wrap;/)
})

test('Mini Program comparison basket deduplicates players and caps at twelve', () => {
  compareBasket.clear()
  assert.equal(compareBasket.add({ playerId: '1', name: '甲' }), true)
  assert.equal(compareBasket.add({ playerId: '1', name: '重复甲' }), false)
  for (let id = 2; id <= 12; id += 1) {
    assert.equal(compareBasket.add({ playerId: String(id), name: '选手' + id }), true)
  }
  assert.equal(compareBasket.count(), 12)
  assert.equal(compareBasket.add({ playerId: '13', name: '选手13' }), false)
  assert.equal(compareBasket.remove('4'), true)
  assert.equal(compareBasket.has('4'), false)
  assert.equal(compareBasket.add({ playerId: '13', name: '选手13' }), true)
  compareBasket.clear()
  assert.equal(compareBasket.count(), 0)
})

function comparisonRecord(playerId, stats, games) {
  const player = { playerId: String(playerId), name: '选手' + playerId, avatar: '', sect: '测试门派' }
  const normalizedGames = huashan.gameItems(games || [])
  return {
    player,
    head: huashan.playerDetailView(stats || {}, player),
    full: {
      games: normalizedGames,
      roles: huashan.roleBreakdown(normalizedGames),
      seasonCandidates: [30, 29],
      truncated: false,
    },
  }
}

test('Mini Program camp comparison preserves metric union, sorting, and fair highlighting', () => {
  const records = [
    comparisonRecord('1', { summary: { round_total: 100, round_point_avg: 3.2, win_pct: 51 }, haoren: { toulang_pct: 62 } }),
    comparisonRecord('2', { summary: { round_total: 20, round_point_avg: 5.1, win_pct: 70 }, haoren: { zhanbian_pct: 66 } }),
    comparisonRecord('3', { summary: { round_total: 200 } }),
  ]
  const summary = compare.shallowView(records, 'summary', [], new Set(), { key: 'round_point_avg', direction: 'desc' })
  assert.deepEqual(summary.columns.map((column) => column.key), ['round_total', 'round_point_avg', 'win_pct'])
  assert.deepEqual(summary.players.map((player) => player.playerId), ['2', '1', '3'])
  assert.equal(summary.players[0].values.find((value) => value.key === 'round_point_avg').best, true)
  assert.equal(summary.players[2].values.find((value) => value.key === 'round_total').best, false)

  const custom = compare.shallowView(records, 'custom', compare.cloneDefaultCustom(), new Set(), {})
  assert.deepEqual(custom.columns.map((column) => column.label), [
    '综合·总场次', '综合·场均分', '综合·胜率', '好人·投狼率', '好人·站对边率',
  ])
  assert.equal(custom.players[0].values.at(-1).value, '—')
})

test('Mini Program identity comparison supports matrix and single-role layouts', () => {
  const records = [
    comparisonRecord('1', {}, [
      { game_id: 1, rpt_name: '预言家', total_point: 8, win: 1, mvp: 1 },
      { game_id: 2, rpt_name: '平民', total_point: 2, win: 0 },
    ]),
    comparisonRecord('2', {}, [
      { game_id: 3, rpt_name: '预言家', total_point: 4, win: 0, svp: 1 },
    ]),
  ]
  const matrix = compare.identityMatrix(records, 'avg', new Set(), { key: '预言家', direction: 'desc' })
  assert.deepEqual(matrix.columns.map((column) => column.label), ['预言家', '平民'])
  assert.deepEqual(matrix.players.map((player) => player.playerId), ['1', '2'])
  assert.equal(matrix.players[0].values[0].best, true)

  const single = compare.identitySingle(records, '预言家', new Set(), { key: 'winValue', direction: 'desc' })
  assert.deepEqual(single.columns.map((column) => column.label), ['场次', '场均分', '胜率', 'MVP', '尽力', '背锅'])
  assert.equal(single.players[0].values[2].value, '100%')
  assert.equal(single.players[1].values[4].value, '1')
})

test('Mini Program shared comparison intersects every selected player before hiding', () => {
  const records = [
    comparisonRecord('1', {}, [
      { game_id: 10, play_date: '2026-09-01', edition_name: '版型甲', rpt_name: '预言家', seat: 1, total_point: 8, win: 1, mvp: 1 },
      { game_id: 20, play_date: '2026-08-01', edition_name: '版型乙', rpt_name: '平民', seat: 2, total_point: 2, win: 0 },
    ]),
    comparisonRecord('2', {}, [
      { game_id: 10, play_date: '2026-09-01', edition_name: '版型甲', rpt_name: '狼', seat: 5, total_point: -2, win: 0, bgx: 1 },
      { game_id: 30, play_date: '2026-07-01', edition_name: '版型甲', rpt_name: '平民', seat: 3, total_point: 1, win: 1 },
    ]),
    comparisonRecord('3', {}, [
      { game_id: 10, play_date: '2026-09-01', edition_name: '版型甲', rpt_name: '女巫', seat: 7, total_point: 6, win: 1, svp: 1 },
      { game_id: 20, play_date: '2026-08-01', edition_name: '版型乙', rpt_name: '狼', seat: 8, total_point: 4, win: 1 },
    ]),
  ]
  const shared = compare.sharedGames(records)
  assert.deepEqual(shared.map((game) => game.gameId), ['10'])

  const hidden = new Set(['3'])
  const summary = compare.sharedSummary(records, shared, hidden, { key: 'avg', direction: 'desc' })
  assert.deepEqual(summary.players.map((player) => player.playerId), ['1', '2'])
  assert.equal(summary.players[0].values.find((value) => value.key === 'win').value, '100%')
  assert.equal(summary.players[0].values.find((value) => value.key === 'bgx').best, true)

  const details = compare.sharedDetails(records, shared, hidden, '版型甲', 'desc', 10)
  assert.deepEqual(details.editions, ['版型甲'])
  assert.equal(details.shown[0].players.length, 2)
  assert.equal(details.shown[0].players[0].role, '预言家')
})

test('Mini Program opens comparison as a page with a horizontally scrollable metric matrix', () => {
  const app = JSON.parse(readFileSync('./apps/miniprogram/miniprogram/app.json', 'utf8'))
  const home = readFileSync('./apps/miniprogram/miniprogram/pages/home/index.wxml', 'utf8')
  const search = readFileSync('./apps/miniprogram/miniprogram/pages/search/index.wxml', 'utf8')
  const page = readFileSync('./apps/miniprogram/miniprogram/pages/compare/index.wxml', 'utf8')
  const styles = readFileSync('./apps/miniprogram/miniprogram/pages/compare/index.wxss', 'utf8')
  assert.ok(app.pages.includes('pages/compare/index'))
  assert.match(home, /多人对比/)
  assert.match(search, /catchtap="addToCompare"/)
  assert.match(search, /开始对比/)
  assert.match(page, />按阵营<\/button>[\s\S]*>按身份<\/button>[\s\S]*>同场对比<\/button>/)
  assert.match(page, />人 × 身份<\/button>[\s\S]*>单个身份<\/button>/)
  assert.match(page, />表现对比<\/button>[\s\S]*>对局明细<\/button>/)
  assert.match(page, /bindconfirm="onSeasonInput"/)
  assert.match(page, /bindtap="openReplay"/)
  assert.match(page, /class="matrix-grid"/)
  assert.match(page, /scroll-x[^>]*class="matrix-scroll"/)
  assert.match(page, /class="metric-label matrix-sticky/)
  assert.match(page, /向左滑看更多/)
  assert.match(page, /person\.profileCrest/)
  assert.match(styles, /\.matrix-grid\s*\{[^}]*display:\s*grid;/)
  assert.match(styles, /\.matrix-sticky\s*\{[^}]*position:\s*sticky;/)
  assert.match(styles, /\.matrix-value\.best\s*\{/)
  assert.doesNotMatch(page, /class="compare-card"/)
})

test('Mini Program comparison search supports batch names and ambiguous candidate confirmation', () => {
  const page = readFileSync('./apps/miniprogram/miniprogram/pages/search/index.wxml', 'utf8')
  const logic = readFileSync('./apps/miniprogram/miniprogram/pages/search/index.js', 'utf8')
  assert.match(page, /批量添加选手/)
  assert.match(page, /onBatchCandidateChange/)
  assert.match(page, /确认加入对比/)
  assert.match(logic, /shared\.mapLimit\(selectedNames, 4/)
})

test('Mini Program event metrics use the desktop day and game calculation rules', () => {
  const ranks = [
    { sectId: 10, sectName: '甲门派', totalPoint: 30 },
    { sectId: 20, sectName: '乙门派', totalPoint: 18 },
  ]
  const players = [
    { playerId: 1, playerName: '甲一', totalRound: 4, totalPoint: 12, mvp: 1, svp: 0, bgx: 0, sectIds: [10] },
    { playerId: 2, playerName: '乙一', totalRound: 3, totalPoint: 9, mvp: 0, svp: 1, bgx: 0, sectIds: [20] },
    { playerId: 3, playerName: '跨门派', totalRound: 2, totalPoint: 7, mvp: 0, svp: 0, bgx: 1, sectIds: [10, 20] },
  ]
  const day = events.metricsFor(ranks, players, '3')
  assert.equal(day.dayMode, true)
  assert.deepEqual(day.teams.map((item) => [item.days, item.avg]), [[2, 15], [1, 18]])
  assert.equal(day.players[0].days, 2)
  assert.equal(day.incomplete, true)

  const games = events.metricsFor(ranks, players.slice(0, 2), '5')
  assert.deepEqual(games.teams.map((item) => [item.games, item.avg]), [[4, 7.5], [3, 6]])
})

test('Mini Program event player paging follows desktop total-pages semantics', async () => {
  const previousWx = global.wx
  tokenStore.setToken('abc.def.ghi')
  const calls = []
  global.wx = {
    request(options) {
      calls.push(options.url)
      const page = new URL(options.url).searchParams.get('page')
      options.success({
        statusCode: 200,
        data: page === '1'
          ? { total_items: 501, items: [
            { player_id: 1, total_round: 3, sects: [{ id: 10 }] },
            { player_id: 2, total_round: 2, sects: [{ id: 10 }] },
          ] }
          : { total_items: 501, items: [{ player_id: 3, total_round: 1, sects: [{ id: 20 }] }] },
      })
    },
  }
  try {
    const players = await events.eventPlayers('991', '3', 'SD')
    assert.deepEqual(players.map((player) => player.playerId), [1, 2, 3])
    assert.equal(calls.length, 2)
  } finally {
    tokenStore.clearSession()
    if (previousWx === undefined) delete global.wx
    else global.wx = previousWx
  }
})

test('Mini Program resolves ambiguous event membership with the desktop season-wide latest game', async () => {
  const previousWx = global.wx
  tokenStore.setToken('abc.def.ghi')
  let latestQuery = ''
  global.wx = {
    request(options) {
      const url = new URL(options.url)
      if (url.pathname.endsWith('/stats/players/games')) {
        options.success({ statusCode: 200, data: { total_items: 2, items: [
          { player_id: 101, total_round: 3, sects: [{ id: 1 }, { id: 2 }] },
          { player_id: 102, total_round: 3, sects: [{ id: 3 }] },
        ] } })
        return
      }
      latestQuery = url.search
      options.success({ statusCode: 200, data: { total_items: 3, items: [{ season_id: 992, sect_name: '甲队（鲁）' }] } })
    },
  }
  try {
    const ranks = [
      { sectId: 1, sectName: '甲队', totalPoint: 10 },
      { sectId: 2, sectName: '乙队', totalPoint: 20 },
      { sectId: 3, sectName: '丙队', totalPoint: 6 },
    ]
    const metrics = await events.eventMetrics('992', '3', 'SD', ranks)
    assert.equal(metrics.incomplete, false)
    assert.deepEqual(metrics.teams.map((team) => [team.days, team.avg]), [[1, 10], [null, null], [1, 6]])
    assert.match(latestQuery, /size=1/)
    assert.match(latestQuery, /season_id=992/)
    assert.doesNotMatch(latestQuery, /season_type_id/)
  } finally {
    tokenStore.clearSession()
    if (previousWx === undefined) delete global.wx
    else global.wx = previousWx
  }
})

test('Mini Program draw rows fall back to full history when the official scope is ignored', async () => {
  const previousWx = global.wx
  tokenStore.setToken('abc.def.ghi')
  const calls = []
  global.wx = {
    request(options) {
      const url = new URL(options.url)
      calls.push(url.search)
      if (url.searchParams.has('season_id')) {
        options.success({ statusCode: 200, data: { total_items: 150, items: [
          { game_id: 99, season_id: 27, season_type_id: 3, sect_name: '旧队', total_point: 9 },
        ] } })
        return
      }
      options.success({ statusCode: 200, data: { total_items: 1, items: [
        { game_id: 12, season_id: 28, season_type_id: 5, sect_name: '甲队', total_point: 4 },
      ] } })
    },
  }
  try {
    const games = await events.fetchEventGames(109, '28', '5', 'SH')
    assert.deepEqual(games.map((game) => game.game_id), [12])
    assert.equal(calls.length, 2)
    assert.match(calls[0], /season_type_id=5/)
    assert.doesNotMatch(calls[1], /season_id|season_type_id/)
  } finally {
    tokenStore.clearSession()
    if (previousWx === undefined) delete global.wx
    else global.wx = previousWx
  }
})

test('Mini Program group drawing follows seeded order and balanced capacities', () => {
  const teams = events.seedTeams([
    { sectId: 2, sectName: '乙', totalPoint: 10, mvp: 1, svp: 0, bgx: 0 },
    { sectId: 1, sectName: '甲', totalPoint: 10, mvp: 2, svp: 0, bgx: 1 },
    { sectId: 3, sectName: '丙', totalPoint: 8, mvp: 0, svp: 1, bgx: 0 },
    { sectId: 4, sectName: '丁', totalPoint: 7, mvp: 0, svp: 0, bgx: 0 },
    { sectId: 5, sectName: '戊', totalPoint: 6, mvp: 0, svp: 0, bgx: 0 },
  ])
  assert.deepEqual(teams.map((item) => item.sectId), [1, 2, 3, 4, 5])
  assert.deepEqual(events.groupCapacities(5), [2, 1, 1, 1])
  const assignments = []
  assignments.push(events.drawNextAssignment(teams, assignments, () => 0))
  assignments.push(events.drawNextAssignment(teams, assignments, () => 0.99))
  assert.deepEqual(assignments, [{ sectId: 1, group: 'A' }, { sectId: 2, group: 'D' }])

  const tolerance = events.seedTeams([
    { sectId: 1, totalPoint: 10, mvp: 1, svp: 0, bgx: 0 },
    { sectId: 2, totalPoint: 10.0005, mvp: 2, svp: 0, bgx: 0 },
  ])
  assert.deepEqual(tolerance.map((team) => team.sectId), [2, 1])
  const template = readFileSync('./apps/miniprogram/miniprogram/pages/group/index.wxml', 'utf8')
  assert.match(template, /待抽取/)
  assert.match(template, /just-drawn/)
})

test('Mini Program draw simulation removes one game and preserves tied ranks', () => {
  const data = {
    simulationReady: true,
    teams: [
      { sectId: 1, sectName: '甲', constantAdjustment: 3 },
      { sectId: 2, sectName: '乙', constantAdjustment: 0 },
    ],
    games: [
      { index: 1, complete: true, scores: [4, 5] },
      { index: 2, complete: true, scores: [2, 5] },
      { index: 3, complete: false, scores: [null, null] },
    ],
  }
  const scenario = events.calculateScenario(data, { 3: { 1: 7, 2: 5 } }, 1)
  assert.deepEqual(scenario.map((item) => [item.sectId, item.total, item.rank]), [[1, 14, 1], [2, 10, 2]])
  assert.deepEqual(events.rankWithTies([{ name: '甲', total: 8 }, { name: '乙', total: 8 }]).map((item) => item.rank), [1, 1])
})

function desktopDrawFixture(type, gameCount, removed, outside) {
  const ranks = []
  const players = []
  const fetched = []
  for (let team = 0; team < 12; team += 1) {
    let sum = 0
    const games = []
    for (let game = 0; game < gameCount; game += 1) {
      let point = game + 2 + team % 3
      if (game === removed && team === 2) point = -1.5
      games.push({
        game_id: 1000 + game, play_date: '2026-07-' + String(Math.floor(game / 3) + 1).padStart(2, '0'),
        round: game % 3 + 1, sect_id: team + 1, player_id: 200 + team,
        season_id: 28, season_type_id: Number(type), sect_name: '门派' + (team + 1), total_point: point,
      })
      sum += point
    }
    const bonus = type === '4' ? (team < 4 ? 5 : (team < 8 ? 3 : 0)) : 0
    ranks.push({ sectId: team + 1, sectName: '门派' + (team + 1), totalPoint: sum - games[removed].total_point + bonus + outside[team] })
    players.push({ playerId: 200 + team })
    fetched.push({ value: games, error: null })
  }
  return { ranks, players, fetched }
}

test('Mini Program draw builder matches desktop playoff and final inference vectors', () => {
  const playoffOutside = new Array(12).fill(0)
  playoffOutside[0] = -2
  const playoffFixture = desktopDrawFixture('4', 15, 7, playoffOutside)
  const playoff = events.buildDrawData(playoffFixture.ranks, playoffFixture.players, playoffFixture.fetched, '28', '4', 'SH')
  assert.equal(playoff.simulationReady, true)
  assert.equal(playoff.complete, true)
  assert.equal(playoff.officialDrawApplied, true)
  assert.equal(playoff.historicalRemovedGame, 1007)
  assert.deepEqual(
    [5, 3, 0].map((bonus) => playoff.teams.filter((team) => team.initialBonus === bonus).length),
    [4, 4, 4],
  )
  assert.deepEqual(
    [playoff.teams[0].outsideAdjustment, playoff.teams[0].constantAdjustment, playoff.games[7].scores[2], playoff.teams[2].outsideAdjustment],
    [-2, 3, -1.5, 0],
  )

  const finalOutside = new Array(12).fill(0)
  finalOutside[5] = -1
  const finalFixture = desktopDrawFixture('5', 16, 11, finalOutside)
  const final = events.buildDrawData(finalFixture.ranks, finalFixture.players, finalFixture.fetched, '28', '5', 'SH')
  assert.equal(final.simulationReady, true)
  assert.equal(final.historicalRemovedGame, 1011)
  assert.equal(final.expectedGames, 16)
  assert.equal(final.countedGames, 15)
  assert.deepEqual(final.teams.map((team) => team.initialBonus), new Array(12).fill(0))
  assert.deepEqual(final.teams.map((team) => team.outsideAdjustment), finalOutside)
})

test('Mini Program draw builder matches desktop partial, malformed, missing, and duplicate rules', () => {
  const outside = new Array(12).fill(0)
  outside[9] = -1
  const partialFixture = desktopDrawFixture('4', 3, 1, outside)
  partialFixture.ranks.forEach((rank, index) => { rank.totalPoint += partialFixture.fetched[index].value[1].total_point })
  partialFixture.fetched[0].value.push({ ...partialFixture.fetched[0].value[0] })
  const partial = events.buildDrawData(partialFixture.ranks, partialFixture.players, partialFixture.fetched, '28', '4', 'SH')
  assert.equal(partial.simulationReady, true)
  assert.equal(partial.complete, false)
  assert.equal(partial.completedGames, 3)
  assert.equal(partial.games.length, 15)
  assert.equal(partial.games[3].complete, false)
  assert.equal(partial.teams[0].constantAdjustment, 5)
  assert.equal(partial.teams[9].constantAdjustment, -1)

  const malformedFixture = desktopDrawFixture('5', 16, 11, new Array(12).fill(0))
  malformedFixture.ranks[0].totalPoint += 50
  const malformed = events.buildDrawData(malformedFixture.ranks, malformedFixture.players, malformedFixture.fetched, '28', '5', 'SH')
  assert.equal(malformed.simulationReady, true)
  assert.equal(malformed.historicalRemovedGame, 1011)
  assert.match(malformed.warnings.join(' '), /核对原始数据/)

  const missingFixture = desktopDrawFixture('5', 16, 11, new Array(12).fill(0))
  missingFixture.fetched[11].value = missingFixture.fetched[11].value.slice(0, 15)
  const missing = events.buildDrawData(missingFixture.ranks, missingFixture.players, missingFixture.fetched, '28', '5', 'SH')
  assert.equal(missing.simulationReady, false)
  assert.match(missing.warnings.join(' '), /缺少 1 个门派局分/)
})

test('Mini Program uses desktop rounding and sect suffix normalization', () => {
  assert.equal(events.round2(-1.005), -1)
  assert.equal(events.round2(-1.015), -1.01)
  assert.equal(events.baseSect('鱼乐会（鲁）'), '鱼乐会')
  assert.equal(events.baseSect('鱼乐会俱乐部'), '鱼乐会俱乐部')
  assert.equal(shared.round2(-2.125), -2.13)
})

test('Mini Program draw projections persist per zone, season, and competition type', () => {
  const previousWx = global.wx
  const storage = new Map()
  global.wx = {
    getStorageSync(key) { return storage.get(key) || {} },
    setStorageSync(key, value) { storage.set(key, value) },
  }
  const data = {
    zone: 'SH', season: '30', seasonType: '5',
    teams: [{ sectId: 1 }, { sectId: 2 }],
    games: [{ index: 1, complete: true }, { index: 2, complete: false }],
  }
  try {
    drawProjections.save(data, { 2: { 1: 4, 2: 5 }, 3: { 1: 9 } })
    assert.equal(drawProjections.storageKey('SH', '30', '5'), 'huashan-draw-projections:SH:30:5')
    assert.deepEqual(drawProjections.load(data), { 2: { 1: 4, 2: 5 } })
  } finally {
    if (previousWx === undefined) delete global.wx
    else global.wx = previousWx
  }
})

test('Mini Program toolbox exposes the complete rule catalog and all three tools', () => {
  assert.equal(rules.RULE_VERSION, '2026.4.4')
  assert.equal(rules.RULE_ARTICLES.length, 20)
  assert.equal(rules.search('梦魇守卫')[0].id, 'edition-nightmare')
  assert.ok(rules.search('投票').some((item) => item.id === 'vote-score'))

  const app = JSON.parse(readFileSync('./apps/miniprogram/miniprogram/app.json', 'utf8'))
  const home = readFileSync('./apps/miniprogram/miniprogram/pages/home/index.wxml', 'utf8')
  const tools = readFileSync('./apps/miniprogram/miniprogram/pages/tools/index.wxml', 'utf8')
  for (const page of ['pages/events/index', 'pages/tools/index', 'pages/rules/index', 'pages/draw/index', 'pages/group/index']) {
    assert.ok(app.pages.includes(page))
  }
  assert.doesNotMatch(home, /尚未开放/)
  assert.match(tools, /华山规则速查[\s\S]*抽局积分模拟[\s\S]*分组模拟/)
})
