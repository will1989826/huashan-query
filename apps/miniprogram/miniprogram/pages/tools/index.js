const themeStore = require('../../services/theme')
const tokenStore = require('../../services/token')

Page({
  data: { theme: 'dark' },
  onLoad() {
    this.setData(themeStore.pageData())
    if (!tokenStore.hasToken()) wx.reLaunch({ url: '/pages/session/index' })
  },
  openRules() { wx.navigateTo({ url: '/pages/rules/index' }) },
  openDraw() { wx.navigateTo({ url: '/pages/draw/index' }) },
  openGroup() { wx.navigateTo({ url: '/pages/group/index' }) },
})
