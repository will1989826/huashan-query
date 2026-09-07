const huashan = require('../../services/huashan')
const compareBasket = require('../../services/compare-basket')
const themeStore = require('../../services/theme')

Page({
  data: {
    error: '',
    loading: false,
    rawToken: '',
    theme: 'dark',
    tokenVisible: false,
  },

  onLoad() {
    this.setData(themeStore.pageData())
  },

  onTokenInput(event) {
    this.setData({ rawToken: event.detail.value, error: '' })
  },

  toggleTokenVisibility() {
    this.setData({ tokenVisible: !this.data.tokenVisible })
  },

  async validate() {
    if (this.data.loading) return
    this.setData({ loading: true, error: '' })
    try {
      await huashan.validateToken(this.data.rawToken)
      compareBasket.clear()
      this.setData({ rawToken: '' })
      wx.reLaunch({ url: '/pages/home/index' })
    } catch (error) {
      this.setData({ error: error.message || 'Token 验证失败，请稍后重试。' })
    } finally {
      this.setData({ loading: false })
    }
  },
})
