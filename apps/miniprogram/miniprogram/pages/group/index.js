const events = require('../../services/events')
const themeStore = require('../../services/theme')
const tokenStore = require('../../services/token')

function newest(items) {
  return [...(items || [])].filter((item) => /^S\d+$/.test(item.label) && Number(item.value) < 1000)
    .sort((a, b) => Number(b.value) - Number(a.value))[0]
}

Page({
  data: {
    theme: 'dark', zones: [], seasons: [], types: [], zone: 'SH', season: '', type: '',
    zoneIndex: 0, seasonIndex: 0, typeIndex: 0, loadingOptions: true, loading: false, error: '',
    teams: [], seedRows: [], assignments: [], groups: [], capacities: [], nextTeam: null, complete: false, lastSectId: 0,
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
      await this.loadSeasons()
    } catch (error) { this.handleError(error, '赛事资料暂时无法读取。') }
    finally { this.setData({ loadingOptions: false }) }
  },
  async loadSeasons() {
    this.clearDraw({ loadingOptions: true, seasons: [], types: [], season: '', type: '' })
    const seasons = await events.availableSeasons(this.data.zone)
    const selected = newest(seasons) || seasons[0]
    this.setData({ seasons, seasonIndex: Math.max(0, seasons.indexOf(selected)), season: selected ? selected.value : '' })
    if (selected) await this.loadTypes()
  },
  async loadTypes() {
    this.clearDraw({ loadingOptions: true, types: [], type: '' })
    const types = (await events.availableTypes(this.data.season, this.data.zone)).filter((item) => ['2', '3'].includes(item.value))
    const selected = types.find((item) => item.value === '3') || types[0]
    this.setData({ types, typeIndex: Math.max(0, types.indexOf(selected)), type: selected ? selected.value : '', loadingOptions: false })
  },
  async onZoneChange(event) {
    const zoneIndex = Number(event.detail.value)
    const zone = this.data.zones[zoneIndex] && this.data.zones[zoneIndex].value
    if (!zone) return
    this.setData({ zoneIndex, zone, error: '' })
    try { await this.loadSeasons() } catch (error) { this.handleError(error, '可用赛季暂时无法读取。') }
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
    this.clearDraw({ typeIndex, type: type || '', error: '' })
  },
  clearDraw(extra) { this.setData({ teams: [], seedRows: [], assignments: [], groups: [], nextTeam: null, complete: false, lastSectId: 0, ...(extra || {}) }) },
  async query() {
    if (!this.data.season || !this.data.type || this.data.loading) return
    this.clearDraw({ loading: true, error: '' })
    try {
      const ranks = await events.rankings(this.data.season, this.data.type, this.data.zone)
      const teams = events.seedTeams(ranks)
      if (!teams.length) throw new Error('该赛事没有门派排名数据，暂时无法分组。')
      this.setData({ teams, capacities: events.groupCapacities(teams.length), loading: false })
      this.refreshGroups()
    } catch (error) { this.handleError(error, '分组排名暂时无法读取。') }
    finally { this.setData({ loading: false }) }
  },
  drawNext() {
    const assignment = events.drawNextAssignment(this.data.teams, this.data.assignments)
    if (!assignment) return
    this.setData({ assignments: [...this.data.assignments, assignment], lastSectId: assignment.sectId })
    this.refreshGroups()
  },
  finish() {
    const assignments = [...this.data.assignments]
    let assignment
    while ((assignment = events.drawNextAssignment(this.data.teams, assignments))) assignments.push(assignment)
    this.setData({ assignments, lastSectId: assignments.length ? assignments[assignments.length - 1].sectId : 0 })
    this.refreshGroups()
  },
  reset() { this.setData({ assignments: [], lastSectId: 0 }); this.refreshGroups() },
  refreshGroups() {
    const byId = new Map(this.data.teams.map((team) => [team.sectId, team]))
    const names = ['A', 'B', 'C', 'D']
    const groups = names.map((name, index) => ({
      name, capacity: this.data.capacities[index] || 0,
      teams: this.data.assignments.filter((item) => item.group === name).map((item) => {
        const team = byId.get(item.sectId)
        return team ? { ...team, justDrawn: team.sectId === this.data.lastSectId } : null
      }).filter(Boolean),
    }))
    const complete = this.data.assignments.length >= this.data.teams.length
    const assignmentById = new Map(this.data.assignments.map((item) => [item.sectId, item]))
    const seedRows = this.data.teams.map((team, index) => {
      const assignment = assignmentById.get(team.sectId)
      return {
        ...team,
        state: assignment ? assignment.group + ' 组' : (index === this.data.assignments.length ? '下一队' : '待抽取'),
        stateClass: assignment ? 'done' : (index === this.data.assignments.length ? 'next' : 'pending'),
      }
    })
    this.setData({ groups, seedRows, complete, nextTeam: complete ? null : this.data.teams[this.data.assignments.length] })
  },
  handleError(error, fallback) {
    if (error && error.code === 'TOKEN_EXPIRED') { wx.reLaunch({ url: '/pages/session/index' }); return }
    this.setData({ error: (error && error.message) || fallback, loading: false, loadingOptions: false })
  },
})
