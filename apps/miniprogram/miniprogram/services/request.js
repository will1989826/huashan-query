const tokenStore = require('./token')

const API_BASE = 'https://v2.huashan.tv/api'

function apiError(code, message, statusCode) {
  const error = new Error(message)
  error.code = code
  error.statusCode = statusCode || 0
  return error
}

function upstreamMessage(data) {
  if (!data || typeof data !== 'object') return ''
  const envelope = data.error
  if (!envelope || typeof envelope !== 'object') return ''
  return envelope.verbose_message || envelope.message || ''
}

function responseMessage(status) {
  if (status === 400 || status === 422) return '请求内容无效，请检查输入后重试。'
  if (status === 429) return '查询过于频繁，请稍后再试。'
  return '华山服务器暂时异常，请稍后重试。'
}

function request(path, options) {
  const config = options || {}
  const auth = config.auth !== false
  const token = tokenStore.getToken()

  if (auth && !token) {
    return Promise.reject(apiError('NO_TOKEN', '请先粘贴并验证 Token。'))
  }

  let task
  let aborted = false
  let completed = false
  const promise = new Promise((resolve, reject) => {
    task = wx.request({
      url: API_BASE + path,
      method: config.method || 'GET',
      data: config.data,
      timeout: config.timeout || 30000,
      header: auth ? { Authorization: 'Bearer ' + token } : {},
      success(response) {
        completed = true
        const status = response.statusCode
        if (status === 401 || status === 403) {
          tokenStore.clearSession()
          reject(apiError('TOKEN_EXPIRED', 'Token 已过期或无效，请重新粘贴。', status))
          return
        }
        if (status < 200 || status >= 300) {
          console.error('Huashan API returned a non-success status', {
            path,
            status,
            hasUpstreamMessage: Boolean(upstreamMessage(response.data)),
          })
          reject(apiError(
            'UPSTREAM_ERROR',
            responseMessage(status),
            status,
          ))
          return
        }
        resolve(response.data)
      },
      fail(cause) {
        completed = true
        if (cause && /abort/i.test(String(cause.errMsg || ''))) {
          reject(apiError('REQUEST_ABORTED', '请求已取消。'))
          return
        }
        const error = apiError('NETWORK_ERROR', '暂时无法连接华山服务器，请检查网络后重试。')
        error.cause = cause
        reject(error)
      },
    })
  })
  promise.abort = () => {
    if (aborted || completed) return
    aborted = true
    if (task && typeof task.abort === 'function') task.abort()
  }
  return promise
}

module.exports = { API_BASE, request, responseMessage }
