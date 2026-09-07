const compare = require('../../services/compare')
const compareBasket = require('../../services/compare-basket')
const huashan = require('../../services/huashan')
const profileCrest = require('../../services/profile-crest')
const replay = require('../../services/replay')
const core = require('../../services/shared')
const themeStore = require('../../services/theme')
const tokenStore = require('../../services/token')

const DEEP_WORKERS = 4
const SHARED_PAGE_SIZE = 10

function emptyRecord(player) {
  return {
    player,
    head: null,
    full: null,
    loadingHead: false,
    loadingFull: false,
    headError: '',
    fullError: '',
  }
}

Page({
  data: {
    basket: [],
    basketCount: 0,
    columns: [],
    customOptions: [],
    deepLoaded: 0,
    deepMode: 'matrix',
    deepTotal: 0,
    editionIndex: 0,
    editionOptions: ['全部版型'],
    empty: false,
    failedCount: 0,
    group: 'summary',
    hiddenCount: 0,
    layer: 'shallow',
    metricIndex: 1,
    metricOptions: compare.ROLE_METRICS.map((item) => item.label),
    matrixPlayers: [],
    matrixRows: [],
    matrixGridStyle: '',
    orderOptions: ['最新在前', '最早在前'],
    players: [],
    roleIndex: 0,
    roleOptions: ['选择身份'],
    seasonIndex: 0,
    seasonOptions: ['全部赛季'],
    seasonText: '',
    sharedCount: 0,
    sharedDetails: [],
    sharedEdition: '',
    sharedFilteredCount: 0,
    sharedHasMore: false,
    sharedMode: 'summary',
    sharedOrder: 'desc',
    sharedReady: false,
    sortDirection: 'desc',
    sortKey: '',
    statusText: '',
    theme: 'dark',
    warning: '',
    zoneIndex: 0,
    zoneOptions: ['全部赛区'],
    replay: null,
    replayError: '',
    replayLoading: false,
    replayMode: 'seat',
    replayOpen: false,
  },

  onLoad() {
    this.setData(themeStore.pageData())
    if (!tokenStore.hasToken()) {
      wx.reLaunch({ url: '/pages/session/index' })
      return
    }
    this.records = new Map()
    this.hidden = new Set()
    this.custom = compare.cloneDefaultCustom()
    this.scope = { zone: 'ALL', season: '' }
    this.sort = { key: '', direction: 'desc' }
    this.layer = 'shallow'
    this.group = 'summary'
    this.deepMode = 'matrix'
    this.metric = 'avg'
    this.role = ''
    this.sharedMode = 'summary'
    this.sharedEdition = ''
    this.sharedOrder = 'desc'
    this.sharedLimit = SHARED_PAGE_SIZE
    this.zoneValues = ['ALL']
    this.seasonValues = ['']
    this.editionValues = ['']
    this.sharedGamesCache = null
    this.scopeGeneration = 0
    this.replayGeneration = 0
    this.syncBasket()
  },

  onShow() {
    if (this.records) this.syncBasket()
  },

  onUnload() {
    this.scopeGeneration += 1
    this.replayGeneration += 1
    this.records.forEach((record) => huashan.cancelPlayerRequests(record.player.playerId))
  },

  orderedRecords() {
    return compareBasket.items().map((player) => this.records.get(player.playerId) || emptyRecord(player))
  },

  sharedGamesFor(records) {
    const signature = records.map((record) => record.full && record.full.games)
    const cached = this.sharedGamesCache
    if (cached && cached.signature.length === signature.length
      && signature.every((games, index) => games === cached.signature[index])) return cached.value
    const value = compare.sharedGames(records)
    this.sharedGamesCache = { signature, value }
    return value
  },

  syncBasket() {
    const basket = compareBasket.items()
    const active = new Set(basket.map((player) => player.playerId))
    ;[...this.records.keys()].forEach((playerId) => {
      if (!active.has(playerId)) this.records.delete(playerId)
    })
    ;[...this.hidden].forEach((playerId) => {
      if (!active.has(playerId)) this.hidden.delete(playerId)
    })
    basket.forEach((player) => {
      const current = this.records.get(player.playerId)
      if (current) current.player = player
      else this.records.set(player.playerId, emptyRecord(player))
    })
    this.render()
    if (!basket.length) return
    this.loadHeads()
    if (this.layer !== 'shallow') this.loadDeep()
  },

  authExpired(error, generation) {
    if (!error || error.code !== 'TOKEN_EXPIRED' || generation !== this.scopeGeneration) return false
    this.scopeGeneration += 1
    huashan.clearDataCache()
    compareBasket.clear()
    wx.reLaunch({ url: '/pages/session/index' })
    return true
  },

  async loadHeads() {
    const generation = this.scopeGeneration
    const pending = this.orderedRecords().filter((record) => !record.head && !record.loadingHead)
    if (!pending.length) return
    pending.forEach((record) => {
      record.loadingHead = true
      record.headError = ''
    })
    this.render()
    await Promise.all(pending.map(async (record) => {
      try {
        const payload = await huashan.playerStats(record.player.playerId, this.scope)
        if (generation !== this.scopeGeneration) return
        record.head = huashan.playerDetailView(payload, record.player)
      } catch (error) {
        if (this.authExpired(error, generation)) return
        if (generation === this.scopeGeneration) record.headError = '概览暂时无法读取'
      } finally {
        if (generation === this.scopeGeneration) {
          record.loadingHead = false
          this.render()
        }
      }
    }))
  },

  async loadDeep() {
    if (this.deepLoadingRequest) {
      this.deepReloadQueued = true
      return
    }
    const generation = this.scopeGeneration
    const pending = this.orderedRecords().filter((record) => !record.full && !record.loadingFull && !record.fullError)
    if (!pending.length) return
    this.deepLoadingRequest = true
    pending.forEach((record) => {
      record.loadingFull = true
      record.fullError = ''
    })
    this.render()
    try {
      await core.mapLimit(pending, DEEP_WORKERS, async (record) => {
        try {
          const result = await huashan.loadAllPlayerGames(record.player.playerId, null, this.scope)
          if (generation !== this.scopeGeneration) return
          const games = huashan.gameItems(result.items)
          record.full = {
            games,
            roles: huashan.roleBreakdown(games),
            seasonCandidates: result.seasonCandidates || [],
            truncated: !!result.truncated,
          }
        } catch (error) {
          if (this.authExpired(error, generation)) return
          if (generation === this.scopeGeneration) record.fullError = '完整战绩暂时无法读取'
        } finally {
          if (generation === this.scopeGeneration) {
            record.loadingFull = false
            this.render()
          }
        }
      })
    } finally {
      this.deepLoadingRequest = false
      const queued = this.deepReloadQueued
      this.deepReloadQueued = false
      const remaining = this.orderedRecords().some((record) => !record.full && !record.loadingFull && !record.fullError)
      if (this.layer !== 'shallow' && (queued || remaining)) this.loadDeep()
    }
  },

  render() {
    const records = this.orderedRecords()
    const basket = records.map((record) => ({
      ...record.player,
      hidden: this.hidden.has(record.player.playerId),
    }))
    const joined = new Map()
    records.forEach((record) => ((record.head && record.head.joined) || []).forEach((zone) => {
      if (zone && zone.ordering && !joined.has(zone.ordering)) joined.set(zone.ordering, zone.text || zone.ordering)
    }))
    this.zoneValues = ['ALL', ...joined.keys()]
    const zoneOptions = ['全部赛区', ...joined.values()]
    const seasons = compare.seasonOptions(records)
    this.seasonValues = ['', ...seasons.map(String)]
    const seasonOptions = ['全部赛季', ...seasons.map((season) => 'S' + season)]
    const roles = compare.roleUnion(records)
    const roleOptions = ['选择身份', ...roles]
    const deepLoaded = records.filter((record) => record.full || record.fullError).length
    const deepPending = records.filter((record) => record.loadingFull || (!record.full && !record.fullError)).length
    const deepFailed = records.filter((record) => record.fullError).map((record) => record.player.name)
    const deepReady = !!records.length && records.every((record) => record.full)
    const headPending = records.filter((record) => record.loadingHead || (!record.head && !record.headError)).length
    const headFailed = records.filter((record) => record.headError).map((record) => record.player.name)
    const truncated = records.filter((record) => record.full && record.full.truncated)
    let view = { columns: [], players: [] }
    let shared = []
    let detailView = { editions: [], filteredCount: 0, hasMore: false, shown: [] }

    if (this.layer === 'shallow') {
      view = compare.shallowView(records, this.group, this.custom, this.hidden, this.sort)
    } else if (this.layer === 'deep') {
      view = this.deepMode === 'matrix'
        ? compare.identityMatrix(records, this.metric, this.hidden, this.sort)
        : (this.role ? compare.identitySingle(records, this.role, this.hidden, this.sort) : view)
    } else if (deepReady && records.length >= 2) {
      shared = this.sharedGamesFor(records)
      if (this.sharedMode === 'summary') {
        view = compare.sharedSummary(records, shared, this.hidden, this.sort)
      } else {
        detailView = compare.sharedDetails(
          records, shared, this.hidden, this.sharedEdition, this.sharedOrder, this.sharedLimit,
        )
      }
    }

    this.editionValues = ['', ...detailView.editions]
    let statusText = ''
    let warning = ''
    if (this.layer === 'shallow' && headPending) {
      statusText = '正在读取选手概览。'
    } else if (this.layer === 'shallow' && headFailed.length && !view.columns.length) {
      statusText = headFailed.join('、') + '的概览暂时无法读取。'
    } else if (this.layer !== 'shallow' && deepPending) {
      statusText = '正在整理完整战绩，已完成 ' + deepLoaded + '/' + records.length + ' 人。'
    } else if (this.layer !== 'shallow' && deepFailed.length) {
      statusText = deepFailed.join('、') + '的数据暂时无法读取。'
    } else if (this.layer === 'deep' && deepReady && !roles.length) {
      statusText = '当前范围暂无身份数据。'
    } else if (this.layer === 'deep' && this.deepMode === 'byrole' && !this.role) {
      statusText = '选择一个身份后查看对比。'
    } else if (this.layer === 'shared' && records.length < 2) {
      statusText = '至少选择 2 名选手后才能查找共同对局。'
    } else if (this.layer === 'shared' && deepReady && !shared.length) {
      statusText = truncated.length
        ? '在已读取的数据中没有找到共同对局，结果可能不完整。'
        : '所选选手没有共同参加的对局。'
    }
    if (truncated.length && this.layer !== 'shallow' && shared.length) {
      warning = '部分选手的战绩不完整，当前结果可能遗漏共同对局。'
    }

    const scopeZoneIndex = Math.max(0, this.zoneValues.indexOf(this.scope.zone))
    const scopeSeasonIndex = Math.max(0, this.seasonValues.indexOf(this.scope.season))
    const editionIndex = Math.max(0, this.editionValues.indexOf(this.sharedEdition))
    const matrixPlayers = view.players.map((player) => ({
      ...player,
      honorText: player.honors.map((honor) => honor.text).filter(Boolean).join(' · '),
      profileCrest: profileCrest.resolve(
        profileCrest.candidates(String(player.sect || '').split(' · ')),
        profileCrest.load(player.playerId),
      ),
    }))
    const matrixRows = view.columns.map((column, index) => ({
      ...column,
      values: matrixPlayers.map((player) => ({
        ...(player.values[index] || { value: '—', best: false }),
        error: player.error,
        playerId: player.playerId,
      })),
    }))
    const matrixGridWidth = Math.max(656, 140 + matrixPlayers.length * 224)
    const sharedDetails = detailView.shown.map((game) => ({
      ...game,
      playerWidth: Math.max(520, game.players.length * 226),
    }))
    core.setDataDiff(this, {
      basket,
      basketCount: basket.length,
      columns: view.columns,
      customOptions: compare.customOptions(records, this.custom),
      deepLoaded,
      deepMode: this.deepMode,
      deepTotal: records.length,
      editionIndex,
      editionOptions: ['全部版型', ...detailView.editions],
      empty: basket.length === 0,
      failedCount: records.filter((record) => record.headError || record.fullError).length,
      group: this.group,
      hiddenCount: this.hidden.size,
      layer: this.layer,
      metricIndex: Math.max(0, compare.ROLE_METRICS.findIndex((item) => item.key === this.metric)),
      matrixGridStyle: 'width:' + matrixGridWidth + 'rpx;grid-template-columns:140rpx repeat(' + matrixPlayers.length + ',minmax(224rpx,1fr));',
      matrixPlayers,
      matrixRows,
      players: view.players,
      roleIndex: Math.max(0, roles.indexOf(this.role) + 1),
      roleOptions,
      seasonIndex: scopeSeasonIndex,
      seasonOptions,
      seasonText: this.scope.season ? 'S' + this.scope.season : '',
      sharedCount: shared.length,
      sharedDetails,
      sharedEdition: this.sharedEdition,
      sharedFilteredCount: detailView.filteredCount,
      sharedHasMore: detailView.hasMore,
      sharedMode: this.sharedMode,
      sharedOrder: this.sharedOrder,
      sharedReady: deepReady,
      sortDirection: this.sort.direction,
      sortKey: this.sort.key,
      statusText,
      warning,
      zoneIndex: scopeZoneIndex,
      zoneOptions,
    })
  },

  changeLayer(event) {
    const layer = event.currentTarget.dataset.layer
    if (!['shallow', 'deep', 'shared'].includes(layer)) return
    this.layer = layer
    this.sort = { key: '', direction: 'desc' }
    this.render()
    if (layer !== 'shallow') this.loadDeep()
  },

  changeGroup(event) {
    this.group = event.currentTarget.dataset.group || 'summary'
    this.sort = { key: '', direction: 'desc' }
    this.render()
  },

  toggleCustom(event) {
    const group = event.currentTarget.dataset.group
    const key = event.currentTarget.dataset.key
    const index = this.custom.findIndex((pair) => pair[0] === group && pair[1] === key)
    if (index >= 0) this.custom.splice(index, 1)
    else this.custom.push([group, key])
    this.render()
  },

  changeDeepMode(event) {
    this.deepMode = event.currentTarget.dataset.mode === 'byrole' ? 'byrole' : 'matrix'
    this.sort = { key: '', direction: 'desc' }
    this.render()
  },

  onMetricChange(event) {
    const selected = compare.ROLE_METRICS[Number(event.detail.value)] || compare.ROLE_METRICS[1]
    this.metric = selected.key
    this.sort = { key: '', direction: 'desc' }
    this.render()
  },

  onRoleChange(event) {
    const index = Number(event.detail.value) || 0
    this.role = index ? this.data.roleOptions[index] : ''
    this.sort = { key: '', direction: 'desc' }
    this.render()
  },

  changeSharedMode(event) {
    this.sharedMode = event.currentTarget.dataset.mode === 'games' ? 'games' : 'summary'
    this.sort = { key: '', direction: 'desc' }
    this.sharedLimit = SHARED_PAGE_SIZE
    this.render()
  },

  sortBy(event) {
    const key = event.currentTarget.dataset.key
    if (!key) return
    if (this.sort.key === key) this.sort.direction = this.sort.direction === 'desc' ? 'asc' : 'desc'
    else this.sort = { key, direction: 'desc' }
    this.render()
  },

  hidePlayer(event) {
    const playerId = String(event.currentTarget.dataset.id || '')
    if (playerId) this.hidden.add(playerId)
    this.render()
  },

  showAllPlayers() {
    this.hidden.clear()
    this.render()
  },

  removePlayer(event) {
    const playerId = String(event.currentTarget.dataset.id || '')
    compareBasket.remove(playerId)
    this.records.delete(playerId)
    this.hidden.delete(playerId)
    this.syncBasket()
  },

  clearBasket() {
    wx.showModal({
      title: '清空对比篮？',
      content: '已选择的选手将全部移出。',
      confirmText: '清空',
      success: (result) => {
        if (!result.confirm) return
        compareBasket.clear()
        this.records.clear()
        this.hidden.clear()
        this.render()
      },
    })
  },

  addPlayers() {
    wx.navigateTo({ url: '/pages/search/index?mode=compare&return=compare' })
  },

  openPlayer(event) {
    const playerId = String(event.currentTarget.dataset.id || '')
    const record = this.records.get(playerId)
    if (!record) return
    const player = record.player
    const query = [
      ['playerId', player.playerId],
      ['name', player.name],
      ['avatar', player.avatar],
      ['sect', player.sect],
    ].map(([key, value]) => key + '=' + encodeURIComponent(value || '')).join('&')
    wx.navigateTo({ url: '/pages/player/index?' + query })
  },

  resetScopeData() {
    this.scopeGeneration += 1
    this.records.forEach((record) => {
      huashan.cancelPlayerRequests(record.player.playerId)
      record.head = null
      record.full = null
      record.loadingHead = false
      record.loadingFull = false
      record.headError = ''
      record.fullError = ''
    })
    this.role = ''
    this.sharedEdition = ''
    this.sharedLimit = SHARED_PAGE_SIZE
    this.sort = { key: '', direction: 'desc' }
    this.sharedGamesCache = null
    this.render()
    this.loadHeads()
    if (this.layer !== 'shallow') this.loadDeep()
  },

  onZoneChange(event) {
    const zone = this.zoneValues[Number(event.detail.value)] || 'ALL'
    if (zone === this.scope.zone) return
    this.scope = { zone, season: '' }
    this.resetScopeData()
  },

  onSeasonChange(event) {
    const season = this.seasonValues[Number(event.detail.value)] || ''
    if (season === this.scope.season) return
    this.scope.season = season
    this.resetScopeData()
  },

  onSeasonInput(event) {
    const raw = String(event.detail.value || '').trim()
    const match = raw.match(/^S?(\d+)$/i)
    if (raw && !match) {
      wx.showToast({ title: '请输入赛季号，如 S30', icon: 'none' })
      this.setData({ seasonText: this.scope.season ? 'S' + this.scope.season : '' })
      return
    }
    const season = match ? match[1] : ''
    if (season === this.scope.season) return
    this.scope.season = season
    this.resetScopeData()
  },

  onEditionChange(event) {
    this.sharedEdition = this.editionValues[Number(event.detail.value)] || ''
    this.sharedLimit = SHARED_PAGE_SIZE
    this.render()
  },

  onSharedOrderChange(event) {
    this.sharedOrder = Number(event.detail.value) === 1 ? 'asc' : 'desc'
    this.sharedLimit = SHARED_PAGE_SIZE
    this.render()
  },

  showMoreShared() {
    this.sharedLimit += SHARED_PAGE_SIZE
    this.render()
  },

  retryFailed() {
    this.records.forEach((record) => {
      if (record.headError) record.headError = ''
      if (record.fullError) record.fullError = ''
    })
    this.render()
    this.loadHeads()
    if (this.layer !== 'shallow') this.loadDeep()
  },

  async openReplay(event) {
    const gameId = String(event.currentTarget.dataset.id || '')
    if (!gameId) return
    const records = this.orderedRecords()
    const selected = records.find((record) => !this.hidden.has(record.player.playerId)) || records[0]
    const playerId = selected ? selected.player.playerId : ''
    const playerGame = selected && selected.full
      ? selected.full.games.find((game) => game.gameId === gameId) || null
      : null
    const generation = ++this.replayGeneration
    this.setData({ replay: null, replayError: '', replayLoading: true, replayMode: 'seat', replayOpen: true })
    try {
      const payload = await huashan.playerGame(gameId)
      if (generation !== this.replayGeneration) return
      this.setData({ replay: replay.replayView(payload, playerId, playerGame), replayLoading: false })
    } catch (error) {
      if (generation !== this.replayGeneration) return
      if (this.authExpired(error, this.scopeGeneration)) return
      this.setData({ replayError: '单局复盘暂时无法读取，请稍后重试。', replayLoading: false })
    }
  },

  closeReplay() {
    this.replayGeneration += 1
    this.setData({ replay: null, replayError: '', replayLoading: false, replayOpen: false })
  },

  stopReplayTap() {},

  setReplayMode(event) {
    const mode = event.currentTarget.dataset.mode
    if (mode === 'seat' || mode === 'day') this.setData({ replayMode: mode })
  },
})
