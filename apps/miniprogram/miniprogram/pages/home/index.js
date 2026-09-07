const compareBasket = require('../../services/compare-basket')
const themeStore = require('../../services/theme')
const tokenStore = require('../../services/token')

Page({
  data: {
    actionsOpen: false,
    panel: '',
    theme: 'dark',
    themeCrest: '',
    themeName: '青崖夜',
    themeOptions: themeStore.THEMES,
  },

  onLoad() {
    if (!tokenStore.hasToken()) {
      wx.reLaunch({ url: '/pages/session/index' })
      return
    }
    this.setData(themeStore.pageData())
  },

  openPersonal() {
    wx.navigateTo({ url: '/pages/search/index' })
  },

  openCompare() {
    const url = compareBasket.count() ? '/pages/compare/index' : '/pages/search/index?mode=compare'
    wx.navigateTo({ url })
  },

  openEvents() {
    wx.navigateTo({ url: '/pages/events/index' })
  },

  openTools() {
    wx.navigateTo({ url: '/pages/tools/index' })
  },

  toggleActions() {
    this.setData({ actionsOpen: !this.data.actionsOpen })
  },

  openHelp() {
    this.setData({ actionsOpen: false, panel: 'help' })
  },

  openTheme() {
    this.setData({ actionsOpen: false, panel: 'theme' })
  },

  selectTheme(event) {
    const selected = themeStore.select(event.currentTarget.dataset.id)
    if (!selected) return
    this.setData(themeStore.pageData())
  },

  onCrestImageLoad: themeStore.onCrestImageLoad,

  onCrestImageError: themeStore.onCrestImageError,

  openChangelog() {
    this.setData({ actionsOpen: false, panel: 'changelog' })
  },

  closeActions() {
    this.setData({ actionsOpen: false })
  },

  closePanel() {
    this.setData({ panel: '' })
  },

  stopPanelTap() {},

  onShareAppMessage() {
    return {
      title: '华山战力查询｜查战力、看战绩、做多人对比',
      path: '/pages/session/index',
    }
  },

  onShareTimeline() {
    return { title: '华山战力查询｜查战力、看战绩、做多人对比' }
  },
})
