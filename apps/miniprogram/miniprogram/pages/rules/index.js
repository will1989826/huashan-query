const rules = require('../../services/rules')
const themeStore = require('../../services/theme')

Page({
  data: {
    theme: 'dark', version: rules.RULE_VERSION, categories: rules.RULE_CATEGORIES,
    categoryIndex: 0, indexItems: [], article: null, query: '', results: [], searching: false,
    quickRules: rules.QUICK_RULES.map(([id, label]) => ({ id, label })),
  },
  onLoad() {
    this.setData(themeStore.pageData())
    this.selectCategoryByIndex(0)
  },
  selectCategory(event) { this.selectCategoryByIndex(Number(event.currentTarget.dataset.index)) },
  selectCategoryByIndex(categoryIndex) {
    const category = rules.RULE_CATEGORIES[categoryIndex] || rules.RULE_CATEGORIES[0]
    const indexItems = category.articles.map((id) => rules.RULE_BY_ID[id])
    this.setData({ categoryIndex, indexItems, query: '', results: [], searching: false, article: rules.articleView(indexItems[0]) })
  },
  openArticle(event) { this.openById(event.currentTarget.dataset.id) },
  openById(id) {
    const item = rules.RULE_BY_ID[id]
    if (!item) return
    const categoryIndex = rules.RULE_CATEGORIES.findIndex((category) => category.id === item.category)
    const category = rules.RULE_CATEGORIES[categoryIndex]
    this.setData({
      categoryIndex,
      indexItems: category.articles.map((articleId) => rules.RULE_BY_ID[articleId]),
      article: rules.articleView(item), query: '', results: [], searching: false,
    })
    wx.pageScrollTo({ scrollTop: 0, duration: 0 })
  },
  onSearch(event) {
    const query = event.detail.value.trim()
    this.setData({ query, searching: Boolean(query), results: rules.search(query) })
  },
  clearSearch() { this.setData({ query: '', searching: false, results: [] }) },
})
