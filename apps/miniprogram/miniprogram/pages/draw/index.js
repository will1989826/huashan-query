const events = require('../../services/events')
const drawProjections = require('../../services/draw-projections')
const themeStore = require('../../services/theme')
const tokenStore = require('../../services/token')

function latest(items) {
  return [...(items || [])].filter((item) => /^S\d+$/.test(item.label) && Number(item.value) < 1000)
    .sort((a, b) => Number(b.value) - Number(a.value))
}

Page({
  data: {
    theme: 'dark', zones: [], seasons: [], types: [], zone: 'SH', season: '', type: '',
    zoneIndex: 0, seasonIndex: 0, typeIndex: 0, loadingOptions: true, loading: false,
    progress: '', error: '', dataReady: false, simulationReady: false, warnings: [],
    games: [], removedIndex: 0, editGameIndex: 0, scenario: [], projections: {},
    rule: '', history: '', completedGames: 0, expectedGames: 0,
  },
  onLoad() {
    this.setData(themeStore.pageData())
    if (!tokenStore.hasToken()) { wx.reLaunch({ url: '/pages/session/index' }); return }
    this.loadCatalog()
  },
  async loadCatalog() {
    try {
      const catalog = await events.catalog()
      this.setData({ zones: catalog.zones })
      await this.loadLatestScope()
    } catch (error) { this.handleError(error, '赛事资料暂时无法读取。') }
    finally { this.setData({ loadingOptions: false }) }
  },
  async loadLatestScope() {
    this.clearResult({ loadingOptions: true, seasons: [], types: [], season: '', type: '' })
    const seasons = await events.availableSeasons(this.data.zone)
    const ordered = latest(seasons)
    let selected = ordered[0] || seasons[0]
    let types = []
    for (const season of ordered) {
      const available = (await events.availableTypes(season.value, this.data.zone)).filter((item) => ['4', '5'].includes(item.value))
      if (available.length) { selected = season; types = available; break }
    }
    const seasonIndex = Math.max(0, seasons.findIndex((item) => selected && item.value === selected.value))
    const preferred = types.find((item) => item.value === '5') || types[0]
    this.setData({ seasons, seasonIndex, season: selected ? selected.value : '', types, typeIndex: Math.max(0, types.indexOf(preferred)), type: preferred ? preferred.value : '', loadingOptions: false })
  },
  async loadTypes() {
    this.clearResult({ loadingOptions: true, types: [], type: '' })
    const types = (await events.availableTypes(this.data.season, this.data.zone)).filter((item) => ['4', '5'].includes(item.value))
    const preferred = types.find((item) => item.value === '5') || types[0]
    this.setData({ types, typeIndex: Math.max(0, types.indexOf(preferred)), type: preferred ? preferred.value : '', loadingOptions: false })
  },
  async onZoneChange(event) {
    const zoneIndex = Number(event.detail.value)
    const zone = this.data.zones[zoneIndex] && this.data.zones[zoneIndex].value
    if (!zone) return
    this.setData({ zoneIndex, zone, error: '' })
    try { await this.loadLatestScope() } catch (error) { this.handleError(error, '可用淘汰赛暂时无法读取。') }
  },
  async onSeasonChange(event) {
    const seasonIndex = Number(event.detail.value)
    const season = this.data.seasons[seasonIndex] && this.data.seasons[seasonIndex].value
    if (!season) return
    this.setData({ seasonIndex, season, error: '' })
    try { await this.loadTypes() } catch (error) { this.handleError(error, '可用比赛类型暂时无法读取。') }
  },
  onTypeChange(event) {
    const typeIndex = Number(event.detail.value)
    const type = this.data.types[typeIndex] && this.data.types[typeIndex].value
    this.clearResult({ typeIndex, type: type || '', error: '' })
  },
  clearResult(extra) {
    this.drawData = null
    this.setData({ dataReady: false, simulationReady: false, games: [], scenario: [], projections: {}, warnings: [], progress: '', ...(extra || {}) })
  },
  async query() {
    if (!this.data.season || !this.data.type || this.data.loading) return
    this.clearResult({ loading: true, error: '', progress: '正在整理参赛选手…' })
    try {
      const data = await events.drawTool(this.data.season, this.data.type, this.data.zone, (done, total) => {
        this.setData({ progress: '正在读取逐场数据 ' + done + ' / ' + total })
      })
      this.drawData = data
      const projections = drawProjections.load(data)
      const historical = data.games.findIndex((game) => game.gameId === data.historicalRemovedGame)
      const removedIndex = historical >= 0 ? historical : 0
      const future = data.games.findIndex((game) => !game.complete)
      const games = data.games.map((game) => ({ ...game, label: '第 ' + game.index + ' 局' + (game.complete ? (' · ' + (game.playDate || '已完成')) : ' · 待进行') }))
      this.setData({
        dataReady: true, simulationReady: data.simulationReady, warnings: data.warnings, games, projections,
        removedIndex, editGameIndex: future >= 0 ? future : removedIndex,
        completedGames: data.completedGames, expectedGames: data.expectedGames,
        rule: data.seasonType === '4' ? '季后赛 15 局取 14 局，保留带入积分和赛外违规扣分。' : '总决赛 16 局取 15 局，保留赛外违规扣分。',
        history: data.officialDrawApplied ? '官方已抽局结果已识别，当前默认选中历史抽掉的比赛。' : '',
      })
      this.refreshScenario()
    } catch (error) { this.handleError(error, '比赛数据暂时无法读取。') }
    finally { this.setData({ loading: false, progress: '' }) }
  },
  onRemovedChange(event) { this.setData({ removedIndex: Number(event.detail.value) }); this.refreshScenario() },
  onEditGameChange(event) { this.setData({ editGameIndex: Number(event.detail.value) }); this.refreshScenario() },
  onProjection(event) {
    if (!this.drawData) return
    const teamIndex = Number(event.currentTarget.dataset.team)
    const game = this.drawData.games[this.data.editGameIndex]
    const team = this.drawData.teams[teamIndex]
    if (!game || game.complete || !team) return
    const projections = { ...this.data.projections }
    projections[game.index] = { ...(projections[game.index] || {}) }
    const value = event.detail.value
    if (value === '' || !Number.isFinite(Number(value))) delete projections[game.index][team.sectId]
    else projections[game.index][team.sectId] = Number(value)
    this.setData({ projections })
    drawProjections.save(this.drawData, projections)
    this.refreshScenario()
  },
  refreshScenario() {
    if (!this.drawData || !this.drawData.simulationReady) return
    const selected = this.drawData.games[this.data.editGameIndex]
    const scenario = events.calculateScenario(this.drawData, this.data.projections, this.data.removedIndex).map((row) => {
      const teamIndex = this.drawData.teams.findIndex((team) => team.sectId === row.sectId)
      const team = this.drawData.teams[teamIndex]
      const raw = selected && (selected.complete ? selected.scores[teamIndex] : this.data.projections[selected.index] && this.data.projections[selected.index][team.sectId])
      return { ...row, top: row.rank != null && row.rank <= 3, teamIndex, editValue: raw == null ? '' : raw, editComplete: selected ? selected.complete : true, initialBonus: team.initialBonus, outsideAdjustment: team.outsideAdjustment }
    })
    this.setData({ scenario })
  },
  handleError(error, fallback) {
    if (error && error.code === 'TOKEN_EXPIRED') { wx.reLaunch({ url: '/pages/session/index' }); return }
    this.setData({ error: (error && error.message) || fallback, loading: false, loadingOptions: false })
  },
})
