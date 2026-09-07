const events = require('../../services/events')
const themeStore = require('../../services/theme')
const tokenStore = require('../../services/token')

const SORTS = {
  sects: [
    { value: 'totalPoint', label: '总分' }, { value: 'mvp', label: 'MVP' },
    { value: 'svp', label: '尽力' }, { value: 'bgx', label: '背锅' },
  ],
  averages: [
    { value: 'count', label: '参赛量' }, { value: 'totalPoint', label: '总分' }, { value: 'avg', label: '均分' },
  ],
  players: [
    { value: 'totalPoint', label: '总分' }, { value: 'count', label: '参赛量' },
    { value: 'avg', label: '均分' }, { value: 'mvp', label: 'MVP' },
    { value: 'svp', label: '尽力' }, { value: 'bgx', label: '背锅' },
  ],
}

function newestSeason(items) {
  return [...(items || [])].filter((item) => /^S\d+$/.test(item.label) && Number(item.value) < 1000)
    .sort((a, b) => Number(b.value) - Number(a.value))[0]
}

function sortedRows(rows, key, direction, dayMode) {
  const field = key === 'count' ? (dayMode ? 'days' : 'games') : key
  return (rows || []).map((item) => ({ ...item })).sort((a, b) => {
    const leftMissing = a[field] == null || a[field] === '' || !Number.isFinite(Number(a[field]))
    const rightMissing = b[field] == null || b[field] === '' || !Number.isFinite(Number(b[field]))
    if (leftMissing && rightMissing) return 0
    if (leftMissing) return 1
    if (rightMissing) return -1
    const left = Number(a[field])
    const right = Number(b[field])
    return direction * (left - right) || String(a.sectName || a.playerName).localeCompare(String(b.sectName || b.playerName), 'zh-CN')
  }).map((item, index) => ({
    ...item,
    displayRank: index + 1,
    countDisplay: item[dayMode ? 'days' : 'games'] == null ? '—' : item[dayMode ? 'days' : 'games'],
    avgDisplay: item.avg == null ? '—' : item.avg,
  }))
}

Page({
  data: {
    theme: 'dark', zones: [], seasons: [], types: [], zoneIndex: 0, seasonIndex: 0, typeIndex: -1,
    zone: 'SH', season: '', type: '', loadingOptions: true, loading: false, metricsLoading: false,
    error: '', notice: '', tab: 'sects', sortOptions: SORTS.sects, sortIndex: 0, sortDirection: -1, directionLabel: '从高到低',
    ranks: [], teams: [], players: [], visibleRows: [], dayMode: true, countLabel: '天数', avgLabel: '日均分',
    selectedTeam: null, members: [], teamLoading: false, teamWarning: '', teamError: '', scopeLabel: '',
  },

  onLoad() {
    this.setData(themeStore.pageData())
    if (!tokenStore.hasToken()) { wx.reLaunch({ url: '/pages/session/index' }); return }
    this.loadCatalog()
  },

  async loadCatalog() {
    this.setData({ loadingOptions: true, error: '', selectedTeam: null })
    try {
      const catalog = await events.catalog()
      this.setData({ zones: catalog.zones, zoneIndex: Math.max(0, catalog.zones.findIndex((item) => item.value === this.data.zone)) })
      await this.loadSeasons()
    } catch (error) { this.handleError(error, '赛事资料暂时无法读取。') }
    finally { this.setData({ loadingOptions: false }) }
  },

  async loadSeasons() {
    this.setData({ loadingOptions: true, seasons: [], types: [], season: '', type: '', typeIndex: -1, ranks: [], visibleRows: [] })
    const seasons = await events.availableSeasons(this.data.zone)
    const selected = newestSeason(seasons) || seasons[0]
    this.setData({ seasons, seasonIndex: Math.max(0, seasons.indexOf(selected)), season: selected ? selected.value : '' })
    if (selected) await this.loadTypes()
  },

  async loadTypes() {
    this.setData({ loadingOptions: true, types: [], type: '', typeIndex: -1, ranks: [], visibleRows: [] })
    const types = await events.availableTypes(this.data.season, this.data.zone)
    this.setData({ types, loadingOptions: false })
  },

  async onZoneChange(event) {
    const zoneIndex = Number(event.detail.value)
    const zone = this.data.zones[zoneIndex] && this.data.zones[zoneIndex].value
    if (!zone) return
    this.setData({ zoneIndex, zone, selectedTeam: null, error: '' })
    try { await this.loadSeasons() } catch (error) { this.handleError(error, '可用赛季暂时无法读取。') }
    finally { this.setData({ loadingOptions: false }) }
  },

  async onSeasonChange(event) {
    const seasonIndex = Number(event.detail.value)
    const season = this.data.seasons[seasonIndex] && this.data.seasons[seasonIndex].value
    if (!season) return
    this.setData({ seasonIndex, season, selectedTeam: null, error: '' })
    try { await this.loadTypes() } catch (error) { this.handleError(error, '比赛类型暂时无法读取。') }
    finally { this.setData({ loadingOptions: false }) }
  },

  onTypeChange(event) {
    const typeIndex = Number(event.detail.value)
    const type = this.data.types[typeIndex] && this.data.types[typeIndex].value
    this.setData({ typeIndex, type: type || '', ranks: [], teams: [], players: [], visibleRows: [], selectedTeam: null, error: '' })
  },

  async query() {
    if (!this.data.season || !this.data.type || this.data.loading) return
    this.setData({ loading: true, metricsLoading: false, error: '', notice: '', tab: 'sects', selectedTeam: null, ranks: [], visibleRows: [] })
    try {
      const ranks = await events.rankings(this.data.season, this.data.type, this.data.zone)
      const dayMode = ['2', '3'].includes(String(this.data.type))
      const zone = this.data.zones[this.data.zoneIndex]
      const season = this.data.seasons[this.data.seasonIndex]
      const type = this.data.types[this.data.typeIndex]
      this.setData({
        ranks, teams: ranks, dayMode, countLabel: dayMode ? '天数' : '场次', avgLabel: dayMode ? '日均分' : '场均分',
        scopeLabel: [zone && zone.label, season && season.label, type && type.label].filter(Boolean).join(' · '),
        sortOptions: SORTS.sects, sortIndex: 0, sortDirection: -1, directionLabel: '从高到低', loading: false, metricsLoading: true,
      })
      this.refreshRows()
      try {
        const metrics = await events.eventMetrics(this.data.season, this.data.type, this.data.zone, ranks)
        this.setData({
          teams: metrics.teams, players: metrics.players, metricsLoading: false,
          notice: metrics.incomplete ? '部分选手有多个历史门派，门派参赛量可能不完整。' : '',
        })
        this.refreshRows()
      } catch (metricsError) {
        if (metricsError && metricsError.code === 'TOKEN_EXPIRED') { wx.reLaunch({ url: '/pages/session/index' }); return }
        this.setData({ metricsLoading: false, notice: '参赛数据整理失败：' + ((metricsError && metricsError.message) || '请稍后重试。') })
      }
    } catch (error) { this.handleError(error, '赛事数据暂时无法读取。') }
    finally { this.setData({ loading: false, metricsLoading: false }) }
  },

  setTab(event) {
    const tab = event.currentTarget.dataset.tab
    if ((tab === 'averages' || tab === 'players') && this.data.metricsLoading) return
    const sortOptions = SORTS[tab] || SORTS.sects
    this.setData({ tab, sortOptions, sortIndex: 0, sortDirection: -1, directionLabel: '从高到低', selectedTeam: null })
    this.refreshRows()
  },

  onSortChange(event) { this.setData({ sortIndex: Number(event.detail.value) }); this.refreshRows() },
  toggleDirection() {
    const sortDirection = this.data.sortDirection * -1
    this.setData({ sortDirection, directionLabel: sortDirection < 0 ? '从高到低' : '从低到高' })
    this.refreshRows()
  },

  refreshRows() {
    const source = this.data.tab === 'players' ? this.data.players : (this.data.tab === 'averages' ? this.data.teams : this.data.ranks)
    const sort = this.data.sortOptions[this.data.sortIndex] || this.data.sortOptions[0]
    this.setData({ visibleRows: sortedRows(source, sort.value, this.data.sortDirection, this.data.dayMode) })
  },

  openRankItem(event) {
    if (this.data.tab === 'players') this.openPlayer(event)
    else this.openTeam(event)
  },

  async openTeam(event) {
    const team = this.data.visibleRows[event.currentTarget.dataset.index]
    if (!team) return
    this.setData({ selectedTeam: team, members: [], teamLoading: true, teamWarning: '', teamError: '' })
    wx.pageScrollTo({ scrollTop: 0, duration: 0 })
    try {
      const detail = await events.eventTeam(this.data.season, this.data.type, this.data.zone, team)
      this.setData({
        selectedTeam: { ...team, sectName: detail.name || team.sectName, chief: detail.chief || '' },
        members: detail.members,
        teamWarning: detail.incomplete ? '部分成员的逐场数据读取失败，当前名单可能不完整。' : '',
      })
    } catch (error) {
      if (error && error.code === 'TOKEN_EXPIRED') { wx.reLaunch({ url: '/pages/session/index' }); return }
      this.setData({ teamError: (error && error.message) || '门派成员暂时无法读取。' })
    }
    finally { this.setData({ teamLoading: false }) }
  },

  closeTeam() { this.setData({ selectedTeam: null, members: [], teamLoading: false, teamWarning: '', teamError: '' }) },

  openPlayer(event) {
    const player = this.data.members[event.currentTarget.dataset.index] || this.data.visibleRows[event.currentTarget.dataset.index]
    if (!player || !player.playerId) return
    wx.navigateTo({ url: '/pages/player/index?playerId=' + player.playerId + '&name=' + encodeURIComponent(player.playerName || '') })
  },

  handleError(error, fallback) {
    if (error && error.code === 'TOKEN_EXPIRED') { wx.reLaunch({ url: '/pages/session/index' }); return }
    this.setData({ error: (error && error.message) || fallback, loadingOptions: false })
  },
})
