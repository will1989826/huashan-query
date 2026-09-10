const huashan = require('../../services/huashan')
const compareBasket = require('../../services/compare-basket')
const shared = require('../../services/shared')
const themeStore = require('../../services/theme')
const tokenStore = require('../../services/token')

function batchNames(raw) {
  const seen = new Set()
  return String(raw || '').split(/[\r\n,，、;；]+/).map((name) => name.trim()).filter((name) => {
    const key = name.toLowerCase()
    if (!name || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

Page({
  data: {
    basket: [],
    basketCount: 0,
    basketFull: false,
    batchText: '',
    batchLoading: false,
    batchRows: [],
    rosterMode: 'add',
    batchCount: 0,
    selectedCount: 0,
    totalCount: 0,
    remaining: 12,
    batchReady: false,
    compareMode: false,
    empty: false,
    error: '',
    loading: false,
    name: '',
    results: [],
    searchMode: 'name',
    searchPlaceholder: '输入选手名',
    emptyMessage: '没有找到对应选手，请检查名字后重试。',
    searched: false,
    theme: 'dark',
  },

  onLoad(options) {
    this.setData(themeStore.pageData())
    if (!tokenStore.hasToken()) {
      wx.reLaunch({ url: '/pages/session/index' })
      return
    }
    const compareMode = !!(options && options.mode === 'compare')
    this.returnToCompare = options && options.return === 'compare'
    this.searchGeneration = 0
    this.setData({ compareMode, rosterMode: options && options.action === 'replace' ? 'replace' : 'add', returnToCompare: this.returnToCompare })
    this.syncBasket()
  },

  onUnload() {
    this.searchGeneration += 1
  },

  onShow() {
    this.setData(themeStore.pageData())
    this.syncBasket()
  },

  syncBasket() {
    const items = compareBasket.items()
    const results = this.data.results.map((player) => ({
      ...player,
      inBasket: compareBasket.has(player.playerId),
    }))
    this.setData({
      basket: items,
      basketCount: items.length,
      basketFull: items.length >= compareBasket.MAX,
      results,
    })
    this.syncBatchSelection()
  },

  onNameInput(event) {
    this.setData({ name: event.detail.value, error: '' })
  },

  setSearchTab(event) {
    const compareMode = event.currentTarget.dataset.tab === 'compare'
    if (compareMode === this.data.compareMode) return
    this.searchGeneration += 1
    this.setData({ compareMode, batchLoading: false, loading: false, error: '' })
  },

  setRosterMode(event) {
    const rosterMode = event.currentTarget.dataset.mode === 'replace' ? 'replace' : 'add'
    this.searchGeneration += 1
    this.setData({ rosterMode, batchText: '', batchCount: 0, batchRows: [], batchLoading: false, error: '' })
    this.syncBatchSelection()
  },

  onBatchInput(event) {
    this.searchGeneration += 1
    const batchText = event.detail.value || ''
    this.setData({ batchText, batchCount: batchNames(batchText).length, batchRows: [], batchLoading: false, error: '' })
    this.syncBatchSelection()
  },

  syncBatchSelection() {
    const players = []
    const replace = this.data.rosterMode === 'replace'
    this.data.batchRows.forEach((row) => {
      const player = row.selectedIndex > 0 ? row.candidates[row.selectedIndex - 1] : null
      if (player && (replace || !compareBasket.has(player.playerId)) && !players.some((p) => p.playerId === player.playerId)) players.push(player)
    })
    const remaining = replace ? compareBasket.MAX : compareBasket.MAX - compareBasket.count()
    const totalCount = players.length + (replace ? 0 : compareBasket.count())
    this.setData({ selectedCount: players.length, totalCount, remaining,
      batchReady: !this.data.batchLoading && players.length > 0 && players.length <= remaining && totalCount >= 2
        && this.data.batchRows.every((row) => row.selectedIndex > 0),
    })
    return players
  },

  async resolveBatch() {
    if (this.data.batchLoading) return
    const names = batchNames(this.data.batchText)
    if (!names.length) {
      wx.showToast({ title: '请输入选手名', icon: 'none' })
      return
    }
    const remaining = this.data.rosterMode === 'replace' ? compareBasket.MAX : compareBasket.MAX - compareBasket.count()
    if (remaining <= 0) {
      wx.showToast({ title: '对比篮已满', icon: 'none' })
      return
    }
    if (names.length > compareBasket.MAX) {
      this.setData({ error: '最多查找 12 人，请减少名单后重试。' })
      return
    }
    const selectedNames = names
    const generation = ++this.searchGeneration
    this.setData({ batchLoading: true, batchRows: [], error: '' })
    try {
      const rows = await shared.mapLimit(selectedNames, 4, async (name) => {
        const found = (await huashan.searchPlayersByName(name)).map(huashan.playerView)
        const folded = name.toLocaleLowerCase()
        const exact = found.filter((player) => String(player.name || '').toLocaleLowerCase() === folded)
        const candidates = found
        const selectedIndex = exact.length === 1 ? candidates.indexOf(exact[0]) + 1 : 0
        return {
          query: name,
          candidates,
          candidateLabels: ['请选择选手', ...candidates.map((player) => player.name + ' · #' + player.playerId + (this.data.rosterMode !== 'replace' && compareBasket.has(player.playerId) ? ' · 已保留' : ''))],
          selectedIndex,
          status: candidates.length ? (selectedIndex ? '已确认' : '请选择正确选手') : '未找到，请修改名字',
        }
      })
      if (generation === this.searchGeneration) this.setData({ batchRows: rows })
    } catch (error) {
      if (generation !== this.searchGeneration) return
      if (error && error.code === 'TOKEN_EXPIRED') {
        compareBasket.clear()
        wx.reLaunch({ url: '/pages/session/index' })
        return
      }
      this.setData({ error: (error && error.message) || '批量查询失败，请稍后重试。' })
    } finally {
      if (generation === this.searchGeneration) { this.setData({ batchLoading: false }); this.syncBatchSelection() }
    }
  },

  onBatchCandidateChange(event) {
    const rowIndex = Number(event.currentTarget.dataset.index)
    const selectedIndex = Number(event.detail.value) || 0
    const batchRows = this.data.batchRows.map((row, index) => (
      index === rowIndex ? { ...row, selectedIndex, status: selectedIndex ? '已确认' : '请选择正确选手' } : row
    ))
    this.setData({ batchRows })
    this.syncBatchSelection()
  },

  confirmBatch() {
    const players = this.syncBatchSelection()
    if (!this.data.batchReady) return
    if (this.data.rosterMode === 'replace') {
      if (!compareBasket.replace(players)) return
    } else compareBasket.addMany(players)
    this.syncBasket()
    this.setData({ batchText: '', batchCount: 0, batchRows: [], rosterMode: 'add' })
    this.syncBatchSelection()
    this.openCompare()
  },

  setSearchMode(event) {
    const searchMode = event.currentTarget.dataset.mode === 'id' ? 'id' : 'name'
    if (searchMode === this.data.searchMode) return
    this.searchGeneration += 1
    this.setData({
      searchMode,
      searchPlaceholder: searchMode === 'id' ? '输入选手 ID（纯数字）' : '输入选手名',
      emptyMessage: searchMode === 'id'
        ? '没有找到这个选手 ID，可切到“按名字”搜索。'
        : '没有找到对应选手，请检查名字后重试。',
      empty: false,
      error: '',
      loading: false,
      results: [],
      searched: false,
    }, () => {
      if (this.data.name.trim()) this.search()
    })
  },

  async search() {
    const query = this.data.name.trim()
    if (!query || this.data.loading) return
    const mode = this.data.searchMode
    const generation = ++this.searchGeneration
    this.setData({ loading: true, error: '', empty: false })
    try {
      const items = mode === 'id'
        ? [await huashan.searchPlayerById(query)]
        : (await huashan.searchPlayersByName(query)).map(huashan.playerView)
      if (generation !== this.searchGeneration) return
      const results = items.map((player) => ({
        ...player,
        inBasket: compareBasket.has(player.playerId),
      }))
      this.setData({ results, searched: true, empty: results.length === 0 })
    } catch (error) {
      if (generation !== this.searchGeneration) return
      if (error.code === 'TOKEN_EXPIRED') {
        compareBasket.clear()
        wx.reLaunch({ url: '/pages/session/index' })
        return
      }
      if (error.code === 'PLAYER_NOT_FOUND') {
        this.setData({ empty: true, error: '', results: [], searched: true })
      } else {
        this.setData({ error: error.message || '查询失败，请稍后重试。', results: [], searched: true })
      }
    } finally {
      if (generation === this.searchGeneration) this.setData({ loading: false })
    }
  },

  openPlayer(event) {
    const player = this.data.results[event.currentTarget.dataset.index]
    if (!player || !player.playerId) return
    const query = [
      ['playerId', player.playerId],
      ['name', player.name],
      ['avatar', player.avatar],
      ['sect', player.sect],
    ].map(([key, value]) => key + '=' + encodeURIComponent(value || '')).join('&')
    wx.navigateTo({ url: '/pages/player/index?' + query })
  },

  addToCompare(event) {
    const player = this.data.results[event.currentTarget.dataset.index]
    if (!player) return
    if (!compareBasket.add(player)) {
      if (compareBasket.has(player.playerId)) return
      wx.showToast({ title: '最多选择 12 人', icon: 'none' })
      return
    }
    this.syncBasket()
  },

  removeFromCompare(event) {
    compareBasket.remove(event.currentTarget.dataset.id)
    this.syncBasket()
  },

  clearCompare() {
    compareBasket.clear()
    this.syncBasket()
  },

  openCompare() {
    if (compareBasket.count() < 2) return
    if (this.returnToCompare) {
      wx.navigateBack()
      return
    }
    wx.navigateTo({ url: '/pages/compare/index' })
  },

})
