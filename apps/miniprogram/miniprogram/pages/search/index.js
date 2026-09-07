const huashan = require('../../services/huashan')
const compareBasket = require('../../services/compare-basket')
const shared = require('../../services/shared')
const themeStore = require('../../services/theme')
const tokenStore = require('../../services/token')

Page({
  data: {
    basket: [],
    basketCount: 0,
    basketFull: false,
    batchOpen: false,
    batchText: '',
    batchLoading: false,
    batchRows: [],
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
    this.compareMode = options && options.mode === 'compare'
    this.returnToCompare = options && options.return === 'compare'
    this.searchGeneration = 0
    this.setData({ compareMode: this.compareMode })
    this.syncBasket()
  },

  onUnload() {
    this.searchGeneration += 1
  },

  onShow() {
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
  },

  onNameInput(event) {
    this.setData({ name: event.detail.value, error: '' })
  },

  toggleBatch() {
    this.setData({ batchOpen: !this.data.batchOpen, batchRows: [], error: '' })
  },

  onBatchInput(event) {
    this.setData({ batchText: event.detail.value || '', batchRows: [], error: '' })
  },

  async resolveBatch() {
    if (this.data.batchLoading) return
    const names = [...new Set(String(this.data.batchText || '').split(/[\n,，;；]+/)
      .map((name) => name.trim()).filter(Boolean))]
    if (!names.length) {
      wx.showToast({ title: '请输入选手名', icon: 'none' })
      return
    }
    const remaining = compareBasket.MAX - compareBasket.count()
    if (remaining <= 0) {
      wx.showToast({ title: '对比篮已满', icon: 'none' })
      return
    }
    const selectedNames = names.slice(0, remaining)
    if (selectedNames.length < names.length) wx.showToast({ title: '只处理剩余 ' + remaining + ' 个名额', icon: 'none' })
    const generation = ++this.searchGeneration
    this.setData({ batchLoading: true, batchRows: [], error: '' })
    try {
      const rows = await shared.mapLimit(selectedNames, 4, async (name) => {
        const found = (await huashan.searchPlayersByName(name)).map(huashan.playerView)
        const folded = name.toLocaleLowerCase()
        const exact = found.filter((player) => String(player.name || '').toLocaleLowerCase() === folded)
        const candidates = exact.length ? exact : found
        return {
          query: name,
          candidates,
          candidateLabels: candidates.map((player) => player.name + ' · #' + player.playerId),
          selectedIndex: 0,
          status: candidates.length ? (candidates.length > 1 ? '请选择正确选手' : '已确认') : '未找到',
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
      if (generation === this.searchGeneration) this.setData({ batchLoading: false })
    }
  },

  onBatchCandidateChange(event) {
    const rowIndex = Number(event.currentTarget.dataset.index)
    const selectedIndex = Number(event.detail.value) || 0
    const batchRows = this.data.batchRows.map((row, index) => (
      index === rowIndex ? { ...row, selectedIndex, status: '已确认' } : row
    ))
    this.setData({ batchRows })
  },

  confirmBatch() {
    let added = 0
    this.data.batchRows.forEach((row) => {
      const player = row.candidates[row.selectedIndex]
      if (player && compareBasket.add(player)) added += 1
    })
    this.syncBasket()
    this.setData({ batchOpen: false, batchText: '', batchRows: [] })
    wx.showToast({ title: added ? '已加入 ' + added + ' 人' : '没有新增选手', icon: 'none' })
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
    if (!compareBasket.count()) return
    if (this.returnToCompare) {
      wx.navigateBack()
      return
    }
    wx.navigateTo({ url: '/pages/compare/index' })
  },

})
