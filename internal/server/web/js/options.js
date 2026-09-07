// 首页常用功能与二级说明弹层。主题在 <head> 内联脚本里已按 localStorage 预设（避免闪烁）。

const $ = s => document.querySelector(s);
const EMAIL = '499635634@qq.com';
const MAILTO = 'mailto:' + EMAIL + '?subject=' + encodeURIComponent('华山战力查询 反馈与建议');
import { appVersion, currentToken, latest, manualTokenOnly, tokenValid } from './api.js';
import { closeModal, openModal } from './modal.js';
import './theme-registry.js';

// 远程清单里的文本可能含特殊字符：插进 HTML 前转义，避免破坏结构 / 注入。
const escText = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const escAttr = s => escText(s).replace(/"/g, '&quot;');

// —— 更新了什么（面向普通用户的更新内容，纯白话；发新版时在这里补一段）——
export const RELEASES = [
  { v: '0.8.0', date: '2026-09-07', items: [
    '个人概览新增可自定义的表现雷达图，可从百分比和场均分中选择 5 至 7 个维度；好人和狼人场均分分别按 8.5 分和 8 分封顶绘制',
    '2 至 4 人按阵营对比新增多人表现雷达图，可选择 5 至 7 个全员都有数据的维度并保留选择',
    '搜索结果中的门派较多或名称较长时会在卡片内完整换行，不再超出显示区域',
    '多人对比按指标排序后会保留横向浏览位置，不再跳回第一列',
    '雷达图会准确区分数据读取中、读取失败和维度缺失，调整多人雷达维度时也会保留横向浏览位置',
    '统一了负分四舍五入、未知赛果、复盘天数、同日连带技能、种子排序和中文版型排序口径',
  ] },
  { v: '0.7.1', date: '2026-09-02', items: [
    '重复打开同一版本时会直接使用现有页面，主题和资料队徽等页面设置会在下次打开时继续保留',
    '打开另一个版本时，正在运行的版本会先退出，再打开所选版本',
  ] },
  { v: '0.7.0', date: '2026-08-27', items: [
    '新增金风细雨楼主题，并优化鱼乐会主题的首页队标展示',
    '个人资料支持选择队徽，少人数对比也会显示每名选手选择的队徽',
    '多人对比支持批量添加选手，可一次确认重名或相近姓名',
    '使用说明升级为帮助中心，可按功能查看操作方法、常见问题、Token 获取和反馈方式',
    '华山工具箱新增分组模拟器，可按常规赛或踢馆赛排名逐队抽签，也可一键完成并查看四组排名',
  ] },
  { v: '0.6.0', date: '2026-08-27', items: [
    '主题新增青崖夜、朱砂笺和鱼乐会三种风格',
    '赛事数据必须选择具体比赛类型，不再汇总不同比赛类型的得分；比赛类型读取失败时可直接重试',
  ] },
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

const themeRegistry = globalThis.HUASHAN_THEME_REGISTRY;
export const THEMES = themeRegistry.themes;

export function currentTheme() { return themeRegistry.currentTheme(); }

export function setTheme(id) {
  if (!themeRegistry.applyTheme(id, { persist: true })) return;
  syncThemeUI();
}

export function restoreTheme() { themeRegistry.restoreTheme(); syncThemeUI(); }

function syncThemeUI() {
  if (typeof document === 'undefined') return;
  const active = currentTheme();
  themeRegistry.syncBrand(active);
  document.querySelectorAll('[data-theme-choice]').forEach(button => {
    const selected = button.dataset.themeChoice === active;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', selected ? 'true' : 'false');
  });
}

export function showTheme() {
  const el = $('#about');
  if (!el) return;
  const active = currentTheme();
  const cards = THEMES.map(theme => {
    const selected = theme.id === active;
    const team = theme.template === 'team';
    const palette = theme.palette || {};
    const previewStyle = team ? ` style="--preview-surface:${escAttr(palette.surface)};--preview-deep:${escAttr(palette.text)};--preview-primary:${escAttr(palette.primary)};--preview-secondary:${escAttr(palette.secondary)};--preview-accent:${escAttr(palette.accent)}"` : '';
    const crest = team ? `<img src="${escAttr(theme.crest)}" alt="">` : '';
    const previewClass = team ? 'team' : theme.id;
    return `<button type="button" class="theme-option${selected ? ' selected' : ''}" data-theme-choice="${theme.id}" aria-pressed="${selected}" onclick="setTheme('${theme.id}')">
      <span class="theme-preview theme-preview-${previewClass}"${previewStyle}>${crest}<i></i><i></i><i></i></span>
      <span class="theme-option-copy"><small>${escText(theme.kind)}</small><b>${escText(theme.name)}</b><em>${escText(theme.desc)}</em></span>
      <span class="theme-check" aria-hidden="true">✓</span>
    </button>`;
  }).join('');
  el.innerHTML = `<div class="ov-card theme-card">
    <div class="ov-head"><div><small>APPEARANCE</small><b id="theme-title">选择主题</b></div><button type="button" class="ov-close" onclick="closeAbout()">完成</button></div>
    <div class="theme-body"><p>主题会立即应用，并在下次打开时继续使用。</p><div class="theme-grid">${cards}</div></div>
  </div>`;
  openModal(el, { onClose: closeAbout, labelledBy: 'theme-title', focusSelector: '.theme-option.selected' });
}

if (typeof document !== 'undefined') syncThemeUI();

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

function helpHTML() {
  const loginHelp = manualTokenOnly()
    ? '<li>粘贴由已登录设备“获取 Token”中复制的有效 Token，再点“验证并登录”。</li>'
    : '<li>Windows 或 Mac 版先在电脑版微信打开自己的“华山战力页”并登录，再回到本工具点“开始实时检测”。</li>';
  const renewHelp = manualTokenOnly()
    ? '<li>Token 过期后，重新取得并粘贴一枚有效 Token。</li>'
    : '<li>登录信息过期后，回微信重开战力页登录，再回本程序重新检测。</li>';
  const tokenAction = tokenValid()
    ? '<button class="copy-btn" onclick="copyLoginToken()">复制当前 Token</button>'
    : '<p>当前登录尚未生效，完成登录后即可复制。</p>';
  return `<div class="ov-card guide-card">
    <div class="ov-head guide-head"><div><small>HELP CENTER</small><b id="guide-title">使用说明与常见问题</b></div><button type="button" class="ov-close" onclick="closeAbout()">关闭</button></div>
    <div class="about-body guide-body">
      <details id="help-usage" class="help-major">
        <summary><small>01</small><span><b>使用说明</b><em>各项功能的操作方法</em></span></summary>
        <div class="help-major-body">
          <nav class="help-index" aria-label="使用说明索引">
            <span>索引</span>
            <button type="button" onclick="jumpHelp('help-start')">快速开始</button>
            <button type="button" onclick="jumpHelp('help-personal')">个人数据</button>
            <button type="button" onclick="jumpHelp('help-compare')">多人对比</button>
            <button type="button" onclick="jumpHelp('help-events')">赛事数据</button>
            <button type="button" onclick="jumpHelp('help-tools')">工具箱</button>
            <button type="button" onclick="jumpHelp('help-login')">登录与数据</button>
          </nav>
          <details id="help-start" class="help-topic">
            <summary><small>01</small><b>快速开始</b><span>登录并选择功能</span></summary>
            <div class="help-topic-body"><ol class="help-steps">
              ${loginHelp}
              <li>登录成功后回到首页，选择“个人数据”“赛事数据”或“华山工具箱”。</li>
              <li>看到“加载中”或按钮置灰时保持页面打开，准备完成后内容会自动更新。</li>
            </ol></div>
          </details>
          <details id="help-personal" class="help-topic">
            <summary><small>02</small><b>个人数据</b><span>查询、范围、筛选与排序</span></summary>
            <div class="help-topic-body"><ol class="help-steps">
              <li>知道选手名时选择“按名字”；知道准确编号时选择“按 ID”。输入后点“搜索”，再从结果中点选手姓名进入详情。</li>
              <li>详情顶部按“赛区 → 赛季 → 门派”选择统计范围。“全部”表示合并当前可用范围；后面的选项会根据前面的选择更新，切换后页面会重新显示对应范围的数据。</li>
              <li>选手门派有可用队徽时，资料卡会在战力右侧显示队徽。详情顶部的“资料队徽”可以改选其他匹配队徽或选择不显示，选择会保存在本机。</li>
              <li>“概览”中的个人表现雷达图默认显示综合胜率、好人胜率、狼人胜率、投狼率和站对边率。点“选择维度”可改为 5 至 7 个已有指标，也可加入好人或狼人场均分；选择会保存在本机并用于之后查询的选手。</li>
              <li>“概览”还可查看综合、好人和狼人的完整指标；“角色表现”按身份汇总；“版型表现”按版型汇总；“逐场战绩”查看每一场比赛。</li>
              <li>角色、版型和逐场表格中，带排序标识的列名都可以点击。首次点击按该列从高到低排列，再点一次切换方向；姓名等文字列会按文字顺序排列，箭头表示当前方向。</li>
              <li>逐场战绩可按身份、门派、胜负、阵营以及 MVP、尽力、背锅标记筛选，多项条件可以同时使用；日期和分数也可以排序。</li>
              <li>“加载更多”只增加当前已经读取的战绩显示数量，不会改变筛选条件。点击任意一场可查看阵容、投票、技能和出局过程。</li>
            </ol></div>
          </details>
          <details id="help-compare" class="help-topic">
            <summary><small>03</small><b>多人对比</b><span>比较 2 至 12 名选手</span></summary>
            <div class="help-topic-body"><ol class="help-steps">
              <li>可以逐次搜索并点“＋ 对比”，也可以点“批量添加对比”，每行输入一个名字后统一查找。出现重名或相近姓名时，根据编号、门派和总分选择正确的选手。</li>
              <li>把 2 至 12 名选手加入对比篮后点“开始对比”。所有选手使用同一组赛区和赛季范围；批量查找只读取候选信息，开始对比后才读取所选选手的数据。</li>
              <li>对比 2 至 4 名选手时使用大图卡片，并显示每名选手在个人资料页确定的队徽；对比页不提供队徽选择，5 人以上的紧凑表格不显示队徽。</li>
              <li>“按阵营”下，2 至 4 名可见选手会显示多人表现雷达图。点“选择维度”可选择 5 至 7 个全员都有数据的指标，也可加入好人或狼人场均分；这组选择独立保存在本机，不影响个人概览雷达图。</li>
              <li>“按阵营”比较综合、好人和狼人表现；“按身份”查看身份矩阵或选择某个身份；“同场对比”只统计所有已选选手共同参加的对局。</li>
              <li>点击指标行或表格列名可以按该项排序；“自定义”可只保留关注的指标，隐藏选手只改变显示，不会改变同场对局的查找范围。</li>
              <li>同场对比可在表现汇总和逐场明细之间切换，并按版型筛选或调整日期顺序。</li>
            </ol></div>
          </details>
          <details id="help-events" class="help-topic">
            <summary><small>04</small><b>赛事数据</b><span>选择赛事并查看排名</span></summary>
            <div class="help-topic-body"><ol class="help-steps">
              <li>依次选择赛区、赛季和比赛类型，再点“查看赛事数据”。赛区决定可选赛季，赛区和赛季共同决定可选比赛类型，必须选定一种具体比赛类型。</li>
              <li>门派排名会先显示；门派均分和选手排名准备完成后，相应页签会自动变为可点击。</li>
              <li>点击带排序标识的列名可排序；首次点击数值列按从高到低排列，再点一次切换方向。页码用于分段查看，“展开全部”用于一次显示全部结果。</li>
              <li>点击门派可查看该赛事实际出场成员，成员表也可以排序；点击成员可进入个人数据，返回时会保留原来的赛事范围和浏览位置。</li>
            </ol></div>
          </details>
          <details id="help-tools" class="help-topic">
            <summary><small>05</small><b>华山工具箱</b><span>规则速查与赛事模拟</span></summary>
            <div class="help-topic-body"><ol class="help-steps">
              <li>“华山规则”可按分类浏览，也可输入关键词查找分数、评选、身份、技能和版型规则；清空关键词即可恢复当前分类的全部规则。</li>
              <li>“抽局积分模拟器”先按“赛区 → 赛季 → 比赛类型”选择范围，再点“读取比赛数据”。赛区和赛季会限制后续可选项。</li>
              <li>已完成比赛自动使用官方局分；未进行的比赛填写预测分。选择要抽掉的对局后，抽局积分、排名和门派顺序会立即更新。</li>
              <li>可以切换要编辑的对局，并比较不同抽局方案；带入积分和赛外违规扣分会保留，不会随某一局一起移除。</li>
              <li>“分组模拟器”先选择赛区和赛季，再从当前范围实际存在的“常规赛”或“踢馆赛”中选择一种，点“读取分组排名”。每次只使用所选比赛类型的数据。</li>
              <li>排名读取完成后，可以查看全部上榜门派的抽签顺序和当前分组状态。</li>
              <li>点“抽取下一队”会按排名抽取一支门派并随机放入仍有名额的小组；点“完成剩余分组”可一次完成，四组实时显示各自的组内排名。</li>
            </ol></div>
          </details>
          <details id="help-login" class="help-topic">
            <summary><small>06</small><b>登录与数据</b><span>续期、更新与退出</span></summary>
            <div class="help-topic-body"><ol class="help-steps">
              ${renewHelp}
              <li>点击首页“检查更新”可确认是否有新版本；“更新日志”用于查看各版本已经交付的变化。</li>
              <li>本次运行会复用已经读取和计算过的内容，重复查看同一范围通常会更快。如需查看官方最新结果，请点首页“退出程序”，看到“程序已退出”后重新打开。</li>
              <li>同一版本已经运行时，再次双击程序只会打开现有页面；主题和资料队徽等页面设置会在下次打开时继续使用。</li>
              <li>打开的是另一个版本时，正在运行的版本会先退出，再打开所选版本；尚未关闭的旧页面刷新后会使用当前版本。</li>
              <li>点击首页“退出程序”可立即退出；只关闭浏览器页面时，程序会在约 3 分钟后自动退出。</li>
            </ol></div>
          </details>
        </div>
      </details>

      <details id="help-faq" class="help-major faq-section">
        <summary><small>02</small><span><b>FAQ</b><em>加载、置灰与数据范围问题</em></span></summary>
        <div class="help-major-body faq-body">
          <p class="faq-lead">遇到等待、按钮置灰或结果没有变化时，可按页面和功能查找对应说明。</p>

        <div class="faq-group"><h4>个人数据</h4><div class="faq-list">
          <details class="faq-item"><summary>为什么搜索结果出来后，个人详情还要加载？</summary><p>搜索只用于找到选手，个人详情需要另外读取该选手的统计和历史对局，两份资料会先后显示。</p></details>
          <details class="faq-item"><summary>为什么有些选手不显示队徽，或需要先选择队徽？</summary><p>资料页只显示与当前门派范围准确匹配的已有队徽。没有匹配时不会显示；只匹配一枚时自动显示；匹配多枚时由你在详情顶部选择，也可以选择不显示。选择只保存在本机，不会修改选手资料。</p></details>
          <details class="faq-item"><summary>个人概览中哪些指标需要另行读取？</summary><p>战力值、荣誉，以及综合区的总分、总场次、场均分、胜率、存活率、人命值、MVP、尽力、背锅、警长次数；好人区的投狼率、站边数据和各身份技能命中率；狼人区的摸狼率、悍跳、自刀和刀人数据，都来自单独的选手统计。页面只显示官方在当前范围实际返回的项目，不需要等待全部逐场战绩。</p></details>
          <details class="faq-item"><summary>为什么雷达图有些维度暂不可选或无法绘制？</summary><p>雷达图使用当前范围已有的胜率、技能命中率和场均分。百分比按 100% 展示，好人场均分以 8.5 分为图形上限，狼人场均分以 8 分为图形上限；超过上限仍显示原始分数，图形按上限封顶。缺失数据不会用 0 补充，未选择且没有数据的维度会暂时置灰。门派范围仍在整理时会显示读取状态；读取失败时会提示重新查询，不会误报为维度缺失。</p></details>
          <details class="faq-item"><summary>为什么多人对比没有显示雷达图，或有些维度不能选择？</summary><p>多人雷达图只在“按阵营”下比较 2 至 4 名可见选手时显示。为了让每条图形使用同一口径，只能新增全员都有数据的维度；隐藏选手后，可选维度会按当前可见选手重新计算。</p></details>
          <details class="faq-item"><summary>为什么选择门派后，总场次、总分、场均分、胜率、MVP、尽力和背锅需要重新计算？</summary><p>官方的选手统计不能直接按本工具合并后的门派范围查询，只能从完整逐场战绩中筛出对应门派，再逐项汇总。</p></details>
          <details class="faq-item"><summary>为什么角色表现中的场次、场均分、胜率、MVP、尽力和背锅需要等待？</summary><p>官方没有直接提供按身份汇总的完整结果。本工具需要读取全部相关对局，再按每个身份分别统计。</p></details>
          <details class="faq-item"><summary>为什么版型表现中的场次、场均分、胜率、摸狼率、MVP、尽力和背锅需要等待？</summary><p>官方没有直接提供按版型汇总的完整结果。本工具需要按每场对局的版型和身份重新归类计算。</p></details>
          <details class="faq-item"><summary>为什么逐场战绩先显示一部分，筛选和排序暂时不能用？</summary><p>官方按页返回历史对局。全部页读取完成前，筛选或排序只会得到残缺结果，因此会暂时关闭。</p></details>
          <details class="faq-item"><summary>为什么第一次打开单局复盘需要等待？</summary><p>逐场列表只含比赛摘要。阵容、投票、技能和出局过程需要另行读取该局完整资料，再整理成复盘。</p></details>
          <details class="faq-item"><summary>为什么多人对比中的按身份和同场对比需要更久？</summary><p>“按阵营”只读取每名选手的概览；打开“按身份”或“同场对比”后，才会继续读取完整身份表现和逐场战绩。同场对比还要确认所有选手共同参加的对局后再汇总。</p></details>
        </div></div>

        <div class="faq-group"><h4>赛事数据</h4><div class="faq-list">
          <details class="faq-item"><summary>为什么赛季和比赛类型选择框有时会置灰？</summary><p>可选赛季取决于赛区，可选比赛类型又取决于赛区和赛季。前一项确认完成前，后一项没有可靠选项。</p></details>
          <details class="faq-item"><summary>为什么门派均分和选手排名暂时不能打开？</summary><p>门派排名可以先从官方榜单整理出来；门派均分和选手排名还需要继续读取当前赛事的选手资料并完成汇总，准备好后相应页签会自动恢复。</p></details>
          <details class="faq-item"><summary>为什么门派均分页签中的总分，也要和天数或场次、日均分或场均分一起等待？</summary><p>总分已经来自门派榜，但官方没有提供可靠的参赛量。本工具需要读取当前赛事的选手资料，确认各门派实际参赛量并算出均分后，再一次开放完整页签。</p></details>
          <details class="faq-item"><summary>为什么选手排名中的天数或场次、总分、均分、MVP、尽力和背锅需要等待？</summary><p>官方没有直接提供本工具所需的完整选手榜，需要逐页取得当前赛事的选手记录，再统一整理和排序。</p></details>
          <details class="faq-item"><summary>为什么门派成员的场次、总分、场均分、胜率、MVP、尽力和背锅需要等待？</summary><p>官方现有名单不能代表历史赛事的实际出场成员。本工具需要先确认参赛候选，再逐位读取战绩，只保留在当前赛事真实出场的成员。</p></details>
        </div></div>

        <div class="faq-group"><h4>华山工具箱</h4><div class="faq-list">
          <details class="faq-item"><summary>为什么抽局积分模拟器的赛季和比赛类型需要等待？</summary><p>程序需要先确认所选赛区有哪些可用赛季，以及哪些赛季已经进入可模拟的季后赛或总决赛。</p></details>
          <details class="faq-item"><summary>为什么官方局分、带入积分、赛外违规扣分、抽局积分和排名需要等待？</summary><p>官方没有提供可以直接使用的抽局模拟结果。本工具需要取得参赛门派和选手的逐场记录，还原已完成比赛与调整项后，再计算每一种抽局方案。</p></details>
          <details class="faq-item"><summary>为什么分组模拟器只显示常规赛和踢馆赛？</summary><p>分组模拟器用于这两种比赛。所选赛季没有对应赛事时，请切换赛区或赛季后再试。</p></details>
          <details class="faq-item"><summary>为什么读取排名时不能开始抽签？</summary><p>抽签需要使用当前赛事的完整门派排名。排名准备完成后，“抽取下一队”和“完成剩余分组”会自动开放。</p></details>
        </div></div>

        <div class="faq-group"><h4>加载与缓存</h4><div class="faq-list">
          <details class="faq-item"><summary>为什么 Mac 版检测不到微信登录信息？</summary><p>不同微信版本保存网页登录信息的位置可能不同，macOS 也可能阻止程序读取微信数据。请先在 Mac 微信中重新打开自己的“华山战力页”并登录；如果系统询问是否允许访问，请选择允许。仍然检测不到时，可以改用 Token 登录。</p></details>
          <details class="faq-item"><summary>为什么加载时要把按钮置灰？</summary><p>数据尚未齐全时继续操作，可能产生残缺结果或混入上一次的查询范围。准备完成后按钮会自动恢复，无需重复点击。</p></details>
          <details class="faq-item"><summary>为什么重新查询或再次双击程序后仍然是之前的数据？</summary><p>本次运行会固定已经读取的数据，避免同一页面前后出现不同结果。同一版本仍在运行时，再次双击只会打开现有页面。如需查看官方最新数据，请点首页“退出程序”，看到“程序已退出”后重新打开并查询。</p></details>
        </div></div>
        </div>
      </details>

      <details id="help-token" class="help-major">
        <summary><small>03</small><span><b>获取 Token</b><em>用于跨设备临时登录</em></span></summary>
        <div class="help-major-body help-service-body">
          <p>${manualTokenOnly() ? '当前系统无法自动读取电脑版微信的登录信息。请从已登录设备复制有效 Token，再粘贴到登录页完成验证。' : '当前登录有效时，可以复制本次登录的 Token，供另一台 Windows 或 Mac 设备临时登录。'}</p>
          <p>Token 是临时登录凭证，通常约 1 天有效。持有者可在有效期内读取该账号有权查看的数据，请仅通过可信方式发送给本人或可信对象。</p>
          <p>本工具只在本次运行中使用 Token，不会将其保存到磁盘；关闭程序后，本次使用的 Token 会从程序内存中清除。</p>
          ${tokenAction}
        </div>
      </details>
      <details id="help-feedback" class="help-major">
        <summary><small>04</small><span><b>问题反馈与联络</b><em>提交问题、截图或使用建议</em></span></summary>
        <div class="help-major-body help-service-body help-feedback">
          <p>遇到查询失败、数据异常或功能问题时，请说明程序版本、所在页面、操作步骤和页面提示；如方便，可附上截图，便于定位问题。</p>
          <p>请勿在反馈中发送 Token 或其他登录信息。也欢迎提出功能建议和使用体验方面的意见。</p>
          <p class="feedback-line"><button class="copy-btn" onclick="copyEmail()">复制联系邮箱</button><span class="mono">${EMAIL}</span><a href="${MAILTO}">新建反馈邮件</a></p>
          <p>本工具由 Will 独立制作，数据来自华山论剑官方，仅用于查询与展示。</p>
          <p class="about-credit">作者 · <b>Will</b>${appVersion() ? ' · ' + appVersion() : ''} · © 2026</p>
        </div>
      </details>
    </div>
  </div>`;
}

function showHelp() {
  const el = $('#about');
  if (!el) return;
  el.innerHTML = helpHTML();
  openModal(el, { onClose: closeAbout, labelledBy: 'guide-title', focusSelector: '.ov-close' });
}

export function jumpHelp(id) {
  const target = $('#' + id);
  if (!target) return;
  for (let node = target; node; node = node.parentElement) {
    if (node.tagName === 'DETAILS') node.open = true;
  }
  if (typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'start' });
}

export function showAbout() { showHelp(); }
export function closeAbout() { const el = $("#about"); if (el) { closeModal(el); el.innerHTML = ''; } }
