// 首页常用功能与二级说明弹层。主题在 <head> 内联脚本里已按 localStorage 预设（避免闪烁）。

const $ = s => document.querySelector(s);
const EMAIL = '499635634@qq.com';
const MAILTO = 'mailto:' + EMAIL + '?subject=' + encodeURIComponent('华山战力查询 反馈与建议');
import { appVersion, currentToken, latest, manualTokenOnly, tokenValid } from './api.js';
import { closeModal, openModal } from './modal.js';

// 远程清单里的文本可能含特殊字符：插进 HTML 前转义，避免破坏结构 / 注入。
const escText = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const escAttr = s => escText(s).replace(/"/g, '&quot;');

// —— 更新了什么（面向普通用户的更新内容，纯白话；发新版时在这里补一段）——
export const RELEASES = [
  { v: '0.5.5', date: '2026-08-26', items: [
    '英文选手名搜索会补充常见大小写写法，并优先显示更相关的结果',
    '从赛事排名或门派成员打开个人数据后，可返回原来的赛事内容和浏览位置',
    '筛选、排序、对局和弹窗支持更完整的键盘操作，多个弹窗会按正确顺序显示和关闭',
    '浅色主题改用暖纸与朱砂配色，文字、按钮和数据高亮更清晰',
    '对局复盘使用完整的狼人杀出局原因名称',
  ] },
  { v: '0.5.4', date: '2026-08-26', items: [
    '华山工具箱新增抽局积分模拟器，可比较季后赛或总决赛抽掉任意一局后的积分与排名',
    '已完成比赛自动使用官方局分，填写未赛局分时会立即更新积分、排名和门派顺序',
    '程序运行期间，赛事数据固定使用首次查询结果；如需获取官方最新数据，请重启程序后重新查询',
  ] },
  { v: '0.5.3', date: '2026-08-26', items: [
    '微信登录后可持续检测新的登录信息，不必反复关闭页面和手动重试',
    '自动登录兼容更多新版微信存储格式，并在多个微信目录之间独立查找',
    '登录与 Token 页面改为和首页一致的布局，操作步骤和当前状态更清楚',
  ] },
  { v: '0.5.2', date: '2026-08-25', items: [
    '赛事数据分为门派排名、门派均分和选手排名，可分别查看门派与选手表现',
    '多人对比新增同场对比，可查看共同参加的对局和这些对局中的表现',
    '2 至 4 人对比改用更醒目的大图卡片，并按人数自动调整照片大小',
    '可排序的数据会始终显示排序标识，更容易发现和使用排序功能',
  ] },
  { v: '0.5.1', date: '2026-08-25', items: [
    '版型表现新增摸狼率：各版型下摸到狼人阵营身份的场次占比',
  ] },
  { v: '0.5.0', date: '2026-08-25', items: [
    '新增赛事数据：按赛区、赛季和比赛类型查看门派排名，可排序、分页或一次展开全部',
    '门派排名先显示总分，天数与均分算好后点按钮即可查看；点开门派可看出场成员',
    '新增华山工具箱，可查询分数、评选、身份、技能和版型规则',
    '新增 Apple 芯片 Mac 版本；分享会同时给出 Windows 和 Mac 下载地址',
    '首页汇总个人数据、赛事数据与工具箱；个人详情分概览、角色、版型和逐场四个页签',
  ] },
  { v: '0.3.1', date: '2026-08-24', items: [
    '自动检测不到本机登录信息时，可手动粘贴有效 Token 登录',
    '登录成功后，可一键复制当前 Token，方便发给信任的人使用',
  ] },
  { v: '0.3.0', date: '2026-08-24', items: [
    '搜索可「按名字」或「按 ID」精确查找，最相关的排在最前',
    '检查更新：打开程序会自动检查，有新版本会提示；也可在首页手动检查',
    '可一键把简介和下载地址分享给朋友',
  ] },
  { v: '0.2.0', date: '2026-08-23', items: [
    '多人对比：最多 12 人，按阵营或身份比场均分、胜率等',
  ] },
  { v: '0.0.1', date: '2026-08-22', items: [
    '首个版本：搜索选手，查看跨赛区 / 赛季 / 门派战绩，单场复盘，多维筛选，深浅色主题',
  ] },
];
export function showChangelog() {
  const el = $("#about"); if (!el) return;
  const cur = appVersion() || '';
  const blocks = RELEASES.map(r => {
    const tag = cur && ('v' + r.v) === cur ? ' <span class="badge">当前版本</span>' : '';
    return `<div><h4>v${escText(r.v)} <small style="color:var(--sub);font-weight:400">· ${escText(r.date)}</small>${tag}</h4>
      <ul>${r.items.map(t => `<li>${escText(t)}</li>`).join('')}</ul></div>`;
  }).join('');
  el.innerHTML = `<div class="ov-card about-card">
    <div class="ov-head"><b id="about-title">📝 更新日志</b><button type="button" class="ov-close" onclick="closeAbout()">关闭</button></div>
    <div class="about-body">${blocks}</div>
  </div>`;
  openModal(el, { onClose: closeAbout, labelledBy: 'about-title', focusSelector: '.ov-close' });
}

// —— 检查更新 ——
// 语义化版本比较：a>b 返回 1，a<b 返回 -1，相等 0。去掉前导 v 与预发布/构建后缀，逐段数值比较。
export function cmpVer(a, b) {
  const norm = s => String(s || '').replace(/^v/i, '').split(/[-+]/)[0].split('.').map(n => parseInt(n, 10) || 0);
  const x = norm(a), y = norm(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d < 0 ? -1 : 1; }
  return 0;
}
// fetchUpdate：取清单并与当前版本比对，归一成状态；不碰 UI（手动/静默两条路复用）。
// 返回 status：'new'（有新版，带 d/cur）| 'latest' | 'unconfigured' | 'error'（含连不上：静默路径据此不打扰）。
async function fetchUpdate() {
  let d;
  try { d = await latest(); }
  catch (e) { return { status: 'error' }; }   // 连不上/超时/服务器错都归 error——静默路径一律不报错
  if (!d || d.configured === false) return { status: 'unconfigured' };
  const cur = appVersion();
  if (!cur) return { status: 'latest' };   // 当前版本未知（会话尚未就绪）：不比较、不误判为有新版
  if (cmpVer(d.version, cur) > 0) return { status: 'new', d, cur };
  return { status: 'latest', cur };
}

// 手动“检查更新”（首页）：全程有反馈——检查中/已最新/失败都提示。
export async function checkUpdate() {
  toast('正在检查更新…');
  const r = await fetchUpdate();
  if (r.status === 'new') { showUpdate(r.d, r.cur); return; }
  if (r.status === 'unconfigured') { toast('暂未开放在线检查更新'); return; }
  if (r.status === 'error') { toast('检查更新失败，请稍后再试'); return; }
  toast('已经是最新版本' + (r.cur ? '（' + r.cur + '）' : ''));
}

// 启动静默检查：只有确实有新版本才弹提示；最新/未配置/连不上一律静默，绝不报错、不打扰。
export async function autoCheckUpdate() {
  const r = await fetchUpdate();
  if (r.status === 'new') showUpdate(r.d, r.cur);
}

function showUpdate(d, cur) {
  const el = $("#about"); if (!el) return;
  const notes = d.notes ? `<p style="white-space:pre-wrap">${escText(d.notes)}</p>` : '';
  const safeUrl = (d.url && /^https?:\/\//i.test(d.url)) ? d.url : '';   // 仅接受 http(s)，挡下 javascript: 等
  const link = safeUrl ? `<p><a class="gate-btn" style="display:inline-block;text-decoration:none" href="${escAttr(safeUrl)}" target="_blank" rel="noopener">立即下载新版本</a></p>` : '';
  el.innerHTML = `<div class="ov-card about-card">
    <div class="ov-head"><b id="about-title">发现新版本 v${escText(String(d.version).replace(/^v/i, ''))}</b><button type="button" class="ov-close" onclick="closeAbout()">以后再说</button></div>
    <div class="about-body">
      <p>你当前是 <b>${escText(cur || '—')}</b>，有新版本可用。</p>
      ${notes}${link}
      <p class="muted">下载后关闭本程序、用新版本重新打开即可；也可稍后在首页点「检查更新」再下。</p>
    </div>
  </div>`;
  openModal(el, { onClose: closeAbout, labelledBy: 'about-title', focusSelector: '.ov-close' });
}

export function shareText(d) {
  const downloads = (d && d.downloads) || {};
  const links = [
    ['Windows', downloads.windows_amd64 || (d && d.url)],
    ['Mac（Apple 芯片）', downloads.mac_arm64],
  ].filter(([, url]) => url && /^https?:\/\//i.test(url));
  if (!links.length) return '';
  return '华山论剑 · 数据查询\n查选手战绩、赛事排名和华山规则，支持多人对比。\n' +
    links.map(([label, url]) => `${label}：${url}`).join('\n') + '\n作者：Will';
}

// 分享给朋友：复制简介及更新清单中的全部平台直链。
export async function shareApp() {
  let text = '';
  try { text = shareText(await latest()); } catch (e) { }
  if (!text) { toast('暂时获取不到下载地址，请稍后再试'); return; }
  const ok = await copyText(text);
  toast(ok ? '简介和下载地址已复制，粘贴发给朋友即可' : '复制失败，请重试');
}

export function toggleTheme() {
  const el = document.documentElement;
  const light = el.getAttribute('data-theme') === 'light';
  if (light) { el.removeAttribute('data-theme'); saveTheme('dark'); }
  else { el.setAttribute('data-theme', 'light'); saveTheme('light'); }
}
function saveTheme(t) { try { localStorage.setItem('theme', t); } catch (e) { } }

// 复制反馈邮箱到剪贴板（127.0.0.1 是安全上下文，clipboard 可用；失败退回 textarea 兜底），并弹提示。
export async function copyEmail() {
  const ok = await copyText(EMAIL);
  toast(ok ? ('已复制邮箱：' + EMAIL + '，欢迎邮件反馈') : ('请手动复制邮箱：' + EMAIL));
}

export async function copyLoginToken() {
  try {
    const token = await currentToken();
    const ok = token && await copyText(token);
    toast(ok ? '当前登录 Token 已复制，请只发给你信任的人' : '复制失败，请重试');
  } catch (e) {
    toast((e && e.status === 401) ? '当前登录已失效，请重新登录' : '复制失败，请重试');
  }
}
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); return true; } catch (e) { }
  try {
    const ta = document.createElement('textarea');
    ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.focus(); ta.select();
    const ok = document.execCommand('copy'); document.body.removeChild(ta); return ok;
  } catch (e) { return false; }
}
let toastTimer = null;
function toast(msg) {
  let el = $("#toast");
  if (!el) { el = document.createElement('div'); el.id = 'toast'; el.className = 'toast'; document.body.appendChild(el); }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

export function showAbout() {
  const el = $("#about");
  if (!el) return;
  const loginHelp = manualTokenOnly()
    ? '<li>Mac 版不读取微信本地数据，请粘贴由已登录 Windows 版“使用说明”中的“复制当前 Token”取得的有效 Token。</li>'
    : '<li>先在<b>电脑版微信</b>里打开自己的『华山战力页』登录一次，再回到本工具点<b>「开始实时检测」</b>；检测时战力页可以保持打开（登录状态约 1 天有效）。</li>';
  const renewHelp = manualTokenOnly()
    ? '<li>令牌过期后，请重新取得并粘贴一枚有效 Token。</li>'
    : '<li>登录信息过期后，回微信重开战力页登录，再回本程序点<b>「开始实时检测」</b>。</li>';
  const tokenTools = tokenValid() ? `<details class="about-submenu">
        <summary>登录与 Token</summary>
        <div class="about-submenu-body">
          <p>需要在另一台设备登录时，可以复制当前 Token。Token 等同登录凭证，请只发给你信任的人。</p>
          <button class="copy-btn" onclick="copyLoginToken()">复制当前 Token</button>
        </div>
      </details>` : '';
  el.innerHTML = `<div class="ov-card about-card">
    <div class="ov-head"><b id="about-title">使用说明 / 关于</b><button type="button" class="ov-close" onclick="closeAbout()">关闭</button></div>
    <div class="about-body">
      <h4>使用说明</h4>
      <ol>
        ${loginHelp}
        <li>从首页进入<b>「个人数据」</b>，可按名字搜索选手，也可按 ID 精确查找；点选后可查看跨赛区 / 赛季 / 门派战绩，点任意一场可查看复盘（阵容 · 投票 · 技能）。</li>
        <li>想同时比多人？在搜索结果点『＋ 对比』加进对比篮（最多 12 人），再点『开始对比』——可<b>按阵营</b>、<b>按身份</b>排序比较，也可通过<b>同场对比</b>查看共同参加的对局和这些对局中的表现。</li>
        <li>从首页进入<b>「赛事数据」</b>，选择赛区、赛季和比赛类型后，可查看门派排名与出场成员。</li>
        <li>从首页进入<b>「华山工具箱」</b>，可按主题浏览或搜索华山规则。</li>
        <li>数据不会自动刷新；想查看最新数据，请<b>关闭本程序再重新打开</b>。</li>
        ${renewHelp}
      </ol>
      ${tokenTools}
      <h4>关于 / 反馈</h4>
      <p>数据来自华山论剑官方，仅用于查询展示。本工具不会保存登录 Token。</p>
      <p>有 bug 或建议，欢迎反馈：</p>
      <p class="feedback-line">
        <button class="copy-btn" onclick="copyEmail()">复制邮箱</button>
        <span class="mono">${EMAIL}</span>
        <a href="${MAILTO}">用邮件客户端发送</a>
      </p>
      <p class="about-credit">作者 · <b>Will</b>${appVersion() ? ' · ' + appVersion() : ''} · © 2026</p>
    </div>
  </div>`;
  openModal(el, { onClose: closeAbout, labelledBy: 'about-title', focusSelector: '.ov-close' });
}
export function closeAbout() { const el = $("#about"); if (el) { closeModal(el); el.innerHTML = ''; } }
