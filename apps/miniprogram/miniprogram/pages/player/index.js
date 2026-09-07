const huashan = require('../../services/huashan')
const compareBasket = require('../../services/compare-basket')
const profileCrest = require('../../services/profile-crest')
const profileRadar = require('../../services/profile-radar')
const replay = require('../../services/replay')
const shared = require('../../services/shared')
const themeStore = require('../../services/theme')
const tokenStore = require('../../services/token')

const DISPLAY_PAGE_SIZE = 20
const ROLE_SORT_OPTIONS = [
  { key: 'games', label: '场次' },
  { key: 'totalPoint', label: '总分' },
  { key: 'avg', label: '场均分' },
  { key: 'winValue', label: '胜率' },
  { key: 'mvp', label: 'MVP' },
  { key: 'svp', label: '尽力' },
  { key: 'bgx', label: '背锅' },
]
const EDITION_SORT_OPTIONS = [
  ...ROLE_SORT_OPTIONS.slice(0, 4),
  { key: 'wolfRateValue', label: '摸狼率' },
  ...ROLE_SORT_OPTIONS.slice(4),
]

function settled(promise) {
  return promise.then(
    (value) => ({ value }),
    (error) => ({ error }),
  )
}

function option(value) {
  if (!value) return ''
  try {
    return decodeURIComponent(value)
  } catch (_) {
    return value
  }
}

function emptyFilters() {
  return { role: '', sect: '', result: '', camp: '', mark: '' }
}

Page({
  data: {
    activeTab: 'overview',
    activeFilterCount: 0,
    dateSortMark: '↓',
    editionQuery: '',
    error: '',
    editionRows: [],
    editionSortIndex: 0,
    editionSortMark: '↓',
    editionSortOptions: EDITION_SORT_OPTIONS.map((item) => item.label),
    filterReady: false,
    filters: emptyFilters(),
    filteredCount: 0,
    games: [],
    gamesCountText: '',
    gamesError: '',
    gamesLoading: true,
    gamesProgress: '',
    gamesWarning: '',
    hasMoreGames: false,
    hiddenTeamCount: 0,
    loading: true,
    overviewSections: [],
    player: null,
    pointSortMark: '↕',
    profileCrest: null,
    profileCrestCandidates: [],
    profileCrestControlLabel: '',
    profileCrestNeedsChoice: false,
    profileCrestPickerOpen: false,
    radar: { axes: [], complete: false, missingText: '', options: [], selectedCount: profileRadar.MIN },
    radarLoading: true,
    radarPickerOpen: false,
    roleIndex: 0,
    roleCamp: '',
    roleOptions: ['全部身份'],
    theme: 'dark',
    roleRows: [],
    roleSortIndex: 0,
    roleSortMark: '↓',
    roleSortOptions: ROLE_SORT_OPTIONS.map((item) => item.label),
    replay: null,
    replayError: '',
    replayLoading: false,
    replayMode: 'seat',
    replayOpen: false,
    gameSectIndex: 0,
    gameSectOptions: ['全部门派记录'],
    scopeSectIndex: 0,
    scopeSectOptions: ['全部门派'],
    scopeSeasonIndex: 0,
    scopeSeasonOptions: ['全部赛季'],
    scopeZoneIndex: 0,
    scopeZoneOptions: ['全部赛区'],
    sortDirection: 'desc',
    sortKey: 'date',
    statsError: '',
    teamExpanded: false,
    visibleTeams: [],
  },

  onLoad(options) {
    this.setData(themeStore.pageData())
    if (!tokenStore.hasToken()) {
      wx.reLaunch({ url: '/pages/session/index' })
      return
    }
    this.playerId = option(options.playerId)
    this.profileCrestChoice = profileCrest.load(this.playerId)
    this.radarSelection = profileRadar.load()
    this.fallback = {
      playerId: this.playerId,
      name: option(options.name),
      avatar: option(options.avatar),
      sect: option(options.sect),
    }
    this.allGames = []
    this.zoneGames = []
    this.statsPayload = null
    this.scope = { zone: 'ALL', season: '', sect: '' }
    this.zoneValues = ['ALL']
    this.seasonValues = ['']
    this.scopeSectValues = ['']
    this.allEditionRows = []
    this.allRoleRows = []
    this.filterOptions = { roles: [], sects: [] }
    this.filters = emptyFilters()
    this.sort = { key: 'date', direction: 'desc' }
    this.editionQuery = ''
    this.editionSort = { key: 'games', direction: 'desc' }
    this.roleCamp = ''
    this.roleSort = { key: 'games', direction: 'desc' }
    this.visibleLimit = DISPLAY_PAGE_SIZE
    this.teamNames = String(this.fallback.sect || '').split(' · ')
      .map((name) => name.trim())
      .filter((name) => name && name !== '暂无门派信息')
    this.teamExpanded = false
    this.teamMeasureGeneration = 0
    this.replayGeneration = 0
    this.loadGeneration = 0
    if (!this.playerId) {
      this.setData({ error: '无法识别这位选手，请返回重新选择。', loading: false })
      return
    }
    this.setData({ player: huashan.playerDetailView(null, this.fallback) })
    this.updateTeamDisplay()
    this.loadPlayer()
  },

  onUnload() {
    this.loadGeneration += 1
    this.replayGeneration += 1
    this.teamMeasureGeneration += 1
    huashan.cancelPlayerRequests(this.playerId)
  },

  onResize() {
    if (!this.teamExpanded && this.teamNames.length) this.updateTeamDisplay()
    this.drawProfileRadar()
  },

  resetGameView() {
    this.allGames = []
    this.allEditionRows = []
    this.allRoleRows = []
    this.filterOptions = { roles: [], sects: [] }
    this.filters = emptyFilters()
    this.sort = { key: 'date', direction: 'desc' }
    this.editionQuery = ''
    this.editionSort = { key: 'games', direction: 'desc' }
    this.roleCamp = ''
    this.roleSort = { key: 'games', direction: 'desc' }
    this.visibleLimit = DISPLAY_PAGE_SIZE
  },

  updateScopeOptions(joined) {
    if (Array.isArray(joined)) {
      const options = [{ value: 'ALL', label: '全部赛区' }]
      const seen = new Set(['ALL'])
      joined.forEach((zone) => {
        const value = String(zone && zone.ordering || '')
        if (!value || seen.has(value)) return
        seen.add(value)
        options.push({ value, label: zone.text || value })
      })
      if (!seen.has(this.scope.zone)) options.push({ value: this.scope.zone, label: this.scope.zone })
      this.zoneValues = options.map((item) => item.value)
      this.setData({
        scopeZoneIndex: Math.max(0, this.zoneValues.indexOf(this.scope.zone)),
        scopeZoneOptions: options.map((item) => item.label),
      })
    }
    const candidates = huashan.scopeCandidates(this.zoneGames, this.scope)
    this.seasonValues = ['', ...candidates.seasons.map(String)]
    this.scopeSectValues = ['', ...candidates.sects]
    this.setData({
      scopeSeasonIndex: Math.max(0, this.seasonValues.indexOf(this.scope.season)),
      scopeSeasonOptions: ['全部赛季', ...candidates.seasons.map((season) => 'S' + season)],
      scopeSectIndex: Math.max(0, this.scopeSectValues.indexOf(this.scope.sect)),
      scopeSectOptions: ['全部门派', ...candidates.sects],
    })
  },

  updateScopedPlayer() {
    if (!this.statsPayload) return
    const player = huashan.playerDetailForSect(
      this.statsPayload,
      this.fallback,
      huashan.scopedGames(this.zoneGames, { season: this.scope.season }),
      this.scope.sect,
    )
    const radar = profileRadar.view(profileRadar.groupsFromSections(player.overviewSections), this.radarSelection)
    this.setData({ overviewSections: player.overviewSections, player, radar, radarLoading: false }, () => this.drawProfileRadar())
    this.updateScopeOptions(player.joined)
    wx.setNavigationBarTitle({ title: player.name || '选手详情' })
  },

  rebuildScopedGames() {
    this.updateScopeOptions()
    this.allGames = huashan.scopedGames(this.zoneGames, this.scope)
    this.filterOptions = huashan.gameFilterOptions(this.allGames)
    this.allEditionRows = huashan.editionBreakdown(this.allGames)
    this.allRoleRows = huashan.roleBreakdown(this.allGames)
    this.filters = emptyFilters()
    this.editionQuery = ''
    this.editionSort = { key: 'games', direction: 'desc' }
    this.roleCamp = ''
    this.roleSort = { key: 'games', direction: 'desc' }
    this.visibleLimit = DISPLAY_PAGE_SIZE
    this.teamNames = this.filterOptions.sects.slice()
    this.teamExpanded = false
    this.updateTeamDisplay()
    this.setData({
      editionQuery: '',
      editionSortIndex: 0,
      editionSortMark: '↓',
      filters: emptyFilters(),
      roleIndex: 0,
      roleCamp: '',
      roleOptions: ['全部身份', ...this.filterOptions.roles],
      roleSortIndex: 0,
      roleSortMark: '↓',
      gameSectIndex: 0,
      gameSectOptions: ['全部门派记录', ...this.filterOptions.sects],
    })
    this.updateScopedPlayer()
    this.renderPerformance()
    this.renderGames()
  },

  updateTeamDisplay(names) {
    if (Array.isArray(names) && names.length) {
      const completeNames = [...this.teamNames, ...names]
      this.teamNames = [...new Set(completeNames.map((name) => String(name || '').trim()).filter(Boolean))]
    }
    const allNames = this.teamNames.slice()
    const crestCandidates = profileCrest.candidates(allNames)
    const selectedCrest = profileCrest.resolve(crestCandidates, this.profileCrestChoice)
    const generation = ++this.teamMeasureGeneration
    this.setData({
      hiddenTeamCount: 0,
      profileCrest: selectedCrest,
      profileCrestCandidates: crestCandidates,
      profileCrestControlLabel: selectedCrest
        ? selectedCrest.name
        : (this.profileCrestChoice === 'none' ? '不显示' : '选择队徽 · ' + crestCandidates.length),
      profileCrestNeedsChoice: crestCandidates.length > 1
        && !selectedCrest
        && this.profileCrestChoice !== 'none',
      teamExpanded: this.teamExpanded,
      visibleTeams: allNames,
    })
    if (this.teamExpanded || allNames.length < 2) return
    wx.nextTick(() => this.measureTeamOverflow(generation))
  },

  measureTeamOverflow(generation) {
    const query = wx.createSelectorQuery().in(this)
    query.selectAll('.team-chip').boundingClientRect()
    query.exec((results) => {
      if (generation !== this.teamMeasureGeneration || this.teamExpanded) return
      const chips = Array.isArray(results && results[0]) ? results[0] : []
      const rowTops = []
      chips.forEach((chip) => {
        if (!rowTops.some((top) => Math.abs(top - chip.top) < 2)) rowTops.push(chip.top)
      })
      if (rowTops.length <= 3) return
      const cutoff = rowTops[3] - 2
      const visibleCount = Math.max(1, chips.filter((chip) => chip.top < cutoff).length)
      this.setData({
        hiddenTeamCount: this.teamNames.length - visibleCount,
        visibleTeams: this.teamNames.slice(0, visibleCount),
      })
    })
  },

  toggleTeams() {
    this.teamExpanded = !this.teamExpanded
    this.updateTeamDisplay()
  },

  showProfileCrestPicker() {
    if (!this.data.profileCrestCandidates.length) return
    this.setData({ profileCrestPickerOpen: true })
  },

  closeProfileCrestPicker() {
    this.setData({ profileCrestPickerOpen: false })
  },

  stopProfileCrestTap() {},

  onCrestImageLoad: themeStore.onCrestImageLoad,

  onCrestImageError: themeStore.onCrestImageError,

  selectProfileCrest(event) {
    const choice = String(event.currentTarget.dataset.choice || '')
    if (choice !== 'none' && !this.data.profileCrestCandidates.some((item) => item.id === choice)) return
    this.profileCrestChoice = choice
    profileCrest.save(this.playerId, choice)
    this.setData({ profileCrestPickerOpen: false })
    this.updateTeamDisplay()
  },

  toggleRadarPicker() {
    const radarPickerOpen = !this.data.radarPickerOpen
    this.setData({ radarPickerOpen }, () => {
      if (!radarPickerOpen) this.drawProfileRadar()
    })
  },

  closeRadarPicker() {
    this.setData({ radarPickerOpen: false }, () => this.drawProfileRadar())
  },

  stopRadarPickerTap() {},

  toggleRadarMetric(event) {
    const id = String(event.currentTarget.dataset.id || '')
    const option = this.data.radar.options.find((item) => item.id === id)
    if (!option || option.disabled) return
    this.radarSelection = profileRadar.save(profileRadar.toggle(this.radarSelection, id, !option.selected))
    this.updateScopedPlayer()
  },

  resetRadarMetrics() {
    this.radarSelection = profileRadar.save(profileRadar.DEFAULTS)
    this.updateScopedPlayer()
  },

  drawProfileRadar() {
    if (this.data.activeTab !== 'overview' || this.data.radarPickerOpen || !this.data.radar.complete) return
    wx.nextTick(() => {
      const query = wx.createSelectorQuery().in(this)
      query.select('#profile-radar').fields({ node: true, size: true })
      query.exec((result) => {
        const target = result && result[0]
        if (!target || !target.node || !target.width || !target.height) return
        profileRadar.draw(target.node, target.width, target.height, this.data.radar, this.data.theme)
      })
    })
  },

  refreshPlayer() {
    if (this.loadingRequest) return
    wx.showModal({
      title: '更新这位选手的数据？',
      content: '将更新概览、身份表现、版型表现和逐场战绩。',
      confirmText: '重新读取',
      success: (result) => {
        if (!result.confirm) return
        huashan.clearPlayerDataCache(this.playerId)
        this.zoneGames = []
        this.statsPayload = null
        this.loadPlayer()
      },
    })
  },

  redirectForAuth(error, generation) {
    if (!error || error.code !== 'TOKEN_EXPIRED' || generation !== this.loadGeneration) return false
    this.redirected = true
    this.loadGeneration += 1
    huashan.clearDataCache()
    compareBasket.clear()
    wx.reLaunch({ url: '/pages/session/index' })
    return true
  },

  showFirstGames(page, generation) {
    if (generation !== this.loadGeneration) return
    this.allGames = huashan.gameItems(page.items)
    const preview = huashan.filteredGames(this.allGames, this.filters, this.sort)
    this.setData({
      filteredCount: preview.length,
      games: preview.slice(0, DISPLAY_PAGE_SIZE),
      gamesCountText: page.totalKnown
        ? this.allGames.length + '/' + page.total + ' 场'
        : '已读取 ' + this.allGames.length + ' 场',
      gamesProgress: '正在整理身份、版型和逐场战绩，已读取 ' + this.allGames.length + ' 场。',
    })
  },

  showGameProgress(progress, generation) {
    if (generation !== this.loadGeneration) return
    this.setData({
      gamesCountText: progress.totalKnown
        ? progress.loadedItems + '/' + progress.total + ' 场'
        : '已读取 ' + progress.loadedItems + ' 场',
      gamesProgress: '正在整理身份、版型和逐场战绩，已读取 '
        + progress.loadedItems + ' 场。',
    })
  },

  finishGames(result, generation) {
    if (generation !== this.loadGeneration) return
    this.zoneGames = huashan.gameItems(result.items)
    this.setData({
      filterReady: true,
      editionRows: [],
      gamesLoading: false,
      gamesProgress: '',
      gamesWarning: result.truncated
        ? '部分历史战绩暂时无法读取，当前结果可能不完整。'
        : '',
      roleRows: [],
    })
    this.rebuildScopedGames()
  },

  renderPerformance() {
    this.setData({
      editionQuery: this.editionQuery,
      editionRows: huashan.filteredBreakdown(
        this.allEditionRows,
        { query: this.editionQuery },
        this.editionSort,
      ),
      editionSortMark: this.editionSort.direction === 'desc' ? '↓' : '↑',
      roleCamp: this.roleCamp,
      roleRows: huashan.filteredBreakdown(
        this.allRoleRows,
        { camp: this.roleCamp },
        this.roleSort,
      ),
      roleSortMark: this.roleSort.direction === 'desc' ? '↓' : '↑',
    })
  },

  renderGames() {
    const filtered = huashan.filteredGames(this.allGames, this.filters, this.sort)
    const activeFilterCount = Object.values(this.filters).filter(Boolean).length
    this.setData({
      activeFilterCount,
      dateSortMark: this.sort.key === 'date' ? (this.sort.direction === 'desc' ? '↓' : '↑') : '↕',
      filteredCount: filtered.length,
      filters: { ...this.filters },
      games: filtered.slice(0, this.visibleLimit),
      gamesCountText: filtered.length + ' 场',
      hasMoreGames: filtered.length > this.visibleLimit,
      pointSortMark: this.sort.key === 'point' ? (this.sort.direction === 'desc' ? '↓' : '↑') : '↕',
      sortDirection: this.sort.direction,
      sortKey: this.sort.key,
    })
  },

  async loadPlayer() {
    if (!this.playerId || this.loadingRequest) return
    this.loadingRequest = true
    this.redirected = false
    const generation = ++this.loadGeneration
    this.resetGameView()
    shared.setDataDiff(this, {
      activeFilterCount: 0,
      dateSortMark: '↓',
      editionQuery: '',
      error: '',
      filterReady: false,
      editionRows: [],
      editionSortIndex: 0,
      editionSortMark: '↓',
      filters: emptyFilters(),
      filteredCount: 0,
      games: [],
      gamesCountText: '',
      gamesError: '',
      gamesLoading: true,
      gamesProgress: '正在整理身份、版型和逐场战绩。',
      gamesWarning: '',
      hasMoreGames: false,
      loading: true,
      pointSortMark: '↕',
      radar: profileRadar.view({}, this.radarSelection),
      radarLoading: true,
      radarPickerOpen: false,
      roleIndex: 0,
      roleCamp: '',
      roleOptions: ['全部身份'],
      roleRows: [],
      roleSortIndex: 0,
      roleSortMark: '↓',
      gameSectIndex: 0,
      gameSectOptions: ['全部门派记录'],
      sortDirection: 'desc',
      sortKey: 'date',
      statsError: '',
    })

    let statsFailed = false
    let gamesFailed = false
    const statsTask = settled(huashan.playerStats(this.playerId, this.scope)).then((stats) => {
      if (generation !== this.loadGeneration) return
      if (stats.error) {
        if (this.redirectForAuth(stats.error, generation)) return
        statsFailed = true
        this.setData({
          radarLoading: false,
          statsError: '战力和关键指标暂时无法读取。',
        })
        return
      }
      this.statsPayload = stats.value
      this.updateScopedPlayer()
    })
    const gamesTask = settled(huashan.loadAllPlayerGames(this.playerId, {
      onFirstPage: (page) => this.showFirstGames(page, generation),
      onProgress: (progress) => this.showGameProgress(progress, generation),
    }, { zone: this.scope.zone })).then((games) => {
      if (generation !== this.loadGeneration) return
      if (games.error) {
        if (this.redirectForAuth(games.error, generation)) return
        gamesFailed = true
        this.setData({
          gamesError: '逐场战绩暂时无法读取。',
          gamesLoading: false,
          gamesProgress: '',
        })
        return
      }
      this.finishGames(games.value, generation)
    })

    try {
      await Promise.all([statsTask, gamesTask])
      if (generation === this.loadGeneration && !this.redirected) {
        this.setData({
          error: statsFailed && gamesFailed ? '选手资料暂时无法读取，请稍后重试。' : '',
          loading: false,
        })
      }
    } finally {
      this.loadingRequest = false
    }
  },

  setQuickFilter(event) {
    if (!this.data.filterReady) return
    const kind = event.currentTarget.dataset.kind
    if (!Object.prototype.hasOwnProperty.call(this.filters, kind)) return
    this.filters[kind] = event.currentTarget.dataset.value || ''
    this.visibleLimit = DISPLAY_PAGE_SIZE
    this.renderGames()
  },

  changeTab(event) {
    const tab = event.currentTarget.dataset.tab
    if (!['overview', 'roles', 'editions', 'games'].includes(tab)) return
    this.setData({ activeTab: tab }, () => this.drawProfileRadar())
  },

  async openReplay(event) {
    const gameId = String(event.currentTarget.dataset.id || '')
    if (!gameId) return
    const generation = ++this.replayGeneration
    const playerGame = this.allGames.find((game) => game.gameId === gameId) || null
    this.setData({
      replay: null,
      replayError: '',
      replayLoading: true,
      replayMode: 'seat',
      replayOpen: true,
    })
    try {
      const payload = await huashan.playerGame(gameId)
      if (generation !== this.replayGeneration) return
      this.setData({
        replay: replay.replayView(payload, this.playerId, playerGame),
        replayLoading: false,
      })
    } catch (error) {
      if (generation !== this.replayGeneration) return
      if (error && error.code === 'TOKEN_EXPIRED') {
        huashan.clearDataCache()
        compareBasket.clear()
        wx.reLaunch({ url: '/pages/session/index' })
        return
      }
      this.setData({
        replayError: '单局复盘暂时无法读取，请稍后重试。',
        replayLoading: false,
      })
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

  setRoleCamp(event) {
    if (!this.data.filterReady) return
    this.roleCamp = event.currentTarget.dataset.value || ''
    this.renderPerformance()
  },

  onRoleSortChange(event) {
    if (!this.data.filterReady) return
    const index = Number(event.detail.value) || 0
    const selected = ROLE_SORT_OPTIONS[index] || ROLE_SORT_OPTIONS[0]
    this.roleSort = { key: selected.key, direction: 'desc' }
    this.setData({ roleSortIndex: index })
    this.renderPerformance()
  },

  toggleRoleSortDirection() {
    if (!this.data.filterReady) return
    this.roleSort.direction = this.roleSort.direction === 'desc' ? 'asc' : 'desc'
    this.renderPerformance()
  },

  onEditionQuery(event) {
    if (!this.data.filterReady) return
    this.editionQuery = event.detail.value || ''
    this.renderPerformance()
  },

  onEditionSortChange(event) {
    if (!this.data.filterReady) return
    const index = Number(event.detail.value) || 0
    const selected = EDITION_SORT_OPTIONS[index] || EDITION_SORT_OPTIONS[0]
    this.editionSort = { key: selected.key, direction: 'desc' }
    this.setData({ editionSortIndex: index })
    this.renderPerformance()
  },

  toggleEditionSortDirection() {
    if (!this.data.filterReady) return
    this.editionSort.direction = this.editionSort.direction === 'desc' ? 'asc' : 'desc'
    this.renderPerformance()
  },

  onRoleFilter(event) {
    if (!this.data.filterReady) return
    const index = Number(event.detail.value) || 0
    this.filters.role = index ? this.filterOptions.roles[index - 1] : ''
    this.visibleLimit = DISPLAY_PAGE_SIZE
    this.setData({ roleIndex: index })
    this.renderGames()
  },

  onSectFilter(event) {
    if (!this.data.filterReady) return
    const index = Number(event.detail.value) || 0
    this.filters.sect = index ? this.filterOptions.sects[index - 1] : ''
    this.visibleLimit = DISPLAY_PAGE_SIZE
    this.setData({ gameSectIndex: index })
    this.renderGames()
  },

  onScopeZoneChange(event) {
    const zone = this.zoneValues[Number(event.detail.value)] || 'ALL'
    if (zone === this.scope.zone) return
    huashan.cancelPlayerRequests(this.playerId)
    this.scope = { zone, season: '', sect: '' }
    this.zoneGames = []
    this.statsPayload = null
    this.loadPlayer()
  },

  onScopeSeasonChange(event) {
    const season = this.seasonValues[Number(event.detail.value)] || ''
    if (season === this.scope.season) return
    this.scope = { ...this.scope, season }
    this.statsPayload = null
    this.loadPlayer()
  },

  onScopeSectChange(event) {
    if (!this.data.filterReady) return
    const sect = this.scopeSectValues[Number(event.detail.value)] || ''
    if (sect === this.scope.sect) return
    this.scope = { ...this.scope, sect }
    this.rebuildScopedGames()
  },

  sortGames(event) {
    if (!this.data.filterReady) return
    const key = event.currentTarget.dataset.key === 'point' ? 'point' : 'date'
    if (this.sort.key === key) {
      this.sort.direction = this.sort.direction === 'desc' ? 'asc' : 'desc'
    } else {
      this.sort = { key, direction: 'desc' }
    }
    this.visibleLimit = DISPLAY_PAGE_SIZE
    this.renderGames()
  },

  resetGameFilters() {
    if (!this.data.filterReady) return
    this.filters = emptyFilters()
    this.visibleLimit = DISPLAY_PAGE_SIZE
    this.setData({ roleIndex: 0, gameSectIndex: 0 })
    this.renderGames()
  },

  showMoreGames() {
    if (!this.data.filterReady) return
    this.visibleLimit += DISPLAY_PAGE_SIZE
    this.renderGames()
  },
})
