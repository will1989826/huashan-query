const themeStore = require('./services/theme')

App({
  onLaunch() {
    themeStore.logCrestRuntime()
  },
})
