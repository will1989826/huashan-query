// 网络层（薄壳）：只与本地服务 /api/* 交互。令牌注入、官方接口调用、分页、401 刷新都在 Go 侧完成；
// 浏览器不再持有令牌，也不知道官方接口地址。这里负责发本地请求、解析错误、维持心跳、维护“令牌有效至”。

const $ = s => document.querySelector(s);
let EXP = 0;   // 令牌到期时刻(ms)；由 /api/session 下发（只给到期时间，不给令牌本身）
let REASON = ''; // 无有效令牌时的精确原因：'no_token' | 'expired' | 'network'（有令牌时为空）
let VERSION = ''; // 构建版本号（由 /api/session 下发，供 ⚙ 菜单/关于展示）
let MANUAL_TOKEN_ONLY = false;
let localFailureShown = false;

// 本地服务一旦失联，当前页面已经无法自行恢复。只提示一次，停止继续请求并尝试关闭标签页。
// 外部程序打开的标签页可能被浏览器禁止脚本关闭，因此弹窗同时给出手动关闭说明。
function localServerError(cause) {
  const e = new Error('连接已断开，请重新启动“华山战力查询”。');
  e.name = 'LocalServerError'; e.status = 0; e.cause = cause;
  if (localFailureShown) return e;
  localFailureShown = true;
  stopHeartbeat();
  const message = '与“华山战力查询”的连接已断开。\n\n请重新启动程序；如果当前页面没有自动关闭，请手动关闭。';
  if (typeof window !== 'undefined') {
    try { if (typeof window.alert === 'function') window.alert(message); } catch (_) { }
    try { if (typeof window.close === 'function') window.close(); } catch (_) { }
  }
  return e;
}

async function localFetch(path, options) {
  try {
    const r = await fetch(path, options);
    return r;
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    throw localServerError(e);
  }
}

// 令牌失效(401)回调：由 main 注册（通常指向“回到引导页”）。用回调避免 api↔ui 循环依赖。
let onAuthLost = () => {};
export function setAuthLostHandler(fn) { onAuthLost = fn || (() => {}); }

export const tokenValid = () => EXP > Date.now();
export const sessionReason = () => REASON;
export const appVersion = () => VERSION;
export const manualTokenOnly = () => MANUAL_TOKEN_ONLY;

function applySession(d) {
  EXP = (d && d.exp ? d.exp : 0) * 1000;
  REASON = (d && d.reason) || '';
  MANUAL_TOKEN_ONLY = !!(d && d.manual_token_only);
  return d;
}

// 更新页脚“令牌有效至”。不再自行弹横幅——无/过期令牌交给引导页与 401 回调处理。
export function checkToken() {
  const el = $("#tokexp");
  if (el) el.textContent = tokenValid()
    ? '令牌有效至 ' + new Date(EXP).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) + ' · '
    : '';
}

// 向本地服务取会话信息（昵称 + 到期时间）。force=true 时带 ?refresh=1 让 Go 强制重扫令牌（引导页“重新检测”或 401）。
export async function refreshSession(force) {
  try {
    const r = await localFetch('/api/session' + (force ? '?refresh=1' : ''), { cache: 'no-store' });
    if (r.ok) {
      const d = await r.json();
      applySession(d);
      VERSION = (d && d.version) || '';
      return !!(d && d.nick);
    }
  } catch (e) {
    if (e && e.name === 'LocalServerError') throw e;
  }
  EXP = 0; REASON = '';
  return false;
}

async function tokenRequest(method, body) {
  const options = { method, cache: 'no-store' };
  if (body !== undefined) {
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(body);
  }
  const r = await localFetch('/api/token', options);
  const text = await r.text();
  let d; try { d = JSON.parse(text) } catch { d = null }
  if (!r.ok || (d && d.error)) {
    const info = d && d.error;
    const e = new Error((info && info.message) || ('HTTP ' + r.status));
    e.status = r.status; e.code = (info && info.code) || '';
    throw e;
  }
  return d || {};
}

// 令牌只在这两个显式用户操作中进入页面内存：手动提交、点击复制。
export async function setManualToken(token) {
  const d = await tokenRequest('PUT', { token });
  applySession(d);
  return d;
}
export async function currentToken() {
  const d = await tokenRequest('GET');
  return (d && d.token) || '';
}

// —— 心跳：页面每 3 秒敲一次；关标签页/后台冻结/休眠后，Go 侧连续 3 分钟收不到就退出 ——
// 浏览器会强节流甚至冻结后台标签页的定时器，所以回到前台/获得焦点/页面恢复时立刻补一次心跳，避免被误判超时。
let hbTimer = null;
let hbWake = null; // 保存唤醒监听器引用，stopHeartbeat 时对应移除，避免泄漏 / 重启时重复注册
export function startHeartbeat() {
  if (hbTimer) return;
  const beat = () => { localFetch('/api/heartbeat', { method: 'POST', cache: 'no-store' }).catch(() => {}); };
  hbWake = () => { if (typeof document === 'undefined' || document.visibilityState !== 'hidden') beat(); };
  beat();
  hbTimer = setInterval(beat, 3000);
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', hbWake);
  if (typeof window !== 'undefined') { window.addEventListener('focus', hbWake); window.addEventListener('pageshow', hbWake); }
}
export function stopHeartbeat() {
  if (hbTimer) { clearInterval(hbTimer); hbTimer = null; }
  if (hbWake) {
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', hbWake);
    if (typeof window !== 'undefined') { window.removeEventListener('focus', hbWake); window.removeEventListener('pageshow', hbWake); }
    hbWake = null;
  }
}

// 主动退出：停心跳 → 通知 Go 立即结束 → 页面显示“已退出”。
export async function quitApp() {
  stopHeartbeat();
  try { await fetch('/api/quit', { method: 'POST', cache: 'no-store', keepalive: true }); } catch (e) { }
  if (typeof document !== 'undefined' && document.body) document.body.innerHTML = '<div style="max-width:420px;margin:22vh auto;text-align:center;color:#93a1b2;font:15px/1.7 system-ui,sans-serif">程序已退出，可以关闭本页。</div>';
}

// req 是本地 API 的统一入口：GET /api<path>，解析 JSON，非 2xx 或 body.error 抛带 status 的错误；
// 401 顺带触发 onAuthLost（Go 已自动尝试刷新，仍 401 说明令牌被吊销/需重新登录微信）。
async function req(path, signal) {
  let r, t;
  try {
    r = await localFetch('/api' + path, { signal, cache: 'no-store' });
    t = await r.text();
  } catch (e) {
    if (e && (e.name === 'AbortError' || e.name === 'LocalServerError')) throw e;
    throw localServerError(e);
  }
  let d; try { d = JSON.parse(t) } catch { d = t }
  if (!r.ok || (d && d.error)) {
    const m = (d && d.error && (d.error.message || d.error.verbose_message)) || ("HTTP " + r.status);
    const e = new Error(m); e.status = r.status;
    if (r.status === 401) { EXP = 0; REASON = 'expired'; onAuthLost(); }
    throw e;
  }
  return d;
}

// —— 具体接口（薄封装本地 API）——
export const searchPlayers = (name, signal) => req('/players/search?name=' + encodeURIComponent(name), signal);
// 选手详情：qs 为已拼好的查询串（筛选/排序/分页条件）；计算全在 Go 侧完成，这里只取可渲染模型。
export const detail = (qs, signal) => req('/players/detail?' + qs, signal);
export const game = (gid, signal) => req('/games?id=' + encodeURIComponent(gid), signal);
export const eventCatalog = signal => req('/events/catalog', signal);
export const eventSeasons = (zone, signal) => {
  const p = new URLSearchParams({ zone: String(zone || 'SH') });
  return req('/events/seasons?' + p.toString(), signal);
};
export const eventAvailability = (season, zone, signal) => {
  const p = new URLSearchParams({ season: String(season || ''), zone: String(zone || 'SH') });
  return req('/events/availability?' + p.toString(), signal);
};
// 只探测当前赛区+赛季实际有数据的比赛类型（不连带探测其它赛区），供比赛类型下拉按需刷新。
export const eventSeasonTypes = (season, zone, signal) => {
  const p = new URLSearchParams({ season: String(season || ''), zone: String(zone || 'SH') });
  return req('/events/season-types?' + p.toString(), signal);
};
export const eventRankings = (season, type, zone, signal) => {
  const p = new URLSearchParams({ season: String(season || ''), type: String(type || ''), zone: String(zone || 'SH') });
  return req('/events/rankings?' + p.toString(), signal);
};
export const eventRankAggregate = (season, type, zone, signal) => {
  const p = new URLSearchParams({ season: String(season || ''), type: String(type || ''), zone: String(zone || 'SH') });
  return req('/events/metrics?' + p.toString(), signal);
};
export const eventTeam = (id, season, type, zone, signal) => {
  const p = new URLSearchParams({ id: String(id), season: String(season || ''), type: String(type || ''), zone: String(zone || 'SH') });
  return req('/events/team?' + p.toString(), signal);
};
// 检查更新：服务端代拉更新清单，返回 {configured,version,url,notes}。
export const latest = (signal) => req('/latest', signal);
