// 选项菜单：右上角浮层，聚合“元操作”（主题 / 使用说明·关于 / 复制反馈邮箱），不改动主界面布局。
// 主题在 <head> 内联脚本里已按 localStorage 预设（避免闪烁），这里只负责切换与持久化。

const $ = s => document.querySelector(s);
const EMAIL = '499635634@qq.com';
const MAILTO = 'mailto:' + EMAIL + '?subject=' + encodeURIComponent('华山战力查询 反馈与建议');
import { appVersion, latest } from './api.js';

// 远程清单里的文本可能含特殊字符：插进 HTML 前转义，避免破坏结构 / 注入。
const escText = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const escAttr = s => escText(s).replace(/"/g, '&quot;');

export function toggleOpt() {
  const m = $("#optmenu");
  if (m) {
    m.hidden = !m.hidden;
    if (!m.hidden) { const v = $("#optver"); if (v) v.textContent = appVersion() ? ('版本 ' + appVersion()) : ''; }
  }
}
export function closeOpt() { const m = $("#optmenu"); if (m) m.hidden = true; }

// —— 更新了什么（面向普通用户的更新内容，纯白话；发新版时在这里补一段）——
const RELEASES = [
  { v: '0.2.0', date: '2026-08-23', items: [
    '多人对比：最多把 12 名选手拉到一起，按阵营或身份比场均分、胜率等',
    '可以直接按选手 ID 精确查找（搜索框上方切换「按名字 / 按 ID」）',
    '搜到最可能是目标的人后自动预加载，点开更快',
    '界面文字更直白',
  ] },
  { v: '0.0.1', date: '2026-08-22', items: [
    '首个版本：搜索选手，查看跨赛区 / 赛季 / 门派战绩，单场复盘，多维筛选，深浅色主题',
  ] },
];
export function showChangelog() {
  const el = $("#about"); if (!el) return;
  el.style.display = 'flex';
  const cur = (appVersion() || '').replace(/-test$/, '');
  const blocks = RELEASES.map(r => {
    const tag = cur && ('v' + r.v) === cur ? ' <span class="badge">当前版本</span>' : '';
    return `<div><h4>v${escText(r.v)} <small style="color:var(--sub);font-weight:400">· ${escText(r.date)}</small>${tag}</h4>
      <ul>${r.items.map(t => `<li>${escText(t)}</li>`).join('')}</ul></div>`;
  }).join('');
  el.innerHTML = `<div class="ov-card about-card">
    <div class="ov-head"><b>🆕 更新了什么</b><span class="ov-close" onclick="closeAbout()">关闭</span></div>
    <div class="about-body">${blocks}</div>
  </div>`;
}

// —— 检查更新 ——
// 语义化版本比较：a>b 返回 1，a<b 返回 -1，相等 0。去掉前导 v 与 -test/+build 后缀，逐段数值比较。
export function cmpVer(a, b) {
  const norm = s => String(s || '').replace(/^v/i, '').split(/[-+]/)[0].split('.').map(n => parseInt(n, 10) || 0);
  const x = norm(a), y = norm(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d < 0 ? -1 : 1; }
  return 0;
}
export async function checkUpdate() {
  toast('正在检查更新…');
  let d;
  try { d = await latest(); }
  catch (e) {
    if (e && (e.name === 'LocalServerError' || e.name === 'TestVersionExpiredError')) return;
    toast('检查更新失败，请稍后再试'); return;
  }
  if (!d || d.configured === false) { toast('暂未开放在线检查更新'); return; }
  const cur = appVersion();
  if (cmpVer(d.version, cur) > 0) showUpdate(d, cur);
  else toast('已经是最新版本' + (cur ? '（' + cur + '）' : ''));
}
function showUpdate(d, cur) {
  const el = $("#about"); if (!el) return;
  el.style.display = 'flex';
  const notes = d.notes ? `<p style="white-space:pre-wrap">${escText(d.notes)}</p>` : '';
  const safeUrl = (d.url && /^https?:\/\//i.test(d.url)) ? d.url : '';   // 仅接受 http(s)，挡下 javascript: 等
  const link = safeUrl ? `<p><a href="${escAttr(safeUrl)}" target="_blank" rel="noopener">前往下载新版本</a></p>` : '';
  el.innerHTML = `<div class="ov-card about-card">
    <div class="ov-head"><b>发现新版本</b><span class="ov-close" onclick="closeAbout()">关闭</span></div>
    <div class="about-body">
      <p>最新版本 <b>v${escText(String(d.version).replace(/^v/i, ''))}</b>，你当前是 <b>${escText(cur || '—')}</b>。</p>
      ${notes}${link}
      <p class="muted">下载后关闭本程序，用新版本重新打开即可。</p>
    </div>
  </div>`;
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
  el.style.display = 'flex';
  el.innerHTML = `<div class="ov-card about-card">
    <div class="ov-head"><b>使用说明 / 关于</b><span class="ov-close" onclick="closeAbout()">关闭</span></div>
    <div class="about-body">
      <h4>使用说明</h4>
      <ol>
        <li>先在<b>电脑版微信</b>里打开自己的『华山战力页』登录一次（令牌约 1 天有效）。</li>
        <li>上方搜索选手名（也可直接输入选手 ID），点选后查看其跨赛区 / 赛季 / 门派战绩；点任意一场看复盘（阵容 · 投票 · 技能）。</li>
        <li>想同时比多人？在搜索结果点『＋ 对比』把选手加进对比篮（最多 12 人），再点『开始对比』——可<b>按阵营</b>（综合 / 好人 / 狼人）或<b>按身份</b>（各身份的场均分 / 胜率等）排序比较。</li>
        <li>数据是打开程序时抓取的快照，不会自动更新；若怀疑已过期，<b>关闭本程序再重新打开</b>即可获取最新。</li>
        <li>令牌过期后回微信重开战力页，再点页面提示里的「刷新」。</li>
      </ol>
      <h4>关于 / 反馈</h4>
      <p>数据来自华山论剑官方接口，仅在本地查询展示，不保存任何人的令牌。</p>
      <p>有 bug 或建议，欢迎反馈：</p>
      <p class="feedback-line">
        <button class="copy-btn" onclick="copyEmail()">复制邮箱</button>
        <span class="mono">${EMAIL}</span>
        <a href="${MAILTO}">用邮件客户端发送</a>
      </p>
      <p class="about-credit">作者 · <b>Will</b>${appVersion() ? ' · ' + appVersion() : ''} · © 2026</p>
    </div>
  </div>`;
}
export function closeAbout() { const el = $("#about"); if (el) { el.style.display = 'none'; el.innerHTML = ''; } }
