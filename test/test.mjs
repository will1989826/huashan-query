// 前端单元测试：直接 import ES 模块（无需 vm/正则抽取）。运行：node --test test/test.mjs
// 计算类逻辑（聚合/筛选/候选/阵营归类/分页）已下沉到 Go(internal/player)，相应用例见 player_test.go；
// 这里只测“展示层”：配色、技能/投票/标记文案、赛区名解析、HTML 构造器、以及只连本地的 api 薄壳。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  skillLabel, roleColor, roleWeight, campColor, seatVotes, seatSkills, skillText, uniq, isWolf, fmt, isGoodCamp, causeText,
} from '../internal/server/web/js/format.js';
import { resolveZone } from '../internal/server/web/js/zone.js';
import { renderDetailHTML, renderGameHTML, detailLoadingHTML, gateHTML, showGate, enterApp, retryToken, prefetchPlayer, searchName, playerSearchVariants, mergePlayerSearchResults, mergeTeamNames, rankByRelevance, parseBatchNames, resolveBatchPlayerNames, batchSelectionState, profileCrestCandidates, resolveProfileCrest, selectProfileCrest, __setV } from '../internal/server/web/js/ui.js';
import { searchPlayers, detail, game, eventCatalog, eventSeasons, eventAvailability, eventRankings, eventRankAggregate, eventTeam, drawTool, groupDrawTool, prewarmDrawTool, latest, refreshSession, setManualToken, currentToken, setAuthLostHandler, tokenValid, sessionReason, appVersion, startHeartbeat, stopHeartbeat, quitApp } from '../internal/server/web/js/api.js';
import { cmpVer, autoCheckUpdate, shareText, showAbout, closeAbout, currentTheme, setTheme, restoreTheme, showTheme, RELEASES, THEMES } from '../internal/server/web/js/options.js';
import { renderEventsHTML, renderEventTeamHTML, syncEventFilters, queryEvents, showHome, showPersonal, closePersonal, showTools, showEvents, showEventTeam, closeEventTeam, setEventTab, __setEventsState } from '../internal/server/web/js/events.js';
import { calculateScenario, mergeProjections, projectionStorageKey, rankWithTies, setDrawProjection, selectDrawRemoved, syncDrawFilters, __setDrawState } from '../internal/server/web/js/draw-tool.js';
import { groupCapacities, drawNextAssignment, renderGroupToolHTML, usableGroupTypes, retryGroupTool, __setGroupState } from '../internal/server/web/js/group-tool.js';
import { closeModal, openModal } from '../internal/server/web/js/modal.js';
import { setView } from '../internal/server/web/js/view.js';
import { showProfileCrestPicker } from '../internal/server/web/js/ui.js';
import { batchInputState, showBatchSearch, syncBatchInput, runBatchSearch, closePop, confirmBatchPlayers, confirmBatchName, editBatchName, removeBatchName, batchNameKeydown, pasteBatchNames } from '../internal/server/web/js/ui.js';
import {
  DEFAULT_RADAR_METRICS, RADAR_MAX, RADAR_METRICS, RADAR_MIN, compareRadarSVG, compareRadarView,
  normalizeRadarSelection, radarGroups, radarSVG, radarView, toggleRadarSelection,
} from '../internal/server/web/js/profile-radar.js';
import miniProfileRadar from '../apps/miniprogram/miniprogram/services/profile-radar.js';

const styles = readFileSync(new URL('../internal/server/web/styles.css', import.meta.url), 'utf8');
const indexHTML = readFileSync(new URL('../internal/server/web/index.html', import.meta.url), 'utf8');

test('默认浅色主题：使用华山昼版配色，移除旧主题样式与入口', () => {
  assert.equal(globalThis.HUASHAN_THEME_REGISTRY.defaultTheme, 'huashan-day');
  const rootVars = new Map([...styles.match(/:root\{([^}]+)\}/)[1].matchAll(/(--[\w-]+):([^;]+);/g)].map(([, key, value]) => [key, value]));
  const day = THEMES.find(theme => theme.id === 'huashan-day');
  const appliedVars = new Map();
  const previousDocument = globalThis.document;
  globalThis.document = { documentElement: { setAttribute() {}, style: {
    setProperty(key, value) { appliedVars.set(key, value); }, removeProperty() {},
  } } };
  try {
    globalThis.HUASHAN_THEME_REGISTRY.applyTheme(day.id);
    for (const [key, value] of rootVars) {
      if (appliedVars.has(key)) assert.equal(value, appliedVars.get(key), key);
    }
    assert.equal(rootVars.get('--bg'), day.palette.background);
    assert.equal(rootVars.get('--acc'), day.palette.primary);
  } finally {
    globalThis.document = previousDocument;
  }
  assert.doesNotMatch(styles, /\[data-theme=(?:dark|light)\]|theme-preview-(?:dark|light)/);
  assert.match(indexHTML, /id="theme-current-name">华山论剑·昼</);
});

const PALETTE_KEYS = [
  'background', 'surface', 'surfaceAlt', 'border', 'text', 'muted',
  'primary', 'primarySoft', 'secondary', 'accent', 'accentText', 'link',
  'danger', 'hover', 'onPrimary', 'buttonTop', 'buttonBottom',
];

test('战队主题模板：各战队只提供注册信息、语义配色和队徽', () => {
  assert.deepEqual(THEMES.map(theme => [theme.id, theme.name]), [
    ['huashan-day', '华山论剑·昼'], ['huashan-night', '华山论剑·夜'],
    ['yulehui', '鱼乐会'], ['jinfeng-xiyulou', '金风细雨楼'],
  ]);
  const teamThemes = THEMES.filter(theme => theme.template === 'team');
  assert.deepEqual(teamThemes.map(theme => theme.crest), [
    'assets/yulehui-crest.webp',
    'assets/jinfeng-xiyulou-crest.webp',
  ]);
  for (const theme of teamThemes) {
    assert.deepEqual(Object.keys(theme.palette).sort(), [...PALETTE_KEYS].sort());
    assert.deepEqual(theme.matchNames, [theme.name]);
    assert.ok(readFileSync(`./internal/server/web/${theme.crest}`).length > 0);
  }
  const team = THEMES.find(theme => theme.id === 'jinfeng-xiyulou');
  assert.deepEqual(
    [team.palette.background, team.palette.text, team.palette.primary, team.palette.accentText],
    ['#f2f5f8', '#18304d', '#1e466f', '#775700'],
  );
  assert.match(styles, /\[data-theme-template=team\] body\{/);
  assert.match(styles, /background:var\(--team-crest\) center\/contain no-repeat/);
  assert.doesNotMatch(styles, /\[data-theme=(?:yulehui|jinfeng-xiyulou)\]/);
  assert.match(styles, /\.home-team-brand img\{[^}]*width:116px;[^}]*height:116px;/);
});

test('赛事主题模板：昼夜共用字标，使用各自的山水背景', () => {
  const brandThemes = THEMES.filter(theme => theme.template === 'brand');
  assert.deepEqual(brandThemes.map(theme => [theme.id, theme.kind]), [
    ['huashan-day', '赛事'], ['huashan-night', '赛事'],
  ]);
  for (const theme of brandThemes) {
    // 品牌主题在语义配色之外还要给出天光与地色，用来铺渐变底。
    assert.deepEqual(Object.keys(theme.palette).sort(), [...PALETTE_KEYS, 'sky', 'ground'].sort());
    assert.equal(theme.wordmark, 'assets/huashan-wordmark.svg');
    assert.ok(readFileSync(`./internal/server/web/${theme.landscape}`).length > 0);
  }
  assert.deepEqual(brandThemes.map(theme => theme.landscape), [
    'assets/huashan-day-landscape.webp', 'assets/huashan-night-landscape.webp',
  ]);
  const wordmark = readFileSync('./internal/server/web/assets/huashan-wordmark.svg', 'utf8');
  assert.match(wordmark, /viewBox="-6 -6 318 84"/);
  // 字身、金描边和立体侧影三层都在，缺一层就不是原字标的配色了。
  assert.match(wordmark, /fill="#fefefc"/);
  assert.match(wordmark, /url\(#hs-wordmark-rim\)/);
  assert.match(wordmark, /x="4" y="4" fill="#8d867f"/);

  assert.match(styles, /\[data-theme=huashan-day\]\{color-scheme:light\}/);
  assert.match(styles, /\[data-theme=huashan-night\]\{color-scheme:dark\}/);
  assert.match(styles, /\[data-theme-template=brand\] body\{[^}]*background-image:var\(--brand-landscape\),linear-gradient\(180deg,var\(--brand-sky\) 0,var\(--brand-ground\) 62%,var\(--bg\)\)/);
  assert.match(styles, /\[data-theme-template=brand\] \.page-head\{[^}]*var\(--theme-secondary\)[^}]*var\(--gold\)/);
  assert.match(styles, /background-image:var\(--brand-landscape\)/);
  assert.match(styles, /\.home-choice\.events::after\{content:"榜"\}/);
  // 昼夜配色差异只写在注册表里，样式表不该按主题 id 分叉。
  assert.doesNotMatch(styles, /\[data-theme=huashan-(?:day|night)\] /);
  assert.match(indexHTML, /<img id="home-brand-wordmark" alt="">/);
});

test('批量添加弹窗：标题不贴边，输入与状态颜色跟随当前主题', () => {
  assert.match(styles, /\.batch-card \.ov-head\{[^}]*padding:16px 18px 12px;[^}]*border-bottom:1px solid var\(--line\)/);
  assert.match(styles, /\.batch-name-input\{[^}]*color:var\(--fg\)/);
  assert.match(styles, /\.batch-slots\{[^}]*grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
  assert.doesNotMatch(styles, /\.batch-body\{[^}]*(?:overflow|max-height)/);
  assert.match(styles, /\.batch-slot\[data-state=confirmed\]\{[^}]*background:var\(--acc-d\)/);
  assert.match(styles, /\.batch-entry-head>b\{[^}]*min-width:0;[^}]*overflow-wrap:anywhere/);
  assert.match(styles, /\.batch-status\.error,\.batch-status\.empty\{[^}]*color:var\(--danger\)/);
  assert.match(styles, /\.batch-candidate>img\{[^}]*background:var\(--card2\)/);
  assert.match(styles, /\.batch-input-meta>b\{[^}]*color:var\(--acc\)/);
  assert.match(styles, /\.batch-input-meta>\.batch-input-error\{[^}]*color:var\(--danger\)/);
  assert.match(styles, /\[hidden\]\{display:none!important\}/);
});

test('个人搜索结果：选手有很多门派时文字会在卡片内换行', () => {
  assert.match(styles, /\.item-open\{[^}]*min-width:0;[^}]*white-space:normal/);
  assert.match(styles, /\.item-open>span\{[^}]*min-width:0;[^}]*flex:1/);
  assert.match(styles, /\.item-open \.nm,\.item-open \.sect\{[^}]*overflow-wrap:anywhere/);
});

test('个人表现雷达图：桌面版与小程序使用相同的维度、默认值和数量边界', () => {
  assert.equal(RADAR_MIN, 5);
  assert.equal(RADAR_MAX, 7);
  assert.deepEqual(miniProfileRadar.METRICS.map(metric => metric.id), RADAR_METRICS.map(metric => metric.id));
  assert.deepEqual(miniProfileRadar.DEFAULTS, DEFAULT_RADAR_METRICS);
  assert.deepEqual(DEFAULT_RADAR_METRICS, [
    'summary.win_pct', 'good.win_pct', 'wolf.win_pct', 'good.toulang_pct', 'good.zhanbian_pct',
  ]);

  const withDuplicates = ['wolf.fds_pct', 'wolf.fds_pct', 'unknown', 'summary.win_pct'];
  const normalized = normalizeRadarSelection(withDuplicates);
  assert.equal(normalized.length, RADAR_MIN);
  assert.equal(new Set(normalized).size, normalized.length);
  assert.deepEqual(miniProfileRadar.normalize(withDuplicates), normalized);

  let selected = [...DEFAULT_RADAR_METRICS];
  selected = toggleRadarSelection(selected, selected[0], false);
  assert.deepEqual(selected, DEFAULT_RADAR_METRICS);
  selected = toggleRadarSelection(selected, 'summary.cunhuo_pct', true);
  selected = toggleRadarSelection(selected, 'good.cunhuo_pct', true);
  selected = toggleRadarSelection(selected, 'wolf.cunhuo_pct', true);
  assert.equal(selected.length, RADAR_MAX);
  assert.equal(selected.includes('wolf.cunhuo_pct'), false);
});

test('个人表现雷达图：百分比和场均分按各自上限绘制，缺失值不会按零生成图形', () => {
  const groups = {
    summary: { win_pct: 61 },
    good: { win_pct: 58, toulang_pct: 72, zhanbian_pct: 66 },
    wolf: { win_pct: 64 },
  };
  const complete = radarView(groups, DEFAULT_RADAR_METRICS);
  assert.equal(complete.complete, true);
  assert.deepEqual(complete.axes.map(axis => axis.value), [61, 58, 64, 72, 66]);
  assert.match(radarSVG(complete), /class="radar-shape"/);
  assert.match(radarSVG(complete), /综合胜率 61%/);

  const missing = radarView({ ...groups, wolf: {} }, DEFAULT_RADAR_METRICS);
  assert.equal(missing.complete, false);
  assert.deepEqual(missing.missing.map(axis => axis.id), ['wolf.win_pct']);
  assert.doesNotMatch(radarSVG(missing), /class="radar-shape"/);
  assert.deepEqual(radarGroups({
    comprehensive: [{ key: 'win_pct', val: 61 }],
    good: [{ key: 'win_pct', val: 58 }],
    wolf: [{ key: 'win_pct', val: 64 }],
  }), { summary: { win_pct: 61 }, good: { win_pct: 58 }, wolf: { win_pct: 64 } });

  const scoreSelection = [
    'summary.win_pct', 'good.win_pct', 'wolf.win_pct',
    'good.round_point_avg', 'wolf.round_point_avg',
  ];
  const scores = radarView({
    summary: { win_pct: 60 },
    good: { win_pct: 60, round_point_avg: 4.25 },
    wolf: { win_pct: 60, round_point_avg: 9 },
  }, scoreSelection);
  assert.equal(scores.axes.find(axis => axis.id === 'good.round_point_avg').normalizedValue, 50);
  assert.equal(scores.axes.find(axis => axis.id === 'wolf.round_point_avg').normalizedValue, 100);
  assert.equal(scores.axes.find(axis => axis.id === 'wolf.round_point_avg').valueText, '9分');
  assert.match(radarSVG(scores), /好人场均分 4\.25分/);
});

test('多人表现雷达图：2 至 4 人共用维度，只有全员数据完整时绘制多组图形', () => {
  const groups = (offset = 0) => ({
    summary: { win_pct: 50 + offset },
    good: { win_pct: 51 + offset, toulang_pct: 52 + offset, zhanbian_pct: 53 + offset },
    wolf: { win_pct: 54 + offset },
  });
  const players = Array.from({ length: 4 }, (_, index) => ({ id: index + 1, name: '选手' + (index + 1), groups: groups(index) }));
  const view = compareRadarView(players, DEFAULT_RADAR_METRICS);
  assert.equal(view.complete, true);
  assert.equal(view.axes.length, 5);
  assert.deepEqual(view.axes[0].values, [50, 51, 52, 53]);
  assert.equal((compareRadarSVG(view).match(/class="compare-radar-shape/g) || []).length, 4);

  const incompletePlayers = players.map((player, index) => index === 3
    ? { ...player, groups: { ...player.groups, wolf: {} } }
    : player);
  const incomplete = compareRadarView(incompletePlayers, DEFAULT_RADAR_METRICS);
  assert.equal(incomplete.complete, false);
  assert.equal(incomplete.options.find(option => option.id === 'wolf.win_pct').availableCount, 3);
  assert.equal(compareRadarSVG(incomplete), '');

  const scores = compareRadarView([
    { id: 1, name: '甲', groups: { summary: { win_pct: 50 }, good: { win_pct: 50, round_point_avg: 8.5 }, wolf: { win_pct: 50, round_point_avg: 4 } } },
    { id: 2, name: '乙', groups: { summary: { win_pct: 50 }, good: { win_pct: 50, round_point_avg: 4.25 }, wolf: { win_pct: 50, round_point_avg: 8 } } },
  ], ['summary.win_pct', 'good.win_pct', 'wolf.win_pct', 'good.round_point_avg', 'wolf.round_point_avg']);
  assert.deepEqual(scores.axes.find(axis => axis.id === 'good.round_point_avg').normalizedValues, [100, 50]);
  assert.deepEqual(scores.axes.find(axis => axis.id === 'wolf.round_point_avg').normalizedValues, [50, 100]);
  assert.deepEqual(scores.axes.find(axis => axis.id === 'wolf.round_point_avg').valueTexts, ['4分', '8分']);
});

test('主题切换：同步页面属性、当前名称、选中状态和本地存储', () => {
  const previousDocument = globalThis.document;
  const previousStorage = globalThis.localStorage;
  const rootAttrs = new Map();
  const rootStyles = new Map();
  const stored = new Map();
  const name = { textContent: '' };
  const teamName = { textContent: '' };
  const teamEnglishName = { textContent: '' };
  const teamImageAttrs = new Map();
  const teamImage = {
    setAttribute: (key, value) => teamImageAttrs.set(key, value),
    removeAttribute: key => teamImageAttrs.delete(key),
  };
  const wordmarkAttrs = new Map();
  const wordmarkImage = {
    setAttribute: (key, value) => wordmarkAttrs.set(key, value),
    removeAttribute: key => wordmarkAttrs.delete(key),
  };
  const choices = THEMES.map(theme => {
    const classes = new Set();
    const attrs = new Map();
    return {
      dataset: { themeChoice: theme.id }, classes, attrs,
      classList: { toggle: (value, on) => on ? classes.add(value) : classes.delete(value) },
      setAttribute: (key, value) => attrs.set(key, value),
    };
  });
  globalThis.document = {
    documentElement: {
      getAttribute: key => rootAttrs.get(key) || null,
      setAttribute: (key, value) => rootAttrs.set(key, value),
      removeAttribute: key => rootAttrs.delete(key),
      style: {
        setProperty: (key, value) => rootStyles.set(key, value),
        removeProperty: key => rootStyles.delete(key),
      },
    },
    querySelector: selector => ({
      '#theme-current-name': name,
      '#home-team-crest': teamImage,
      '#home-team-name': teamName,
      '#home-team-english-name': teamEnglishName,
      '#home-brand-wordmark': wordmarkImage,
    }[selector] || null),
    querySelectorAll: selector => selector === '[data-theme-choice]' ? choices : [],
  };
  globalThis.localStorage = { setItem: (key, value) => stored.set(key, value) };
  try {
    for (const theme of THEMES) {
      setTheme(theme.id);
      assert.equal(currentTheme(), theme.id);
      assert.equal(rootAttrs.get('data-theme'), theme.id);
      const team = theme.template === 'team';
      const brand = theme.template === 'brand';
      assert.equal(rootAttrs.get('data-theme-template') || '', theme.template || '');
      assert.equal(name.textContent, theme.name);
      assert.equal(stored.get('theme'), theme.id);
      assert.equal(rootStyles.get('--acc') || '', team || brand ? theme.palette.primary : '');
      assert.equal(teamName.textContent, team ? theme.name : '');
      assert.equal(teamEnglishName.textContent, team ? theme.englishName : '');
      assert.equal(teamImageAttrs.get('src') || '', team ? theme.crest : '');
      assert.equal(rootStyles.get('--team-crest') || '', team ? `url("${theme.crest}")` : '');
      // 品牌主题额外注入字标与天光地色；切回其他主题时这些变量必须清掉。
      assert.equal(wordmarkAttrs.get('src') || '', brand ? theme.wordmark : '');
      assert.equal(rootStyles.get('--brand-wordmark') || '', brand ? `url("${theme.wordmark}")` : '');
      assert.equal(rootStyles.get('--brand-landscape') || '', brand ? `url("${theme.landscape}")` : '');
      assert.equal(rootStyles.get('--brand-sky') || '', brand ? theme.palette.sky : '');
      assert.equal(rootStyles.get('--brand-ground') || '', brand ? theme.palette.ground : '');
      for (const choice of choices) {
        const selected = choice.dataset.themeChoice === theme.id;
        assert.equal(choice.classes.has('selected'), selected);
        assert.equal(choice.attrs.get('aria-pressed'), String(selected));
      }
    }
  } finally {
    globalThis.document = previousDocument;
    globalThis.localStorage = previousStorage;
  }
});

test('主题持久化：注册表在样式加载前恢复任意已注册主题', () => {
  assert.ok(indexHTML.indexOf('<script src="js/theme-registry.js"></script>') < indexHTML.indexOf('<link rel="stylesheet" href="styles.css">'));
  const previousDocument = globalThis.document;
  const previousStorage = globalThis.localStorage;
  try {
    for (const [stored, expected] of [
      ...THEMES.map(theme => [theme.id, theme.id]),
      ...['', 'dark', 'light', 'unknown'].map(id => [id, 'huashan-day']),
    ]) {
      const attrs = new Map();
      const currentName = { textContent: '' };
      globalThis.localStorage = { getItem: key => key === 'theme' ? stored : null };
      globalThis.document = {
        documentElement: {
          getAttribute: key => attrs.get(key) || null,
          setAttribute: (key, value) => attrs.set(key, value),
          removeAttribute: key => attrs.delete(key),
          style: { setProperty() {}, removeProperty() {} },
        },
        querySelector: selector => selector === '#theme-current-name' ? currentName : null,
        querySelectorAll: () => [],
      };
      restoreTheme();
      assert.equal(attrs.get('data-theme') || null, expected);
      assert.equal(currentTheme(), expected);
      assert.equal(attrs.get('data-theme-template'), THEMES.find(theme => theme.id === expected).template);
      assert.equal(currentName.textContent, THEMES.find(theme => theme.id === expected).name);
      globalThis.localStorage = { getItem() { throw new Error('Storage unavailable'); } };
      restoreTheme();
      assert.equal(currentTheme(), 'huashan-day');
    }
  } finally {
    globalThis.document = previousDocument;
    globalThis.localStorage = previousStorage;
  }
});

test('主题弹窗：按当前主题渲染初始选中态', () => {
  const previousDocument = globalThis.document;
  const rootAttrs = new Map([['data-theme', 'yulehui']]);
  const attrs = new Map([['aria-hidden', 'true']]);
  const about = {
    style: {}, inert: false, innerHTML: '',
    setAttribute: (key, value) => attrs.set(key, value),
    getAttribute: key => attrs.get(key),
    hasAttribute: key => attrs.has(key),
    querySelector: () => null,
    querySelectorAll: () => [],
    focus() {},
  };
  globalThis.document = {
    activeElement: null,
    documentElement: { getAttribute: key => rootAttrs.get(key) || null },
    body: { classList: { toggle() {} } },
    querySelector: selector => selector === '#about' ? about : null,
    querySelectorAll: () => [],
  };
  try {
    showTheme();
    assert.equal(about.style.display, 'flex');
    assert.match(about.innerHTML, /class="theme-option selected" data-theme-choice="yulehui" aria-pressed="true"/);
    assert.match(about.innerHTML, /class="theme-preview theme-preview-team"[^>]*--preview-primary:#0866e8/);
    assert.match(about.innerHTML, /<img src="assets\/yulehui-crest\.webp" alt="">/);
    assert.match(about.innerHTML, /data-theme-choice="jinfeng-xiyulou" aria-pressed="false"/);
    assert.match(about.innerHTML, /<img src="assets\/jinfeng-xiyulou-crest\.webp" alt="">/);
    assert.match(about.innerHTML, /data-theme-choice="huashan-day" aria-pressed="false"/);
    assert.match(about.innerHTML, /data-theme-choice="huashan-night" aria-pressed="false"/);
    assert.doesNotMatch(about.innerHTML, /data-theme-choice="(?:dark|light)"/);
    assert.equal(attrs.get('aria-labelledby'), 'theme-title');
  } finally {
    closeAbout();
    globalThis.document = previousDocument;
  }
});

test('出局原因：使用术语表中的完整名称', () => {
  assert.equal(causeText('wolfbeauty_link'), '狼美人连人');
  assert.equal(causeText('gargoyle'), '石像鬼猎杀');
  assert.equal(causeText('dream'), '摄梦致死');
});

test('skillLabel：固定动词的角色 + 其余按角色名自动拆前缀', () => {
  assert.equal(skillLabel('狼刀', '狼'), '刀');
  assert.equal(skillLabel('狼刀', '狼王'), '刀');   // 席位狼王、技能名“狼刀” → 回退角色词表
  assert.equal(skillLabel('女巫解', '女巫'), '救');   // 特殊：解→救
  assert.equal(skillLabel('女巫毒', '女巫'), '毒');   // 自动拆：女巫毒→毒
  assert.equal(skillLabel('侦探翻', '侦探'), '翻牌');
  assert.equal(skillLabel('警犬验', '警犬'), '验');
  assert.equal(skillLabel('预言家', '预言家'), '验');
  assert.equal(skillLabel('摄梦人', '摄梦人'), '摄');
  assert.equal(skillLabel('猎人', '猎人'), '带');
  assert.equal(skillLabel('猎人开枪', '猎人'), '带');   // 角色固定动词优先
  assert.equal(skillLabel('守卫', '守卫'), '守');
  // 技能名=角色名会拆空 / 拆歪的角色：按技能名显式给动词（依据规则手册）
  assert.equal(skillLabel('梦魇', '梦魇'), '恐惧');
  assert.equal(skillLabel('狼美人', '狼美人'), '魅惑');
  assert.equal(skillLabel('猎魔人', '猎魔人'), '狩猎');
  assert.equal(skillLabel('石像鬼', '石像鬼'), '查验');
  assert.equal(skillLabel('骑士骑', '骑士'), '决斗');
  // 梦魇/狼美人行里的“狼刀”条目仍按狼刀处理（不被本角色动词吃掉）；石像鬼后期猎杀也记在狼刀名下
  assert.equal(skillLabel('狼刀', '梦魇'), '刀');
  assert.equal(skillLabel('狼刀', '狼美人'), '刀');
  assert.equal(skillLabel('狼刀', '石像鬼'), '刀');   // 石像鬼最后一天猎杀=狼刀（本角色技能名恒为查验）
});

test('roleColor / roleWeight：平民灰、狼阵营(含石像鬼/血月使徒)红、神职珠宝色', () => {
  assert.equal(roleColor('狼'), '#ff6b6b');
  assert.equal(roleColor('狼王'), '#ff2d2d');
  assert.equal(roleColor('白狼王'), '#ff9463');
  assert.equal(roleColor('石像鬼'), '#d6604a');   // 第三方→狼阵营红
  assert.equal(roleColor('血月使徒'), '#a8324a');
  assert.equal(roleColor('梦魇'), '#b5495b');       // 无“狼”字的狼阵营身份也为红系
  assert.equal(roleColor('怪盗狼王'), '#ff5a5f');
  assert.equal(roleColor('平民'), '#93a1b2');
  assert.equal(roleColor('预言家'), '#5aa2f5');
  assert.equal(roleColor('某未知神'), '#5aa2f5');  // 默认神职
  assert.equal(roleWeight('平民'), '');
  assert.equal(roleWeight('石像鬼'), ';font-weight:700');
});

test('campColor：牌局弹层收敛为阵营三色（狼红/神蓝/民灰），不分细分身份', () => {
  assert.equal(campColor('平民'), 'var(--sub)');
  assert.equal(campColor('狼'), 'var(--danger)');
  assert.equal(campColor('狼王'), 'var(--danger)');       // 各类狼统一红
  assert.equal(campColor('石像鬼'), 'var(--danger)');     // 狼阵营第三方同红
  assert.equal(campColor('梦魇'), 'var(--danger)');
  assert.equal(campColor('预言家'), 'var(--blue)');       // 神职统一蓝
  assert.equal(campColor('女巫'), 'var(--blue)');
  assert.equal(campColor('某未知神'), 'var(--blue)');
});

test('seatVotes：投 0 / 空不显示，含警徽票', () => {
  const s = { vote_day1: '6', vote_day2: '0', vote_day3: '', vote_jinhui: 11 };
  assert.equal(seatVotes(s, 3), 'D1→6　警徽→11');
  assert.equal(seatVotes({ vote_day1: '5', vote_jinhui: 0 }, 1), 'D1→5');
  assert.equal(seatVotes({ vote_day1: '0' }, 3), '—');
});

test('seatSkills：只取有目标的技能，动作+目标座位', () => {
  const seer = { rpt_name: '女巫', skills: [
    { day: 1, name: '女巫解', target_seats: [9] },
    { day: 2, name: '女巫毒', target_seats: [4] },
    { day: 3, light: false, target_seat: 0 },
  ]};
  assert.equal(seatSkills(seer), 'D1 救→9　D2 毒→4');
  const prophet = { rpt_name: '预言家', skills: [
    { day: 1, name: '预言家', target_seats: [3] },
    { day: 2, name: '预言家', target_seats: [7] },
  ]};
  assert.equal(seatSkills(prophet), 'D1 验→3　D2 验→7');
  assert.equal(seatSkills({ rpt_name: '平民', skills: [] }), '—');
});

test('skillText：怪盗狼王对自己=顶盾(无号)，对他人/其他角色=动词→座位', () => {
  assert.equal(skillText({ name: '怪盗', day: 1, target_seats: [5] }, '怪盗狼王', 5), '顶盾');
  assert.equal(skillText({ name: '怪盗', day: 1, target_seats: [8] }, '怪盗狼王', 5).endsWith('→8'), true);
  assert.equal(skillText({ name: '狼刀', day: 1, target_seats: [5] }, '狼', 5), '刀→5');
  assert.equal(skillText({ name: '怪盗', day: 1, target_seats: ['5'] }, '怪盗狼王', 5), '顶盾');
});

test('seatSkills：怪盗狼王自己发动 → D1 顶盾（无箭头号码）', () => {
  const s = { rpt_name: '怪盗狼王', seat: 5, skills: [{ day: 1, name: '怪盗', target_seats: [5] }] };
  assert.equal(seatSkills(s), 'D1 顶盾');
});

test('resolveZone：赛区中文名/代码/全部 → 代码（显式传入 joined）', () => {
  const joined = [{ ordering: 'SD', text: '山东赛区' }, { ordering: 'BJ', text: '北京赛区' }];
  assert.equal(resolveZone('山东赛区', joined), 'SD');
  assert.equal(resolveZone('SD', joined), 'SD');
  assert.equal(resolveZone('北京', joined), 'BJ');
  assert.equal(resolveZone('', joined), 'ALL');
  assert.equal(resolveZone('全部赛区', joined), 'ALL');
  assert.equal(resolveZone('查无此区', joined), 'ALL');
});

test('uniq / isWolf 辅助', () => {
  assert.deepEqual(uniq([1, 1, 2, 3, 3, 2]), [1, 2, 3]);
  assert.equal(isWolf('狼王'), true);
  assert.equal(isWolf('平民'), false);
});

test('fmt：字段名+数值 → 中文标签 + 百分号；缺失显示 —（标签是页面的活，Go 只给 key/val）', () => {
  assert.deepEqual(fmt('win_pct', 37), { name: '胜率', val: '37%' });
  assert.deepEqual(fmt('total_point', 10), { name: '总分', val: 10 });
  assert.deepEqual(fmt('total_point', null), { name: '总分', val: '—' });
  assert.equal(fmt('unknown_pct', 5).val, '5%');
});

test('isGoodCamp：好人=非狼且非第三方（逐场表阵营快捷筛选用）', () => {
  assert.equal(isGoodCamp('平民'), true);
  assert.equal(isGoodCamp('预言家'), true);
  assert.equal(isGoodCamp('狼'), false);
  assert.equal(isGoodCamp('石像鬼'), false);
  assert.equal(isGoodCamp('梦魇'), false);
});

test('选手门派：资料数据在前，逐场数据只补齐缺失项', () => {
  assert.deepEqual(
    mergeTeamNames([{ name: '旧门派' }, { sect_name: '鱼乐会' }], ['鱼乐会', '新门派'], '旧门派 · 其他门派'),
    ['旧门派', '鱼乐会', '新门派', '其他门派'],
  );
});

// —— 纯 HTML 构造器：renderDetailHTML 消费 Go 的数值模型 + 页面本地交互态 ——
// model = 后端 DetailView（聚合为 KV 数值、逐场为作用域原始行）；state 包裹它 + gf/sort/roleSort/limit
const model = over => ({
  player: { id: 7, name: '张三', avatar: '' },
  zone: 'ALL', season: '', sect: '',
  power: 1234,
  joined: [{ ordering: 'SD', text: '山东赛区' }],
  honors: [{ zone_id: 'SD', season_id: 6, code: '1' }],
  teams: ['门派A'],
  comprehensive: [{ key: 'round_total', val: 1 }, { key: 'round_point_avg', val: 5 }, { key: 'win_pct', val: 100 }],
  good: [{ key: 'toulang_pct', val: 10 }, { key: 'zhanbian_pct', val: 80 }], wolf: [],
  roles: [{ role: '平民', n: 1, avg: 5, win: 100, mvp: 1, svp: 0, bgx: 0 }],
  editions: [{ edition: '狼王摄梦人', n: 1, avg: 5, win: 100, molang: 100, mvp: 1, svp: 0, bgx: 0 }],
  season_cands: [6], sect_cands: ['门派A'],
  games: [{ game_id: 11, play_date: '2024-01-01', season_id: 6, round: 1, seat: 3, sect_name: '门派A', rpt_name: '平民', total_point: 5, win: 1, mvp: 1, svp: 0, bgx: 0 }],
  games_trunc: false, stats_error: '', games_error: '',
  ...over,
});
const state = over => {
  const { model: mOver, ...rest } = over;
  return {
    id: 7, gf: { result: '', camp: '', role: '', sect: '', mark: '' },
    sort: { key: 'play_date', dir: -1 }, roleSort: { key: 'n', dir: -1 }, limit: 20,
    ...rest, model: model(mOver || {}),
  };
};

test('renderDetailHTML：个人头部、概览与按需切换的详情页签完整渲染', () => {
  const html = renderDetailHTML(state({}));
  assert.match(html, /张三/);
  assert.match(html, /1234/);              // 战力值（原样数值）
  assert.match(html, /门派A/);
  assert.match(html, /个人数据分类/);
  assert.doesNotMatch(html, /openGame\(11\)/);
  assert.match(html, /🎯 综合/);
  const edition = renderDetailHTML(state({ detailTab: 'editions' }));
  assert.match(edition, /🧩 版型表现/);
  assert.match(edition, /狼王摄梦人/);
  assert.match(edition, /摸狼率/);          // 版型表含摸狼率列（狼人阵营场次占比）
  const games = renderDetailHTML(state({ detailTab: 'games' }));
  assert.match(games, /openGame\(11\)/);
  assert.match(games, /共 1 场/);
  assert.match(html, /总场次/);            // fmt 把 round_total 译成中文标签（页面做）
  assert.match(html, /山东 S6 冠军/);       // zoneName(SD,joined)→山东赛区→去“赛区”；code 1→冠军
  assert.match(html, /100%/);              // 胜率由 comprehensive.win_pct 现格式化
  assert.match(html, /10%/);               // 投狼率来自 good.toulang_pct
  assert.match(html, /infohint/);          // 数据说明 ⓘ 提示
  assert.match(html, /点首页“退出程序”.*“程序已退出”后重新打开/); // 明确结束旧实例后再取最新
  assert.doesNotMatch(html, /refreshPlayer/); // “刷新缓存”交互已移除
  assert.match(html, /个人表现雷达图/);
  assert.match(html, /选择维度 5\/7/);
  assert.match(html, /缺少好人胜率、狼人胜率/);
});

test('个人资料队徽：按门派基础名精确匹配，单枚自动显示且选择入口留在资料卡外', () => {
  const withCrest = state({ model: { sect_cands: ['鱼乐会'], teams: ['鱼乐会（鲁）'] } });
  const candidates = profileCrestCandidates(withCrest.model);
  assert.deepEqual(candidates.map(theme => theme.id), ['yulehui']);
  assert.equal(resolveProfileCrest(candidates)?.id, 'yulehui');
  const html = renderDetailHTML(withCrest);
  assert.match(html, /class="profile-crest"/);
  assert.match(html, /assets\/yulehui-crest\.webp/);
  assert.ok(html.indexOf('profile-crest-control') < html.indexOf('class="pcard"'));
  assert.match(html, /资料队徽/);
  assert.match(styles, /\.phead\.has-profile-crest\{[^}]*grid-template-columns:170px minmax\(0,1fr\) minmax\(138px,170px\) clamp\(26px,4vw,58px\)/);
  assert.match(styles, /@media\(max-width:520px\)\{[^}]*\.detail-scope-line\{flex-wrap:wrap\}/);
});

test('个人资料队徽：多枚首次不擅自显示，可选择其中一枚或明确不显示', () => {
  const multi = state({ model: { sect_cands: ['鱼乐会', '金风细雨楼'], teams: ['鱼乐会（鲁）', '金风细雨楼（沪）'] } });
  const candidates = profileCrestCandidates(multi.model);
  assert.deepEqual(candidates.map(theme => theme.id), ['yulehui', 'jinfeng-xiyulou']);
  assert.equal(resolveProfileCrest(candidates), null);
  const undecided = renderDetailHTML(multi);
  assert.match(undecided, /选择队徽 · 2/);
  assert.match(undecided, /needs-choice/);
  assert.doesNotMatch(undecided, /class="profile-crest"/);

  const selected = renderDetailHTML({ ...multi, profileCrestChoice: 'jinfeng-xiyulou' });
  assert.match(selected, /assets\/jinfeng-xiyulou-crest\.webp/);
  assert.match(selected, />金风细雨楼<\/button>/);

  const hidden = renderDetailHTML({ ...multi, profileCrestChoice: 'none' });
  assert.match(hidden, />不显示<\/button>/);
  assert.doesNotMatch(hidden, /class="profile-crest"/);
});

test('个人资料队徽：选择后聚焦重渲染生成的新入口', () => {
  const previousDocument = globalThis.document;
  const previousStorage = globalThis.localStorage;
  const detail = { innerHTML: '' };
  const control = { focused: false, focus() { this.focused = true; } };
  const pop = {
    style: {}, inert: false,
    setAttribute() {},
  };
  const wrap = { inert: false };
  globalThis.document = {
    body: { classList: { toggle() {} } },
    querySelector: selector => ({ '#detail': detail, '#pop': pop, '.profile-crest-control': control, '.wrap': wrap }[selector] || null),
  };
  globalThis.localStorage = { setItem() {} };
  setView('detail');
  __setV(state({ model: { sect_cands: ['鱼乐会', '金风细雨楼'] } }));
  try {
    selectProfileCrest('jinfeng-xiyulou');
    assert.equal(control.focused, true);
    assert.match(detail.innerHTML, />金风细雨楼<\/button>/);
  } finally {
    setView('search');
    __setV(null);
    globalThis.document = previousDocument;
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
  }
});

test('个人资料队徽：不做包含关系匹配，具体门派作用域优先于其他候选', () => {
  assert.deepEqual(profileCrestCandidates(model({ sect_cands: ['鱼乐会二队'] })), []);
  const scoped = profileCrestCandidates(model({ sect: '金风细雨楼', sect_cands: ['鱼乐会', '金风细雨楼'] }));
  assert.deepEqual(scoped.map(theme => theme.id), ['jinfeng-xiyulou']);
});

test('个人资料队徽：逐场加载中可打开候选、保存选择并在加载后继续显示', () => {
  const previousDocument = globalThis.document;
  const previousStorage = globalThis.localStorage;
  const stored = new Map();
  const detail = { innerHTML: '' };
  const pop = { innerHTML: '', style: {}, setAttribute() {} };
  const st = state({ gamesLoading: true, profileTeams: ['鱼乐会', '金风细雨楼'], model: { sect_cands: [], teams: [], games: [] } });
  globalThis.document = {
    body: { classList: { toggle() {} } },
    querySelector: selector => ({ '#detail': detail, '#pop': pop }[selector] || null),
  };
  globalThis.localStorage = { setItem: (key, value) => stored.set(key, value) };
  setView('detail');
  __setV(st);
  try {
    assert.match(renderDetailHTML(st), /选择队徽 · 2/);
    showProfileCrestPicker();
    assert.equal(pop.style.display, 'flex');
    assert.match(pop.innerHTML, /selectProfileCrest\('yulehui'\)/);
    assert.match(pop.innerHTML, /selectProfileCrest\('jinfeng-xiyulou'\)/);
    selectProfileCrest('jinfeng-xiyulou');
    assert.equal(st.profileCrestChoice, 'jinfeng-xiyulou');
    assert.equal(stored.get('profile-crest:7'), 'jinfeng-xiyulou');
    assert.equal(pop.style.display, 'none');
    assert.match(detail.innerHTML, />金风细雨楼<\/button>/);
    st.gamesLoading = false;
    st.model.teams = ['鱼乐会（鲁）', '金风细雨楼（沪）'];
    st.model.sect_cands = ['鱼乐会', '金风细雨楼'];
    assert.match(renderDetailHTML(st), />金风细雨楼<\/button>/);
  } finally {
    closePop();
    __setV(null);
    setView('search');
    globalThis.document = previousDocument;
    globalThis.localStorage = previousStorage;
  }
});

test('个人门派标签：具体门派只展示该门派记录，切换范围不累计历史标签', () => {
  const st = state({ profileTeams: ['鱼乐会', '金风细雨楼'], model: { teams: ['旧门派（鲁）'] } });
  const chips = () => [...renderDetailHTML(st).matchAll(/<span class="tm">([^<]+)<\/span>/g)].map(match => match[1]);
  assert.deepEqual(chips(), ['鱼乐会', '金风细雨楼', '旧门派（鲁）']);
  st.model.sect = '鱼乐会';
  st.model.teams = ['鱼乐会（鲁）', '鱼乐会（沪）'];
  assert.deepEqual(chips(), ['鱼乐会（鲁）', '鱼乐会（沪）']);
  st.model.sect = '';
  st.model.teams = ['新门派（沪）'];
  assert.deepEqual(chips(), ['鱼乐会', '金风细雨楼', '新门派（沪）']);
  st.model.teams = [];
  st.model.games_error = 'Games unavailable';
  assert.deepEqual(chips(), ['鱼乐会', '金风细雨楼']);
});

test('renderDetailHTML：角色或版型数据为空时显示明确空状态', () => {
  const empty = { games: [], roles: [], editions: [] };
  assert.match(renderDetailHTML(state({ detailTab: 'roles', model: empty })), /暂无身份表现/);
  assert.match(renderDetailHTML(state({ detailTab: 'editions', model: empty })), /暂无版型表现/);
});

test('详情加载提示：首次查询分阶段提示用户耐心等待', () => {
  const first = detailLoadingHTML(0, true);
  assert.match(first, /首次查询/);
  assert.match(first, /耐心等待/);
  assert.match(detailLoadingHTML(1, true), /正在正常运行/);
  assert.match(detailLoadingHTML(2, true), /自动显示结果/);
  assert.match(detailLoadingHTML(0, false), /正在处理数据/);
  assert.match(renderDetailHTML({ model: null }), /首次查询/);
});

test('renderDetailHTML：统计失败（无门派）→ 统计区错误，不影响战绩区', () => {
  const html = renderDetailHTML(state({ model: { stats_error: '统计炸了', comprehensive: [] } }));
  assert.match(html, /获取失败：统计炸了/);
  assert.match(html, /雷达图暂时无法读取/);
  assert.match(html, /请稍后重新查询该选手/);
  assert.doesNotMatch(html, /当前范围缺少综合胜率/);
  assert.match(renderDetailHTML(state({ detailTab: 'games', model: { stats_error: '统计炸了', comprehensive: [] } })), /共 1 场/);
});

test('renderDetailHTML：门派范围仍在整理时雷达图显示加载状态', () => {
  const html = renderDetailHTML(state({ gamesLoading: true, model: { sect: '门派A', comprehensive: [], good: [], wolf: [] } }));
  assert.match(html, /正在读取雷达图数据/);
  assert.match(html, /关键指标返回后会自动显示/);
  assert.doesNotMatch(html, /当前范围缺少综合胜率/);
});

test('renderDetailHTML：战绩失败 → 战绩区错误、队伍名占位；截断提示', () => {
  const errHtml = renderDetailHTML(state({ detailTab: 'games', model: { games_error: '战绩炸了', games: [] } }));
  assert.match(errHtml, /获取失败：战绩炸了/);
  const truncHtml = renderDetailHTML(state({ detailTab: 'games', model: { games_trunc: true } }));
  assert.match(truncHtml, /当前仅展示部分数据/);
});

test('renderDetailHTML：两阶段头部——gamesLoading 且首页未到 → 逐场纯占位、角色/队伍“加载中”', () => {
  const html = renderDetailHTML(state({ detailTab: 'games', gamesLoading: true, model: { games: [], roles: [], teams: [] } }));
  assert.match(html, /正在加载逐场战绩/);        // 无首页行：逐场区纯占位
  assert.doesNotMatch(html, /无战绩/);            // 不再误显示“无战绩”
  assert.match(html, /加载中…/);                  // 角色/队伍占位
  assert.match(html, /张三/);                     // 头部（来自 stats）照常渲染
  assert.match(renderDetailHTML(state({ gamesLoading: true, model: { games: [], roles: [], teams: [] } })), /🎯 综合/); // 概览已可用
});

test('renderDetailHTML：详细数据加载前保留资料门派，完成后按顺序补齐', () => {
  const loading = renderDetailHTML(state({ profileTeams: ['鱼乐会'], gamesLoading: true, model: { games: [], roles: [], teams: [], sect_cands: [] } }));
  assert.match(loading, />鱼乐会<\/span>/);
  assert.doesNotMatch(loading, /<div class="teams"><span class="none">加载中…<\/span>/);
  assert.match(loading, /assets\/yulehui-crest\.webp/);
  const complete = renderDetailHTML(state({ profileTeams: ['资料门派'], model: { teams: ['资料门派', '历史门派'] } }));
  assert.ok(complete.indexOf('>资料门派</span>') < complete.indexOf('>历史门派</span>'));
});

test('renderDetailHTML：首屏预览——gamesLoading 且已有首页行 → 渲染表格但禁用筛选/排序、显示总场数', () => {
  const html = renderDetailHTML(state({ detailTab: 'games', gamesLoading: true, model: { games_total: 9999, games_total_known: true, roles: [] } }));
  assert.match(html, /openGame\(11\)/);          // 首屏行已渲染（model 默认含一行 game_id=11）
  assert.match(html, /共 9999 场/);               // 总数确定时显示“共 N 场”
  assert.match(html, /正在加载完整战绩/);
  assert.doesNotMatch(html, /setGF/);             // 筛选栏禁用（不渲染 qfbar）
  assert.doesNotMatch(html, /sortGames/);         // 排序表头禁用
  assert.doesNotMatch(html, /正在加载逐场战绩/);   // 有首页行时不再显示纯占位
  const roles = renderDetailHTML(state({ detailTab: 'roles', gamesLoading: true, model: { games_total: 9999, games_total_known: true, roles: [] } }));
  assert.match(roles, /🎭 身份表现/);
  assert.match(roles, /加载中…/);
});

test('renderDetailHTML：首屏预览总数未知时只说明已显示数量', () => {
  const html = renderDetailHTML(state({ detailTab: 'games', gamesLoading: true, model: { games_total: 1, games_total_known: false, roles: [] } }));
  assert.match(html, /已显示 1 场/);
  assert.match(html, /正在加载完整战绩/);
  assert.doesNotMatch(html, /共 1 场/);   // 未知时不写“共 N 场”
  assert.doesNotMatch(html, /共 -1 场/);
});

test('renderDetailHTML：gamesLoading=false（逐场已到）→ 正常渲染表格，无加载占位', () => {
  const html = renderDetailHTML(state({ detailTab: 'games', gamesLoading: false }));
  assert.match(html, /openGame\(11\)/);
  assert.doesNotMatch(html, /正在加载逐场战绩/);
});

test('renderDetailHTML：逐场出错优先于 gamesLoading（不显示加载占位）', () => {
  const html = renderDetailHTML(state({ detailTab: 'games', gamesLoading: true, model: { games_error: '炸了', games: [] } }));
  assert.match(html, /获取失败：炸了/);
  assert.doesNotMatch(html, /正在加载逐场战绩/);
});

test('renderDetailHTML：客户端快捷筛选——只看胜场时按 result 过滤逐场（不发请求）', () => {
  const two = {
    games: [
      { game_id: 11, play_date: '2024-01-02', rpt_name: '平民', total_point: 5, win: 1 },
      { game_id: 12, play_date: '2024-01-01', rpt_name: '狼', total_point: 3, win: 0 },
    ],
  };
  assert.match(renderDetailHTML(state({ detailTab: 'games', model: two })), /共 2 场/);
  assert.match(renderDetailHTML(state({ detailTab: 'games', model: two, gf: { result: 'w' } })), /共 1 场/);   // 只剩胜场
  assert.match(renderDetailHTML(state({ detailTab: 'games', model: two, gf: { camp: 'wolf' } })), /共 1 场/);  // isGoodCamp 客户端分阵营
});

test('renderGameHTML：按人视图—座位表、胜负、我方高亮、技能动作、页签', () => {
  const g = {
    play_date: '2024-01-01', round: 2, season_id: 6, victory_camp: 1, mvp_seat: 3, svp_seat: 5, referee_name: '李四', day: 1,
    form2: { rows: [
      { seat: 1, player_id: 7, player_name: '张三', sect_name: '门派A', rpt_name: '狼', vote_day1: '2', skills: [] },
      { seat: 2, player_id: 8, player_name: '王五', rpt_name: '预言家', skills: [{ day: 1, name: '预言家', target_seats: [3] }] },
    ] },
  };
  const html = renderGameHTML(g, 7);
  assert.match(html, /好人胜/);
  assert.match(html, /张三/); assert.match(html, /王五/);
  assert.match(html, /class="me"/);
  assert.match(html, /D1 验→3/);
  assert.match(html, /setGameMode\('day'\)/);
  assert.match(html, /按人/); assert.match(html, /按天/);
  assert.match(html, /seat-wide/); assert.match(html, /seat-narrow/);
});

test('renderGameHTML：按天视图—顺序 技能→警徽→投票，顶盾、警徽投票', () => {
  const g = {
    play_date: '2024-01-01', day: 2, victory_camp: 2,
    form2: { rows: [
      { seat: 1, player_id: 7, player_name: '张三', rpt_name: '预言家', vote_jinhui: '3', vote_day1: '2', vote_day2: '0', day_of_jinhui: 1, skills: [{ day: 1, name: '预言家', target_seats: [4] }] },
      { seat: 5, player_id: 8, player_name: '李四', rpt_name: '怪盗狼王', vote_day1: '1', skills: [{ day: 2, name: '怪盗', target_seats: [5] }] },
    ] },
  };
  const html = renderGameHTML(g, 7, 'day');
  assert.match(html, /警徽竞选/);
  assert.match(html, /第 1 天/); assert.match(html, /第 2 天/);
  assert.match(html, /1号张三/);           // 技能行动方：座号+名
  assert.match(html, /验/); assert.match(html, /4号/);   // 目标（座4不在场→只显示“4号”）
  assert.match(html, /李四/); assert.match(html, /顶盾/); // 怪盗狼王对自己=顶盾
  assert.match(html, /当选/);              // day_of_jinhui=1 → 警徽当选
  // 顺序：技能块在警徽块之前，警徽块在投票块之前
  assert.ok(html.indexOf('技能') < html.indexOf('警徽竞选'));
  assert.ok(html.indexOf('警徽竞选') < html.indexOf('投票'));
  assert.doesNotMatch(html, /<table class="gt"/);
});

test('renderGameHTML：按天—狼刀合并成一条 + 目标带角色（不再列狼队成员）', () => {
  const g = {
    play_date: 'x', day: 1, victory_camp: 2,
    form2: { rows: [
      { seat: 1, player_id: 1, player_name: '张三', rpt_name: '狼', skills: [{ day: 1, name: '狼刀', target_seats: [3] }] },
      { seat: 4, player_id: 4, player_name: '赵六', rpt_name: '狼王', skills: [{ day: 1, name: '狼刀', target_seats: [3] }] },
      { seat: 3, player_id: 3, player_name: '李四', rpt_name: '平民', skills: [] },
    ] },
  };
  const html = renderGameHTML(g, 9, 'day');
  assert.match(html, /狼刀/);
  assert.match(html, /3号 李四/);          // 目标解析出座位+名
  assert.equal((html.match(/狼刀/g) || []).length, 1);   // 两个狼合并为一条
  assert.doesNotMatch(html, /狼队/);       // 无 analysis 花名册时不再显示狼队成员
  assert.doesNotMatch(html, /1号张三/);    // 发动的狼队成员不再列出
});

test('dayVotes：按天投票按被投目标归并，每目标一行、弃票置末，号码带名字身份', () => {
  const rows = [1, 2, 3, 4, 5, 6, 7].map(n => ({ seat: n, player_id: n, player_name: 'P' + n, rpt_name: n === 2 ? '狼' : '平民', skills: [] }));
  const g = {
    play_date: 'x', day: 1, victory_camp: 2, form2: { rows },
    analysis: { votes: { '1': [
      { seat: 1, target: 2 }, { seat: 2, target: 3 }, { seat: 3, target: 2 },
      { seat: 4, target: 3 }, { seat: 5, target: 4 }, { seat: 6, abstain: true }, { seat: 7, abstain: true },
    ] } },
  };
  const html = renderGameHTML(g, 0, 'day');
  const vrows = [...html.matchAll(/<div class="vote-row">([\s\S]*?)<\/div>/g)].map(m => m[1]);
  assert.equal(vrows.length, 4);                       // 目标 2 / 3 / 4 + 弃票 共 4 行
  const row2 = vrows.find(r => /→[\s\S]*2号/.test(r));
  assert.ok(row2 && /1号/.test(row2) && /3号/.test(row2));   // 1,3 → 2
  assert.match(row2, /P2·狼/);                          // 被投号码带名字·身份
  assert.match(vrows[vrows.length - 1], /弃票/);         // 弃票行置末
  assert.ok(/6号/.test(vrows[3]) && /7号/.test(vrows[3])); // 6,7 → 弃票
});

test('renderGameHTML：analysis—花名册/出局时间线/放逐制表/投票着色/背锅/扣分/出局标记', () => {
  const g = {
    play_date: 'x', day: 2, victory_camp: 2, mvp_seat: 2, svp_seat: 3, referee_name: '王',
    form2: {
      rows: [
        { seat: 1, player_id: 7, player_name: '张三', rpt_name: '狼', skills: [] },
        { seat: 2, player_id: 8, player_name: '李四', rpt_name: '预言家', skills: [] },
        { seat: 3, player_id: 9, player_name: '王五', rpt_name: '平民', skills: [] },
      ],
      points: [{ day: 1, name: '发言违规', seat: 3, point: -1 }],
    },
    analysis: {
      roster: { wolf: [1], gods: [2], civ: [3], special_role: '', special_seat: 0 },
      badge: { '1': 2 },
      votes: { '1': [{ seat: 2, target: 1, weight: 1.5, abstain: false, badge: true }, { seat: 3, target: 2, weight: 1, abstain: false, badge: false }] },
      exile: { '1': { seat: 1, peaceful: false, tally: [{ seat: 1, votes: 1.5 }, { seat: 2, votes: 1 }] } },
      deaths: [{ seat: 1, day: 1, phase: 'day', cause: 'exile', doubt: false }, { seat: 2, day: 2, phase: 'night', cause: 'knife', doubt: false }],
      alive_final: [3],
    },
  };
  const meRow = { game_id: 1, seat: 2, bgx: 1 };
  const day = renderGameHTML(g, 8, 'day', meRow);
  assert.match(day, /狼队/);                       // 花名册
  assert.match(day, /出局顺序/);                    // 时间线
  assert.match(day, /放逐/); assert.match(day, /狼刀/);  // 中文死因
  assert.match(day, /vhit/); assert.match(day, /vmiss/); // 投狼绿/投好人红
  assert.match(day, /★/);                          // 警长 1.5 票
  assert.match(day, /违规扣分/); assert.match(day, /发言违规/);
  assert.match(day, /背锅/);                        // meRow.bgx → 背锅当前选手
  assert.match(day, /MVP 2号/); assert.match(day, /尽力 3号/);
  const seat = renderGameHTML(g, 8, 'seat', meRow);
  assert.match(seat, /out-tag/); assert.match(seat, /出局·第1天/);   // 座位视图出局标记
});

// —— api.js（薄壳）：只与本地 /api/* 交互，无令牌、无官方地址；401 弹横幅（刷新由 Go 侧完成）——
function installDom() {
  const els = {};
  globalThis.document = { querySelector: sel => els[sel] || (els[sel] = { innerHTML: '', textContent: '', dataset: {} }) };
  return els;
}
const resp = ({ ok = true, status = 200, body = '' }) => ({ ok, status, text: async () => body, json: async () => JSON.parse(body) });

test('searchPlayers / detail / game：拼本地端点 URL 并返回解析后的 JSON', async () => {
  let seen;
  globalThis.fetch = async url => { seen = url; return resp({ body: JSON.stringify({ ok: 1 }) }); };
  await searchPlayers('张三');
  assert.match(seen, /^\/api\/players\/search\?name=/);
  await detail('id=7&zone=ALL&season=6');
  assert.equal(seen, '/api/players/detail?id=7&zone=ALL&season=6');
  await game(43330);
  assert.equal(seen, '/api/games?id=43330');
});

test('赛事 API：目录、排名、按需指标和门派成员只走本地端点', async () => {
  const seen = [];
  globalThis.fetch = async url => { seen.push(url); return resp({ body: '{}' }); };
  await eventCatalog();
  await eventSeasons('SD');
  await eventAvailability('29', 'SD');
  await eventRankings('29', '4', 'SD');
  await eventRankAggregate('29', '4', 'SD');
  await eventTeam(13, '29', '4', 'SD');
  await drawTool('29', '5', 'SD');
  await groupDrawTool('30', '3', 'BJ');
  assert.equal(seen[0], '/api/events/catalog');
  assert.equal(seen[1], '/api/events/seasons?zone=SD');
  assert.equal(seen[2], '/api/events/availability?season=29&zone=SD');
  assert.match(seen[3], /^\/api\/events\/rankings\?/);
  assert.match(seen[3], /season=29/);
  assert.match(seen[3], /type=4/);
  assert.match(seen[3], /zone=SD/);
  assert.match(seen[4], /^\/api\/events\/metrics\?/);
  assert.match(seen[4], /season=29/);
  assert.match(seen[5], /^\/api\/events\/team\?/);
  assert.match(seen[5], /id=13/);
  assert.match(seen[5], /season=29/);
  assert.match(seen[5], /type=4/);
  assert.match(seen[5], /zone=SD/);
  assert.doesNotMatch(seen[5], /page=|size=/);
  assert.match(seen[6], /^\/api\/events\/draw-tool\?/);
  assert.match(seen[6], /season=29/);
  assert.match(seen[6], /type=5/);
  assert.match(seen[6], /zone=SD/);
  assert.match(seen[7], /^\/api\/events\/group-draw\?/);
  assert.match(seen[7], /season=30/);
  assert.match(seen[7], /type=3/);
  assert.match(seen[7], /zone=BJ/);
});

test('分组模拟：全部上榜门派均分到四组，抽取始终使用下一名种子', () => {
  const teams = Array.from({ length: 25 }, (_, index) => ({ sect_id: index + 1, rank: index + 1 }));
  const assignments = [];
  let next;
  while ((next = drawNextAssignment(teams, assignments, () => 0))) assignments.push(next);
  assert.deepEqual(groupCapacities(25), [7, 6, 6, 6]);
  assert.deepEqual(groupCapacities(18), [5, 5, 4, 4]);
  assert.deepEqual(assignments.slice(0, 8), [
    { sect_id: 1, group: 'A' }, { sect_id: 2, group: 'A' }, { sect_id: 3, group: 'A' },
    { sect_id: 4, group: 'A' }, { sect_id: 5, group: 'A' }, { sect_id: 6, group: 'A' },
    { sect_id: 7, group: 'A' }, { sect_id: 8, group: 'B' },
  ]);
  assert.deepEqual(['A', 'B', 'C', 'D'].map(group => assignments.filter(item => item.group === group).length), [7, 6, 6, 6]);
});

test('分组模拟：比赛类型只保留踢馆赛和常规赛', () => {
  const types = usableGroupTypes({ season_types: [
    { value: '2', label: '踢馆赛' }, { value: '3', label: '常规赛' }, { value: '4', label: '季后赛' }, { value: '5', label: '总决赛' },
  ] });
  assert.deepEqual(types.map(item => item.value), ['2', '3']);
});

test('分组模拟：比赛类型读取失败后可以直接重试', async () => {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  const body = { innerHTML: '' };
  const season = { value: '30' };
  const seen = [];
  try {
    globalThis.document = { querySelector: selector => ({ '#group-tool-body': body, '#group-season': season }[selector] || null) };
    globalThis.window = { scrollTo() {} };
    globalThis.fetch = async url => {
      seen.push(url);
      return resp({ body: JSON.stringify({ season_types: [{ value: '3', label: '常规赛' }] }) });
    };
    __setGroupState({
      catalog: { zones: [{ value: 'SH', label: '上海赛区' }] },
      seasons: [{ value: '30', label: 'S30' }], types: [], season: '30', type: '', zone: 'SH',
      data: null, assignments: [], loading: false, optionsLoading: false, error: '读取失败', abort: null, gen: 20,
    });
    await retryGroupTool();
    assert.deepEqual(seen, ['/api/events/season-types?season=30&zone=SH']);
    assert.match(body.innerHTML, />常规赛<\/option>/);
    assert.doesNotMatch(body.innerHTML, /获取失败/);
  } finally {
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
    globalThis.fetch = previousFetch;
  }
});

test('分组模拟：实时显示组内排名和下一队', () => {
  const state = {
    data: { teams: [
      { sect_id: 1, sect_name: '甲队', rank: 1, total_point: 30, mvp: 2, svp: 1, bgx: 0 },
      { sect_id: 2, sect_name: '乙队', rank: 2, total_point: 28, mvp: 1, svp: 0, bgx: 1 },
    ] },
    assignments: [{ sect_id: 1, group: 'C' }], lastSectID: 1,
  };
  const html = renderGroupToolHTML(state);
  assert.match(html, /下一队：乙队/);
  assert.match(html, /C 组/);
  assert.match(html, /总排名 1/);
  assert.match(styles, /\.group-card\{[^}]*min-height:360px;[^}]*border:2px/);
  assert.match(styles, /\.group-card li b\{font-size:17px\}/);
});

const drawData = () => ({
  simulation_ready: true, zone: 'SH', season: '28', season_type: '5',
  teams: [
    { sect_id: 1, sect_name: '甲队', constant_adjustment: -1 },
    { sect_id: 2, sect_name: '乙队', constant_adjustment: 0 },
    { sect_id: 3, sect_name: '丙队', constant_adjustment: 0 },
  ],
  games: [
    { index: 1, complete: true, scores: [5, 4, 4] },
    { index: 2, complete: true, scores: [-1.5, 3.5, 4] },
    { index: 3, complete: false, scores: [null, null, null] },
  ],
});

test('抽局模拟：整局最终分被移除，带入积分和赛外违规扣分保留，并支持负分与半分预测', () => {
  const projections = { 3: { 1: 2.5, 2: -0.5, 3: 1 } };
  const rows = calculateScenario(drawData(), projections, 1);
  assert.deepEqual(rows.map(row => [row.name, row.total, row.rank]), [
    ['甲队', 6.5, 1], ['丙队', 5, 2], ['乙队', 3.5, 3],
  ]);
});

test('抽局模拟：同分使用并列名次，下一名按竞赛排名跳位', () => {
  const rows = rankWithTies([
    { name: '甲', total: 10 }, { name: '乙', total: 10 }, { name: '丙', total: 8 }, { name: '丁', total: null },
  ]);
  assert.deepEqual(rows.map(row => [row.name, row.rank]), [['甲', 1], ['乙', 1], ['丙', 3], ['丁', null]]);
});

test('抽局预测：按赛事范围隔离存储，官方新完成局会覆盖旧预测', () => {
  assert.equal(projectionStorageKey('SH', '28', '5'), 'huashan-draw-projections:SH:28:5');
  const data = drawData();
  const saved = { 2: { 1: 99 }, 3: { 1: 2.5, 2: -0.5 }, 99: { 1: 7 } };
  assert.deepEqual(mergeProjections(data, saved), { 3: { 1: 2.5, 2: -0.5 } });
});

test('抽局预测：输入时即时更新总分与排名顺序，不替换当前输入框', () => {
  const previousDocument = globalThis.document;
  const previousStorage = globalThis.localStorage;
  try {
    const data = drawData();
    const totalCells = data.teams.map(team => ({ dataset: { drawTotal: String(team.sect_id) }, textContent: '' }));
    const rankCells = data.teams.map(team => ({ dataset: { drawRank: String(team.sect_id) }, textContent: '', classList: { toggle() {} } }));
    const matrixOrder = [], mobileOrder = [], prompt = { hidden: false };
    const rankingContainer = order => ({
      querySelector(selector) { return { id: selector.match(/"(\d+)"/)[1] }; },
      appendChild(row) { order.push(row.id); },
    });
    const matrix = rankingContainer(matrixOrder), mobile = rankingContainer(mobileOrder);
    const sourceInput = { value: '10' }, mirrorInput = { value: '2.5' };
    globalThis.localStorage = { setItem() {}, getItem() { return null; } };
    globalThis.document = {
      querySelector(selector) {
        return { '#draw-matrix-body': matrix, '#draw-mobile-ranking': mobile, '#draw-prompt': prompt }[selector] || null;
      },
      querySelectorAll(selector) {
        if (selector === '[data-draw-total]') return totalCells;
        if (selector === '[data-draw-rank]') return rankCells;
        if (selector.startsWith('.draw-projection-input')) return [sourceInput, mirrorInput];
        return [];
      },
    };
    __setDrawState({ data, removed: 1, projections: { 3: { 1: 2.5, 2: -0.5, 3: 1 } } });
    setDrawProjection(3, 1, '10', sourceInput);
    assert.equal(totalCells[0].textContent, '14');
    assert.equal(rankCells[0].textContent, 1);
    assert.deepEqual(matrixOrder, ['1', '3', '2']);
    assert.deepEqual(mobileOrder, ['1', '3', '2']);
    assert.equal(prompt.hidden, true);
    assert.equal(sourceInput.value, '10');
    assert.equal(mirrorInput.value, '10');
  } finally {
    globalThis.document = previousDocument;
    globalThis.localStorage = previousStorage;
  }
});

test('抽局选择：横向滚动后选择后段比赛仍停留在当前位置', () => {
  const previousDocument = globalThis.document;
  try {
    let painted = false;
    const before = { scrollLeft: 640 };
    const after = { scrollLeft: 0 };
    const body = {};
    Object.defineProperty(body, 'innerHTML', {
      get() { return this._html || ''; },
      set(html) { this._html = html; painted = true; },
    });
    globalThis.document = {
      querySelector(selector) {
        if (selector === '#draw-tool-body') return body;
        if (selector === '.draw-matrix-wrap') return painted ? after : before;
        return null;
      },
    };
    __setDrawState({ data: drawData(), projections: {}, removed: 0, editGame: 0, error: '', optionsLoading: false });
    selectDrawRemoved(2);
    assert.equal(after.scrollLeft, 640);
  } finally {
    globalThis.document = previousDocument;
  }
});

test('抽局筛选：切换赛区立即清空旧选项，前端不发起最新赛季计算', async () => {
  const previousDocument = globalThis.document;
  const previousFetch = globalThis.fetch;
  const body = { innerHTML: '' };
  const elements = {
    '#draw-zone': { value: 'BJ' }, '#draw-season': { value: '29' }, '#draw-type': { value: '4' }, '#draw-tool-body': body,
  };
  let resolveSeasons;
  const seen = [];
  globalThis.document = { querySelector: selector => elements[selector] || null };
  globalThis.fetch = async url => {
    seen.push(url);
    if (url === '/api/events/seasons?zone=BJ') return new Promise(resolve => { resolveSeasons = resolve; });
    if (url === '/api/events/season-types?season=31&zone=BJ') return resp({ body: JSON.stringify({ season_types: [{ value: '5', label: '总决赛' }] }) });
    throw new Error('unexpected URL: ' + url);
  };
  try {
    __setDrawState({
      catalog: { zones: [{ value: 'SH', label: '上海赛区' }, { value: 'BJ', label: '北京赛区' }] },
      zone: 'SH', seasons: [{ value: '29', label: 'S29' }], season: '29', types: [{ value: '4', label: '季后赛' }], type: '4',
      data: { simulation_ready: true }, loading: false, optionsLoading: false, error: '', abort: null, metaAbort: null, gen: 0,
    });
    const switching = syncDrawFilters('zone');
    assert.doesNotMatch(body.innerHTML, />S29</);
    assert.doesNotMatch(body.innerHTML, />季后赛</);
    assert.match(body.innerHTML, /id="draw-season"[^>]* disabled/);
    assert.match(body.innerHTML, /正在读取可用赛季/);

    resolveSeasons(resp({ body: JSON.stringify({ seasons: [{ value: '31', label: 'S31' }, { value: '30', label: 'S30' }] }) }));
    await switching;
    assert.deepEqual(seen, [
      '/api/events/seasons?zone=BJ',
      '/api/events/season-types?season=31&zone=BJ',
    ]);
    assert.match(body.innerHTML, />S31</);
    assert.match(body.innerHTML, />总决赛</);
    assert.match(body.innerHTML, /选择赛事后开始模拟/);
    assert.match(body.innerHTML, /本次运行会复用首次读取的赛事数据/);
    assert.match(body.innerHTML, /如需查看官方最新结果，请点首页“退出程序”/);
  } finally {
    globalThis.document = previousDocument;
    globalThis.fetch = previousFetch;
  }
});

test('赛事数据展示：筛选、排名分页和作用域成员名单完整呈现', () => {
  const catalog = {
    seasons: [{ value: '29', label: 'S29' }],
    season_types: [{ value: '4', label: '季后赛' }],
    zones: [{ value: 'SD', label: '山东赛区' }],
    editions: [{ value: '18', label: '侦探怪盗守卫' }],
    roles: [{ value: '2', label: '狼', camp: 2 }],
  };
  const rankings = { metric_mode: 'game', metrics_available: true, players_available: true, items: [{ rank: 1, sect_id: 13, sect_name: '鱼乐会', total_point: 99.5, games: 5, avg: 19.9, mvp: 2, svp: 1, bgx: 0 }] };
  const players = [{ rank: 1, player_id: 109, player_name: 'Will', games: 5, total_point: 24, avg: 4.8, mvp: 2, svp: 1, bgx: 0 }];
  const html = renderEventsHTML({ catalog, season: '29', type: '4', zone: 'SD', metricsReady: true, rankings, players });
  assert.match(html, /山东赛区 · S29 · 季后赛/);
  assert.match(html, /本次运行会复用首次读取的赛事数据/);
  assert.match(html, /如需查看官方最新结果，请点首页“退出程序”/);
  assert.match(html, /鱼乐会/);
  assert.match(html, /点击门派查看出场成员/);
  assert.match(html, /setEventRankSort\('total_point'\)/);
  assert.match(html, /setEventRankSort\('mvp'\)/);
  assert.match(html, /setEventRankSort\('svp'\)/);
  assert.match(html, /setEventRankSort\('bgx'\)/);
  assert.match(html, /门派排名/);
  assert.match(html, /门派均分/);
  assert.match(html, /选手排名/);
  assert.match(html, /id="event-tab-sects"[^>]*aria-controls="event-panel-sects"/);
  assert.match(html, /id="event-panel-sects"[^>]*role="tabpanel"[^>]*aria-labelledby="event-tab-sects"/);
  const averages = renderEventsHTML({ catalog, season: '29', type: '4', zone: 'SD', metricsReady: true, eventTab: 'averages', rankings, players });
  assert.match(averages, /setEventRankSort\('games'\)/);
  assert.match(averages, /setEventRankSort\('avg'\)/);
  assert.match(averages, /场次/);
  assert.match(averages, /场均分/);
  assert.match(averages, /id="event-tab-averages"[^>]*aria-controls="event-panel-averages"/);
  assert.match(averages, /id="event-panel-averages"[^>]*role="tabpanel"[^>]*aria-labelledby="event-tab-averages"/);
  assert.doesNotMatch(html, /局数|局均分/);
  assert.match(averages, /19\.9/);
  const playerRanking = renderEventsHTML({ catalog, season: '29', type: '4', zone: 'SD', metricsReady: true, eventTab: 'players', rankings, players });
  assert.match(playerRanking, /setEventPlayerSort\('total_point'\)/);
  assert.match(playerRanking, /Will/);
  assert.match(playerRanking, /24/);
  assert.match(playerRanking, /id="event-tab-players"[^>]*aria-controls="event-panel-players"/);
  assert.match(playerRanking, /id="event-panel-players"[^>]*role="tabpanel"[^>]*aria-labelledby="event-tab-players"/);
  assert.doesNotMatch(html, /event-reference/);
  const team = renderEventTeamHTML({ id: 13, name: '鱼乐会', chief: '掌门甲', members: [{ value: 109, label: 'Will', matches: 3, total_point: 12.5, avg: 4.17, win: 67, mvp: 1, svp: 0, bgx: 0 }] }, { catalog, season: '29', type: '4', zone: 'SD', memberSort: { key: 'total_point', dir: -1 } });
  assert.match(team, /1 名出场成员/);
  assert.match(team, /Will/);
  assert.match(team, /3 场/);
  assert.match(team, /12\.5/);
  assert.match(team, /67%/);
  assert.match(team, /setEventMemberSort\('avg'\)/);
  assert.match(team, /openPlayer\(this\.dataset\.player\)/);
  assert.match(team, /山东赛区 · S29 · 季后赛/);
  assert.doesNotMatch(team, /mobile/);
  const sorted = renderEventTeamHTML({ id: 13, name: '鱼乐会', members: [
    { value: 1, label: '甲', matches: 9, total_point: 1, avg: 0.11, win: 11 },
    { value: 2, label: '乙', matches: 2, total_point: 20, avg: 10, win: 100 },
  ] }, { catalog, season: '29', type: '4', zone: 'SD', memberSort: { key: 'total_point', dir: -1 } });
  assert.ok(sorted.indexOf('乙') < sorted.indexOf('甲'), '成员应按所选统计列排序');
  assert.doesNotMatch(sorted, /setEventTeamPage|第 1 \/ 3 页/);
});

test('赛事排名：总分、天数和均分排序后重新计算当前名次', () => {
  const catalog = { seasons: [{ value: '29', label: 'S29' }], season_types: [], zones: [{ value: 'SD', label: '山东赛区' }] };
  const rankings = { metrics_available: true, items: [
    { rank: 1, sect_id: 1, sect_name: '总分队', total_point: 100, days: 2, avg: 50 },
    { rank: 2, sect_id: 2, sect_name: '天数队', total_point: 80, days: 9, avg: 8.89 },
  ] };
  const html = renderEventsHTML({ catalog, season: '29', type: '3', zone: 'SD', metricsReady: true, eventTab: 'averages', rankings: { ...rankings, metric_mode: 'day' }, rankSort: { key: 'days', dir: -1 } });
  assert.ok(html.indexOf('天数队') < html.indexOf('总分队'));
  assert.match(html, /event-rank">1<\/td><td><b>天数队/);
  assert.match(html, /日均分/);
});

test('赛事排名：MVP、尽力和背锅支持排序', () => {
  const catalog = { seasons: [{ value: '29', label: 'S29' }], season_types: [], zones: [{ value: 'SD', label: '山东赛区' }] };
  const items = [
    { sect_id: 1, sect_name: '甲队', total_point: 10, games: 3, avg: 3.33, mvp: 1, svp: 5, bgx: 0 },
    { sect_id: 2, sect_name: '乙队', total_point: 9, games: 3, avg: 3, mvp: 4, svp: 0, bgx: 3 },
  ];
  const render = key => renderEventsHTML({ catalog, availableSeasons: catalog.seasons, season: '29', type: '4', zone: 'SD', rankings: { metric_mode: 'game', items }, rankSort: { key, dir: -1 } });
  assert.ok(render('mvp').indexOf('乙队') < render('mvp').indexOf('甲队'));
  assert.ok(render('svp').indexOf('甲队') < render('svp').indexOf('乙队'));
  assert.ok(render('bgx').indexOf('乙队') < render('bgx').indexOf('甲队'));
});

test('赛事排名：有效天数下的零均分显示为 0', () => {
  const catalog = { seasons: [{ value: '29', label: 'S29' }], season_types: [], zones: [{ value: 'SD', label: '山东赛区' }] };
  const html = renderEventsHTML({ catalog, season: '29', type: '3', zone: 'SD', metricsReady: true, eventTab: 'averages', rankings: { metric_mode: 'day', metrics_available: true, items: [{ sect_id: 1, sect_name: '零分队', total_point: 0, days: 1 }] } });
  assert.match(html, /<td>1<\/td><td>0<\/td>/);
});

test('赛事排名：三个页签分开展示，计算完成前禁用门派均分和选手排名', () => {
  const catalog = { seasons: [{ value: '30', label: 'S30' }], season_types: [{ value: '2', label: '踢馆赛' }], zones: [{ value: 'SH', label: '上海赛区' }] };
  const base = { catalog, season: '30', type: '2', zone: 'SH', rankings: { metric_mode: 'day', metrics_available: true, players_available: true, items: [{ sect_id: 78, sect_name: '青城', total_point: 69, days: 5, avg: 13.8 }] }, players: [{ player_id: 109, player_name: 'Will', days: 2, games: 6, total_point: 26, avg: 13, mvp: 2, svp: 0, bgx: 0 }] };
  // 计算中：后两个页签禁用，并给出面向用户的完整提示。
  const loading = renderEventsHTML({ ...base, metricsLoading: true });
  assert.match(loading, /正在计算参赛数据，完成后即可查看。/);
  assert.match(loading, /aria-controls="event-panel-averages" disabled aria-disabled="true">门派均分/);
  assert.match(loading, /aria-controls="event-panel-players" disabled aria-disabled="true">选手排名/);
  assert.doesNotMatch(loading, /加载中…/);
  assert.doesNotMatch(loading, /13\.8/);
  const interrupted = renderEventsHTML({ ...base, metricsError: '参赛数据未算完，请重新查询；门派排名仍可正常查看。' });
  assert.match(interrupted, /参赛数据未算完，请重新查询/);
  // 算好后两个页签可点，但默认仍停留在门派排名。
  const ready = renderEventsHTML({ ...base, metricsReady: true });
  assert.match(ready, /onclick="setEventTab\('averages'\)">门派均分/);
  assert.match(ready, /onclick="setEventTab\('players'\)">选手排名/);
  assert.doesNotMatch(ready, /13\.8/);
  const averages = renderEventsHTML({ ...base, metricsReady: true, eventTab: 'averages' });
  assert.match(averages, /日均分/);
  assert.match(averages, /13\.8/);
  const players = renderEventsHTML({ ...base, metricsReady: true, eventTab: 'players' });
  assert.match(players, /Will/);
  assert.match(players, /26/);
});

test('全局常见问题：按项目逐项解释需要等待的字段、来源和缓存', () => {
  const previousDocument = globalThis.document;
  const about = { style: {}, innerHTML: '' };
  globalThis.document = { querySelector: selector => selector === '#about' ? about : null };
  try {
    showAbout();
    assert.equal(about.style.display, 'flex');
    assert.match(about.innerHTML, /<details id="help-faq" class="help-major faq-section">/);
    assert.equal((about.innerHTML.match(/class="faq-item"/g) || []).length, 38);
    assert.match(about.innerHTML, /身份卡为什么标注/);
    assert.match(about.innerHTML, /切换版型、赛区或赛季会清除分配吗/);
    assert.match(about.innerHTML, /再补上当前范围逐场战绩中的历史门派/);
    assert.match(about.innerHTML, /切换范围后会重新整理，不保留上一次范围补出的门派/);
    assert.match(about.innerHTML, /选择具体门派后，只显示该门派的记录/);
    assert.match(about.innerHTML, /原青崖夜和朱砂笺主题已移除/);
    assert.doesNotMatch(about.innerHTML, /<details[^>]*\sopen(?:\s|>)/);
    assert.match(about.innerHTML, /<h4>个人数据<\/h4>/);
    assert.match(about.innerHTML, /只显示与当前门派范围准确匹配的已有队徽/);
    assert.match(about.innerHTML, /综合区的总分、总场次、场均分、胜率、存活率、人命值、MVP、尽力、背锅、警长次数/);
    assert.match(about.innerHTML, /好人区的投狼率、站边数据和各身份技能命中率/);
    assert.match(about.innerHTML, /狼人区的摸狼率、悍跳、自刀和刀人数据/);
    assert.match(about.innerHTML, /雷达图使用当前范围已有的胜率、技能命中率和场均分/);
    assert.match(about.innerHTML, /好人场均分以 8\.5 分为图形上限，狼人场均分以 8 分为图形上限/);
    assert.match(about.innerHTML, /超过上限仍显示原始分数，图形按上限封顶/);
    assert.match(about.innerHTML, /多人雷达图只在“按阵营”下比较 2 至 4 名可见选手时显示/);
    assert.match(about.innerHTML, /总场次、总分、场均分、胜率、MVP、尽力和背锅/);
    assert.match(about.innerHTML, /版型表现中的场次、场均分、胜率、摸狼率、MVP、尽力和背锅/);
    assert.match(about.innerHTML, /<h4>赛事数据<\/h4>/);
    assert.match(about.innerHTML, /门派均分页签中的总分，也要和天数或场次、日均分或场均分一起等待/);
    assert.match(about.innerHTML, /门派成员的场次、总分、场均分、胜率、MVP、尽力和背锅/);
    assert.match(about.innerHTML, /切换到其他页面再返回时，已经完成的门派均分、选手排名和当前页签会立即恢复/);
    assert.match(about.innerHTML, /<h4>华山工具箱<\/h4>/);
    assert.match(about.innerHTML, /为什么分组模拟器只显示常规赛和踢馆赛/);
    assert.match(about.innerHTML, /排名准备完成后，“抽取下一队”和“完成剩余分组”会自动开放/);
    assert.match(about.innerHTML, /官方局分、带入积分、赛外违规扣分、抽局积分和排名/);
    assert.match(about.innerHTML, /<h4>加载与缓存<\/h4>/);
    assert.match(about.innerHTML, /为什么 Mac 版检测不到微信登录信息/);
    assert.match(about.innerHTML, /准备完成后按钮会自动恢复/);
    assert.match(about.innerHTML, /为什么重新查询或再次双击程序后仍然是之前的数据/);
    assert.doesNotMatch(about.innerHTML, /为什么华山规则可以立即打开|为什么填写预测分后结果可以立即变化|为什么再次查看同一内容通常更快/);
  } finally {
    closeAbout();
    globalThis.document = previousDocument;
  }
});

test('赛事筛选：只显示该赛区和赛季实际可用的赛季及比赛类型', () => {
  const catalog = {
    seasons: [{ value: '30', label: 'S30' }, { value: '29', label: 'S29' }],
    season_types: [{ value: '3', label: '常规赛' }, { value: '4', label: '季后赛' }],
    zones: [{ value: 'SH', label: '上海赛区' }, { value: 'SD', label: '山东赛区' }],
  };
  const html = renderEventsHTML({ catalog, availableSeasons: [{ value: '29', label: 'S29' }], availableTypes: [{ value: '4', label: '季后赛' }], season: '29', type: '4', zone: 'SD' });
  assert.doesNotMatch(html, /正在根据真实赛事数据更新可选范围/);
  assert.doesNotMatch(html, /全部赛区/);
  assert.match(html, /S29/);
  assert.doesNotMatch(html, />S30</);
  assert.doesNotMatch(html, />常规赛</);
  assert.match(html, />季后赛</);
  assert.doesNotMatch(html, /全部比赛类型/);
});

test('赛事筛选：修改条件只更新本地状态，不自动查询或计算', () => {
  const previousDocument = globalThis.document;
  const elements = {
    '#event-season': { value: '29' }, '#event-type': { value: '4' }, '#event-zone': { value: 'SD' },
    '#events-body': { innerHTML: '' },
  };
  globalThis.document = { querySelector: selector => elements[selector] || null };
  let calls = 0;
  globalThis.fetch = async () => { calls++; return resp({ body: '{}' }); };
  __setEventsState({
    catalog: { seasons: [{ value: '29', label: 'S29' }], season_types: [{ value: '4', label: '季后赛' }], zones: [{ value: 'SD', label: '山东赛区' }] },
    rankings: { items: [{ sect_id: 1 }] }, abort: null,
  });
  syncEventFilters();
  assert.equal(calls, 0);
  assert.match(elements['#events-body'].innerHTML, /选择赛事范围后查看赛事数据/);
  assert.match(elements['#events-body'].innerHTML, /请选择赛区、赛季和一种比赛类型/);
  globalThis.document = previousDocument;
});

test('赛事筛选：未选择具体比赛类型时禁用查询且不发请求', async () => {
  const previousDocument = globalThis.document;
  const elements = { '#event-season': { value: '29' }, '#event-type': { value: '' }, '#event-zone': { value: 'SH' }, '#events-body': { innerHTML: '' } };
  globalThis.document = { querySelector: s => elements[s] || null };
  const seen = [];
  globalThis.fetch = async url => { seen.push(url); throw new Error('不应发起请求'); };
  try {
    __setEventsState({ catalog: { seasons: [{ value: '29', label: 'S29' }], season_types: [{ value: '4', label: '季后赛' }], zones: [{ value: 'SH', label: '上海赛区' }] }, availableTypes: [{ value: '4', label: '季后赛' }], season: '29', type: '', zone: 'SH', seasonsLoading: false, typesLoading: false, rankings: null, abort: null, gen: 0 });
    const html = renderEventsHTML({ catalog: { seasons: [{ value: '29', label: 'S29' }], season_types: [{ value: '4', label: '季后赛' }], zones: [{ value: 'SH', label: '上海赛区' }] }, availableTypes: [{ value: '4', label: '季后赛' }], season: '29', type: '', zone: 'SH' });
    assert.match(html, /<option value="" disabled selected>请选择比赛类型<\/option>/);
    assert.doesNotMatch(html, /全部比赛类型/);
    assert.match(html, /onclick="queryEvents\(\)" disabled/);
    await queryEvents();
    assert.deepEqual(seen, []);
  } finally {
    globalThis.document = previousDocument;
  }
});

test('赛事筛选：切换赛区依次刷新可用赛季和比赛类型，不自动读取排名或均分', async () => {
  const previousDocument = globalThis.document;
  const elements = {
    '#event-season': { value: '30' }, '#event-type': { value: '2' }, '#event-zone': { value: 'BJ' },
    '#events-body': { innerHTML: '' },
  };
  globalThis.document = { querySelector: selector => elements[selector] || null };
  const seen = [];
  globalThis.fetch = async url => {
    seen.push(url);
    if (url === '/api/events/seasons?zone=BJ') return resp({ body: JSON.stringify({ zone: 'BJ', seasons: [{ value: '29', label: 'S29' }] }) });
    if (url === '/api/events/season-types?season=29&zone=BJ') return resp({ body: JSON.stringify({ season_types: [{ value: '4', label: '季后赛' }] }) });
    throw new Error('unexpected URL: ' + url);
  };
  __setEventsState({
    catalog: { seasons: [{ value: '30', label: 'S30' }, { value: '29', label: 'S29' }], season_types: [{ value: '2', label: '踢馆赛' }], zones: [{ value: 'SH', label: '上海赛区' }, { value: 'BJ', label: '北京赛区' }] },
    availableSeasons: [{ value: '30', label: 'S30' }], rankings: { items: [{ sect_id: 1 }] }, abort: null,
    zone: 'SH', season: '30', type: '2', seasonGen: 0, seasonsLoading: false, seasonsError: '',
    availableTypes: [{ value: '2', label: '踢馆赛' }], typeGen: 0, typesLoading: false, typesError: '',
  });
  await syncEventFilters('zone');
  assert.deepEqual(seen, ['/api/events/seasons?zone=BJ', '/api/events/season-types?season=29&zone=BJ']);
  assert.match(elements['#events-body'].innerHTML, />S29</);
  assert.doesNotMatch(elements['#events-body'].innerHTML, />S30</);
  assert.match(elements['#events-body'].innerHTML, />季后赛</);
  assert.doesNotMatch(elements['#events-body'].innerHTML, />踢馆赛</);
  globalThis.document = previousDocument;
});

test('赛事筛选：切换赛季会刷新当前赛区的比赛类型', async () => {
  const previousDocument = globalThis.document;
  const elements = {
    '#event-season': { value: '29' }, '#event-type': { value: '2' }, '#event-zone': { value: 'BJ' },
    '#events-body': { innerHTML: '' },
  };
  globalThis.document = { querySelector: selector => elements[selector] || null };
  const seen = [];
  globalThis.fetch = async url => {
    seen.push(url);
    return resp({ body: JSON.stringify({ season_types: [{ value: '3', label: '常规赛' }] }) });
  };
  __setEventsState({
    catalog: { seasons: [{ value: '30', label: 'S30' }, { value: '29', label: 'S29' }], season_types: [{ value: '2', label: '踢馆赛' }, { value: '3', label: '常规赛' }], zones: [{ value: 'BJ', label: '北京赛区' }] },
    availableSeasons: [{ value: '30', label: 'S30' }, { value: '29', label: 'S29' }],
    availableTypes: [{ value: '2', label: '踢馆赛' }], zone: 'BJ', season: '30', type: '2', rankings: { items: [{ sect_id: 1 }] },
    typeGen: 0, typesLoading: false, typesError: '', abort: null,
  });
  await syncEventFilters('season');
  assert.deepEqual(seen, ['/api/events/season-types?season=29&zone=BJ']);
  assert.match(elements['#events-body'].innerHTML, />常规赛</);
  assert.doesNotMatch(elements['#events-body'].innerHTML, />踢馆赛</);
  assert.match(elements['#events-body'].innerHTML, /选择赛事范围后查看赛事数据/);
  globalThis.document = previousDocument;
});

test('赛事筛选：迟到的比赛类型请求不会覆盖后来选择的赛季', async () => {
  const previousDocument = globalThis.document;
  const elements = {
    '#event-season': { value: '29' }, '#event-type': { value: '4' }, '#event-zone': { value: 'SD' },
    '#events-body': { innerHTML: '' },
  };
  globalThis.document = { querySelector: selector => elements[selector] || null };
  let resolveFirst;
  globalThis.fetch = async url => {
    if (url.includes('season=29')) return new Promise(resolve => { resolveFirst = resolve; });
    if (url.includes('season=30')) return resp({ body: JSON.stringify({ season_types: [{ value: '2', label: '踢馆赛' }] }) });
    throw new Error('unexpected URL: ' + url);
  };
  __setEventsState({
    catalog: { seasons: [{ value: '30', label: 'S30' }, { value: '29', label: 'S29' }], season_types: [{ value: '2', label: '踢馆赛' }, { value: '4', label: '季后赛' }], zones: [{ value: 'SD', label: '山东赛区' }] },
    availableSeasons: [{ value: '30', label: 'S30' }, { value: '29', label: 'S29' }], availableTypes: null,
    zone: 'SD', season: '29', type: '4', typeGen: 0, typesLoading: false, typesError: '', abort: null,
  });
  const first = syncEventFilters('season');
  elements['#event-season'].value = '30';
  elements['#event-type'].value = '2';
  const second = syncEventFilters('season');
  await second;
  resolveFirst(resp({ body: JSON.stringify({ season_types: [{ value: '4', label: '季后赛' }] }) }));
  await first;
  assert.match(elements['#events-body'].innerHTML, />踢馆赛</);
  assert.doesNotMatch(elements['#events-body'].innerHTML, />季后赛</);
  globalThis.document = previousDocument;
});

test('赛事筛选：读取比赛类型期间禁用选择框和查询', () => {
  const catalog = { seasons: [{ value: '29', label: 'S29' }], season_types: [{ value: '4', label: '季后赛' }], zones: [{ value: 'SD', label: '山东赛区' }] };
  const html = renderEventsHTML({ catalog, availableSeasons: catalog.seasons, availableTypes: null, season: '29', type: '4', zone: 'SD', typesLoading: true });
  assert.match(html, /id="event-type"[^>]* disabled/);
  assert.match(html, /onclick="queryEvents\(\)" disabled/);
  assert.match(html, /正在读取当前赛区和赛季的可用比赛类型/);
});

test('赛事筛选：比赛类型读取失败后提供重试，并在重新进入赛事页时自动恢复', async () => {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  const catalog = { seasons: [{ value: '29', label: 'S29' }], season_types: [{ value: '4', label: '季后赛' }], zones: [{ value: 'SH', label: '上海赛区' }] };
  const pages = {
    '#home': { hidden: false }, '#personal-page': { hidden: true }, '#events-page': { hidden: true }, '#tools-page': { hidden: true }, '#draw-tool-page': { hidden: true },
    '#events-body': { innerHTML: '' },
  };
  const seen = [];
  try {
    globalThis.document = { querySelector: selector => pages[selector] || null };
    globalThis.window = { scrollTo() {}, innerWidth: 1200, innerHeight: 900 };
    globalThis.fetch = async url => {
      seen.push(url);
      return resp({ body: JSON.stringify({ season_types: [{ value: '4', label: '季后赛' }] }) });
    };
    __setEventsState({
      catalog, availableSeasons: catalog.seasons, availableTypes: [], season: '29', type: '', zone: 'SH',
      seasonsLoading: false, typesLoading: false, typesError: '可用比赛类型暂时无法读取，请稍后重试。', typeAbort: null,
    });
    const failed = renderEventsHTML({ catalog, availableSeasons: catalog.seasons, availableTypes: [], season: '29', type: '', zone: 'SH', typesError: '可用比赛类型暂时无法读取，请稍后重试。' });
    assert.match(failed, /onclick="retryEventTypes\(\)">重新读取比赛类型<\/button>/);

    await showEvents();
    assert.deepEqual(seen, ['/api/events/season-types?season=29&zone=SH']);
    assert.equal(pages['#events-page'].hidden, false);
    assert.match(pages['#events-body'].innerHTML, />季后赛</);
    assert.doesNotMatch(pages['#events-body'].innerHTML, /重新读取比赛类型/);
  } finally {
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
    globalThis.fetch = previousFetch;
  }
});

test('赛事导航：离开赛事页会取消请求，并为中断的参赛数据保留恢复提示', async () => {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  const pages = {
    '#home': { hidden: true }, '#personal-page': { hidden: true }, '#events-page': { hidden: false }, '#tools-page': { hidden: true }, '#q': { focus() {} },
    '#events-body': { innerHTML: '' },
  };
  try {
    const seen = [];
    globalThis.fetch = async (url, options = {}) => {
      seen.push([url, options.method]);
      return resp({ status: 204 });
    };
    globalThis.document = { querySelector: selector => pages[selector] || null };
    globalThis.window = { scrollTo() {} };
    const homeRequest = new AbortController();
    const catalog = { seasons: [{ value: '29', label: 'S29' }], season_types: [{ value: '4', label: '季后赛' }], zones: [{ value: 'SH', label: '上海赛区' }] };
    __setEventsState({
      catalog, availableSeasons: catalog.seasons, availableTypes: catalog.season_types,
      season: '29', type: '4', zone: 'SH', rankings: { items: [{ sect_id: 1, sect_name: '青城', total_point: 10 }] },
      abort: homeRequest, loading: false, metricsLoading: true, metricsReady: false, metricsError: '', gen: 10,
      seasonsLoading: false, typesLoading: false, typesError: '', screen: 'rankings',
    });
    showHome();
    assert.equal(homeRequest.signal.aborted, true);
    assert.equal(pages['#home'].hidden, false);
    await showEvents();
    assert.match(pages['#events-body'].innerHTML, /参赛数据未算完，请重新查询/);

    const personalRequest = new AbortController();
    pages['#events-page'].hidden = false;
    __setEventsState({ abort: personalRequest, rankings: null, loading: true, metricsLoading: true, metricsReady: false, metricsError: '' });
    showPersonal();
    assert.equal(personalRequest.signal.aborted, true);
    assert.equal(pages['#personal-page'].hidden, false);

    showTools();
    assert.equal(pages['#tools-page'].hidden, false);
    assert.deepEqual(seen, [['/api/events/draw-prewarm', 'POST']]);
  } finally {
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
    globalThis.fetch = previousFetch;
  }
});

test('赛事导航：切换页面后保留已完成的均分、选手排名和当前页签', async () => {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  const pages = {
    '#home': { hidden: true }, '#personal-page': { hidden: true }, '#events-page': { hidden: false }, '#tools-page': { hidden: true }, '#draw-tool-page': { hidden: true }, '#group-tool-page': { hidden: true },
    '#events-body': { innerHTML: '' },
  };
  try {
    globalThis.document = { querySelector: selector => pages[selector] || null };
    globalThis.window = { scrollTo() {}, innerWidth: 1200, innerHeight: 900 };
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw new Error('返回赛事页不应重新请求数据'); };
    const catalog = {
      seasons: [{ value: '29', label: 'S29' }],
      season_types: [{ value: '4', label: '季后赛' }],
      zones: [{ value: 'SH', label: '上海赛区' }],
    };
    const completedRequest = new AbortController();
    __setEventsState({
      catalog, availableSeasons: catalog.seasons, availableTypes: catalog.season_types,
      season: '29', type: '4', zone: 'SH', screen: 'rankings', abort: completedRequest,
      loading: false, metricsLoading: false, metricsReady: true, metricsError: '', metricsNote: '',
      seasonsLoading: false, seasonsError: '', typesLoading: false, typesError: '',
      eventTab: 'averages', page: 1, expandAll: false, error: '', teamAbort: null, teamRequestKey: '',
      rankings: {
        metric_mode: 'game', metrics_available: true, players_available: true,
        items: [{ sect_id: 1, sect_name: '青城', games: 2, total_point: 15, avg: 7.5 }],
      },
      players: [{ player_id: 7, player_name: '选手甲', games: 2, total_point: 15, avg: 7.5 }],
    });

    showHome();
    assert.equal(completedRequest.signal.aborted, true);
    await showEvents();
    assert.match(pages['#events-body'].innerHTML, /event-tab-averages[^>]* active/);
    assert.match(pages['#events-body'].innerHTML, /<td>7\.5<\/td>/);

    setEventTab('players');
    assert.match(pages['#events-body'].innerHTML, /选手甲/);
    showHome();
    await showEvents();
    assert.match(pages['#events-body'].innerHTML, /event-tab-players[^>]* active/);
    assert.match(pages['#events-body'].innerHTML, /选手甲/);
    assert.equal(calls, 0);
  } finally {
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
    globalThis.fetch = previousFetch;
  }
});

test('赛事导航：从门派成员进入个人页后返回原赛事状态和滚动位置', () => {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const pages = {
    '#home': { hidden: true }, '#personal-page': { hidden: true }, '#events-page': { hidden: false }, '#tools-page': { hidden: true }, '#draw-tool-page': { hidden: true },
    '#personal-back': { textContent: '' }, '#q': { focus() {} }, '#events-body': { innerHTML: '' },
  };
  const scrolls = [];
  try {
    globalThis.document = { querySelector: selector => pages[selector] || null };
    globalThis.window = { scrollY: 333, scrollTo: (x, y) => scrolls.push([x, y]), innerWidth: 1200, innerHeight: 900 };
    const rankingRequest = new AbortController();
    __setEventsState({
      catalog: { seasons: [{ value: '30', label: 'S30' }], season_types: [], zones: [{ value: 'SH', label: '上海赛区' }] },
      season: '30', type: '', zone: 'SH', screen: 'team', team: { id: 78, name: '青城', members: [] }, teamLoading: false, teamError: '', abort: rankingRequest,
    });
    showPersonal('events');
    assert.equal(rankingRequest.signal.aborted, false, '进入个人页不应丢弃赛事状态');
    assert.equal(pages['#personal-back'].textContent, '← 返回门派成员');
    closePersonal();
    assert.equal(pages['#events-page'].hidden, false);
    assert.match(pages['#events-body'].innerHTML, /青城/);
    assert.deepEqual(scrolls.at(-1), [0, 333]);
  } finally {
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
  }
});

test('赛事门派：迟到的旧请求不会覆盖后来打开的门派', async () => {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const body = { innerHTML: '' };
  try {
    globalThis.document = { querySelector: selector => selector === '#events-body' ? body : null };
    globalThis.window = { innerWidth: 1200, innerHeight: 900, scrollTo() {} };
    let resolveFirst, firstSignal;
    globalThis.fetch = async (url, options = {}) => {
      if (url.includes('id=91001')) {
        firstSignal = options.signal;
        return new Promise(resolve => { resolveFirst = resolve; });
      }
      if (url.includes('id=91002')) return resp({ body: JSON.stringify({ id: 91002, name: '后打开门派', members: [] }) });
      throw new Error('unexpected URL: ' + url);
    };
    __setEventsState({
      catalog: { seasons: [{ value: '29', label: 'S29' }], season_types: [{ value: '4', label: '季后赛' }], zones: [{ value: 'SD', label: '山东赛区' }] },
      season: '29', type: '4', zone: 'SD', screen: 'rankings', team: null, teamGen: 0, teamAbort: null, teamRequestKey: '',
    });
    const first = showEventTeam(91001);
    closeEventTeam();
    assert.equal(firstSignal.aborted, true, '返回排名时应立即取消旧门派请求');
    const second = showEventTeam(91002);
    await second;
    resolveFirst(resp({ body: JSON.stringify({ id: 91001, name: '迟到旧门派', members: [] }) }));
    await first;
    assert.match(body.innerHTML, /后打开门派/);
    assert.doesNotMatch(body.innerHTML, /迟到旧门派/);
  } finally {
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
  }
});

test('赛事排名：每页最多 15 支且不使用内部滚动容器', () => {
  const items = Array.from({ length: 20 }, (_, i) => ({ rank: i + 1, sect_id: i + 1, sect_name: '门派' + (i + 1), total_point: 20 - i }));
  const html = renderEventsHTML({ catalog: { seasons: [{ value: '29', label: 'S29' }], season_types: [], zones: [{ value: 'SH', label: '上海赛区' }] }, availableSeasons: [{ value: '29', label: 'S29' }], season: '29', type: '4', zone: 'SH', page: 1, metricsReady: true, eventTab: 'averages', rankings: { metric_mode: 'game', metrics_available: true, items: items.map(item => ({ ...item, games: 3, avg: item.total_point / 3 })) } });
  assert.match(html, /第 1 \/ 2 页/);
  assert.match(html, /门派15/);
  assert.doesNotMatch(html, /门派16/);
  assert.match(styles, /\.event-rank-table table\{table-layout:fixed/);
  assert.doesNotMatch(styles, /\.event-rank-table\{[^}]*overflow/);
  assert.match(styles, /nth-child\(n\+6\)/);
  assert.match(html, /setEventRankSort\('games'\)/);
  assert.match(html, /setEventRankSort\('avg'\)/);
});

test('赛事排名：展开全部按钮切换到不分页显示所有门派', () => {
  const catalog = { seasons: [{ value: '29', label: 'S29' }], season_types: [], zones: [{ value: 'SH', label: '上海赛区' }] };
  const items = Array.from({ length: 20 }, (_, i) => ({ rank: i + 1, sect_id: i + 1, sect_name: '门派' + (i + 1), total_point: 20 - i }));
  const base = { catalog, availableSeasons: [{ value: '29', label: 'S29' }], season: '29', type: '', zone: 'SH', page: 1, rankings: { metric_mode: 'game', items } };
  // 默认分页：只见首页，且提供“展开全部”入口。
  const paged = renderEventsHTML(base);
  assert.match(paged, /第 1 \/ 2 页/);
  assert.match(paged, /toggleEventExpand\(\)/);
  assert.match(paged, /展开全部/);
  assert.doesNotMatch(paged, /门派16/);
  // 展开后：所有门派一次显示，分页翻页消失，改为“收起分页”。
  const expanded = renderEventsHTML({ ...base, expandAll: true });
  assert.match(expanded, /门派16/);
  assert.match(expanded, /门派20/);
  assert.match(expanded, /已显示全部 20 支门派/);
  assert.match(expanded, /收起分页/);
  assert.doesNotMatch(expanded, /第 1 \/ 2 页/);
});

test('api 层：非 2xx 或含 error 字段 → 抛出带 message 与 status 的错误', async () => {
  globalThis.fetch = async () => resp({ ok: false, status: 500, body: JSON.stringify({ error: { message: 'boom' } }) });
  await assert.rejects(() => game(1), e => e.message === 'boom' && e.status === 500);
});

test('主动取消本地请求：保留 AbortError，不误报服务失联', async () => {
  let alerts = 0;
  globalThis.window = { alert: () => { alerts++; }, close: () => {} };
  const aborted = new Error('aborted'); aborted.name = 'AbortError';
  globalThis.fetch = async () => { throw aborted; };
  await assert.rejects(() => game(1), e => e === aborted);
  assert.equal(alerts, 0);
  delete globalThis.window;
});

test('本地服务失联：包装错误、提示重启并尝试关闭页面', async () => {
  let message = '', closes = 0;
  globalThis.window = { alert: s => { message = s; }, close: () => { closes++; } };
  globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(() => game(1), e => e.name === 'LocalServerError' && e.status === 0 && /重新启动/.test(e.message));
  assert.match(message, /连接已断开/);
  assert.match(message, /手动关闭/);
  assert.equal(closes, 1);
  await assert.rejects(() => game(2), e => e.name === 'LocalServerError');
  await assert.rejects(() => refreshSession(), e => e.name === 'LocalServerError');
  assert.equal(closes, 1, '并发或后续失败不应重复弹窗、重复关闭');
  delete globalThis.window;
});

test('api 层：401 → 触发 onAuthLost 回调并抛错（回调改为“回到引导页”，不再用内联横幅）', async () => {
  let lost = 0;
  setAuthLostHandler(() => lost++);
  globalThis.fetch = async () => resp({ ok: false, status: 401, body: '' });
  await assert.rejects(() => detail('id=1'), e => e.status === 401);
  assert.equal(lost, 1);
  setAuthLostHandler(null);
});

test('gateHTML：桌面微信登录页沿用首页视觉并提供持续检测与 Token 回退', () => {
  const h = gateHTML();
  assert.match(h, /HS \/ ACCESS/);
  assert.match(h, /先连接登录/);
  assert.match(h, /电脑版微信/);
  assert.match(h, /“四刀四神”公众号/);
  assert.match(h, /“门派报名”/);
  assert.match(h, /“华山城市赛区”/);
  assert.match(h, /“华山系列赛事”/);
  assert.match(h, /“华山合作赛事”/);
  assert.match(h, /“选手数据”/);
  assert.match(h, /选手详情页/);
  assert.match(h, /方式一 · 公众号入口/);
  assert.match(h, /方式二 · 官方链接/);
  assert.match(h, /https:\/\/h5\.huashan\.tv\/pages\/player\/index\?id=214/);
  assert.match(h, /聊天记录中点击打开/);
  assert.match(h, /retryToken\(this\)/);
  assert.match(h, /开始实时检测/);
  assert.match(h, /详情页可以保持打开/);
  assert.match(h, /id="manual-token"/);
  assert.match(h, /useManualToken\(this\.nextElementSibling\)/);
  assert.match(h, /不会保存你输入的 Token/);
  assert.match(gateHTML('expired'), /已过期/);       // 精确原因：过期
  assert.match(gateHTML('network'), /连不上华山服务器/); // 精确原因：网络
  assert.match(gateHTML('server'), /服务器暂时异常/);   // 精确原因：服务器
});

test('gateHTML：不支持自动读取的平台仅显示手动 Token 引导', () => {
  const html = gateHTML('no_token', true);
  assert.match(html, /当前系统无法自动读取微信登录信息/);
  assert.match(html, /验证并登录/);
  assert.doesNotMatch(html, /开始实时检测|电脑版微信/);
});

test('手动输入框只在登录失败提示页出现；登录成功后进入首页', () => {
  const previousDocument = globalThis.document;
  const elements = {
    '#gate': { innerHTML: '', hidden: true },
    '#app': { hidden: false },
    '#home': { hidden: true },
    '#personal-page': { hidden: false },
    '#events-page': { hidden: false },
    '#tools-page': { hidden: false },
    '#tokexp': { textContent: '' },
  };
  globalThis.document = { querySelector: sel => elements[sel] || null };
  showGate();
  assert.equal(elements['#gate'].hidden, false);
  assert.match(elements['#gate'].innerHTML, /id="manual-token"/);
  assert.equal(elements['#app'].hidden, true);
  enterApp();
  assert.equal(elements['#gate'].hidden, true);
  assert.equal(elements['#app'].hidden, false);
  assert.equal(elements['#home'].hidden, false);
  assert.equal(elements['#personal-page'].hidden, true);
  assert.equal(elements['#events-page'].hidden, true);
  assert.equal(elements['#tools-page'].hidden, true);
  globalThis.document = previousDocument;
});

test('持续检测：前两次未写入、后续检测到登录信息后自动进入首页', async () => {
  const previousDocument = globalThis.document;
  const previousSetTimeout = globalThis.setTimeout;
  const elements = {
    '#gate': { hidden: false }, '#app': { hidden: true }, '#home': { hidden: true },
    '#personal-page': { hidden: false }, '#events-page': { hidden: false }, '#tools-page': { hidden: false },
    '#auto-status': { textContent: '', className: '' }, '#tokexp': { textContent: '' },
  };
  globalThis.document = { querySelector: sel => elements[sel] || null };
  globalThis.setTimeout = fn => { fn(); return 0; };
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts++;
    const session = attempts < 3
      ? { nick: '', exp: 0, reason: 'no_token' }
      : { nick: '已登录', exp: 1893456000, reason: '' };
    return resp({ body: JSON.stringify(session) });
  };
  const btn = { textContent: '开始实时检测', disabled: false };
  try {
    await retryToken(btn);
    assert.equal(attempts, 3);
    assert.equal(elements['#gate'].hidden, true);
    assert.equal(elements['#app'].hidden, false);
    assert.equal(elements['#home'].hidden, false);
  } finally {
    globalThis.setTimeout = previousSetTimeout;
    globalThis.document = previousDocument;
  }
});

test('手动 Token：PUT JSON 到本地端点并更新会话；复制时才 GET 明文', async () => {
  const seen = [];
  globalThis.fetch = async (url, opt = {}) => {
    seen.push({ url, opt });
    if (opt.method === 'PUT') return resp({ body: JSON.stringify({ nick: '共享账号', exp: 1893456000, reason: '' }) });
    return resp({ body: JSON.stringify({ token: 'ey.test.token' }) });
  };
  const session = await setManualToken('ey.test.token');
  assert.equal(session.nick, '共享账号');
  assert.equal(tokenValid(), true);
  assert.equal(await currentToken(), 'ey.test.token');
  assert.equal(seen[0].url, '/api/token');
  assert.equal(seen[0].opt.method, 'PUT');
  assert.equal(seen[0].opt.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(seen[0].opt.body), { token: 'ey.test.token' });
  assert.equal(seen[1].opt.method, 'GET');
});

test('使用说明：提供功能索引、完整操作步骤，并把 FAQ 和 Token 工具收在同一帮助中心', async () => {
  const previousDocument = globalThis.document;
  const about = { style: {}, innerHTML: '' };
  globalThis.document = { querySelector: selector => selector === '#about' ? about : null };
  globalThis.fetch = async () => resp({ body: JSON.stringify({ nick: '已登录', exp: 1893456000, reason: '' }) });
  await setManualToken('ey.test.token');
  showAbout();
  assert.equal(about.style.display, 'flex');
  assert.equal((about.innerHTML.match(/class="help-major(?: |")/g) || []).length, 4);
  assert.match(about.innerHTML, /<details id="help-usage" class="help-major">[\s\S]*<b>使用说明<\/b>/);
  assert.match(about.innerHTML, /<details id="help-faq" class="help-major faq-section">[\s\S]*<b>FAQ<\/b>/);
  assert.doesNotMatch(about.innerHTML, /<details[^>]*\sopen(?:\s|>)/);
  for (const section of ['快速开始', '个人数据', '多人对比', '赛事数据', '工具箱', '登录与数据']) {
    assert.match(about.innerHTML, new RegExp(`jumpHelp\\('[^']+'\\)[^>]*>${section}<`));
  }
  assert.match(about.innerHTML, /赛区 → 赛季 → 门派/);
  assert.match(about.innerHTML, /后面的选项会根据前面的选择更新/);
  assert.match(about.innerHTML, /首次点击按该列从高到低排列，再点一次切换方向/);
  assert.match(about.innerHTML, /多项条件可以同时使用/);
  assert.match(about.innerHTML, /“加载更多”只增加当前已经读取的战绩显示数量/);
  assert.match(about.innerHTML, /重复查看同一范围通常会更快/);
  assert.match(about.innerHTML, /同一版本已经运行时，再次双击程序只会打开现有页面/);
  assert.match(about.innerHTML, /同场对比[^<]*所有已选选手共同参加的对局/);
  assert.match(about.innerHTML, /所有选手使用同一组赛区和赛季范围/);
  assert.doesNotMatch(about.innerHTML, /所有选手使用同一组赛区、赛季和门派范围/);
  assert.match(about.innerHTML, /按版型筛选或调整日期顺序/);
  assert.doesNotMatch(about.innerHTML, /按日期或分数排序/);
  assert.match(about.innerHTML, /赛区决定可选赛季，赛区和赛季共同决定可选比赛类型/);
  assert.match(about.innerHTML, /抽局积分模拟器/);
  assert.match(about.innerHTML, /<details id="help-token" class="help-major">[\s\S]*获取 Token[\s\S]*复制当前 Token[\s\S]*<\/details>/);
  assert.match(about.innerHTML, /四刀四神[\s\S]*门派报名[\s\S]*华山城市赛区[\s\S]*选手数据[\s\S]*选手详情页/);
  assert.match(about.innerHTML, /方式一 · 通过公众号进入[\s\S]*方式二 · 通过官方链接进入/);
  assert.match(about.innerHTML, /https:\/\/h5\.huashan\.tv\/pages\/player\/index\?id=214/);
  assert.match(about.innerHTML, /聊天记录进入/);
  assert.match(about.innerHTML, /官方页面不会直接显示 Token 字符串/);
  assert.match(about.innerHTML, /<details id="help-feedback" class="help-major">[\s\S]*问题反馈与联络[\s\S]*<\/details>/);
  assert.match(about.innerHTML, /Token 是临时登录凭证[\s\S]*关闭程序后，本次使用的 Token 会从程序内存中清除/);
  assert.match(about.innerHTML, /程序版本、所在页面、操作步骤和页面提示/);
  assert.match(about.innerHTML, /请勿在反馈中发送 Token 或其他登录信息/);
  assert.ok(about.innerHTML.indexOf('id="help-usage"') < about.innerHTML.indexOf('id="help-faq"'));
  assert.ok(about.innerHTML.indexOf('id="help-faq"') < about.innerHTML.indexOf('id="help-token"'));
  assert.ok(about.innerHTML.indexOf('id="help-token"') < about.innerHTML.indexOf('id="help-feedback"'));
  assert.match(styles, /\.ov-card\.guide-card\{[^}]*max-width:900px/);
  assert.match(styles, /\.help-index\{[^}]*position:sticky/);
  assert.match(styles, /\.faq-item>summary\{[^}]*cursor:pointer/);
  closeAbout();
  globalThis.document = previousDocument;
});

test('弹窗栈：新弹窗位于顶层，关闭后恢复底层弹窗和页面状态', () => {
  const previousDocument = globalThis.document;
  const classes = new Set();
  const wrap = { inert: false };
  const outside = { isConnected: true, focused: false, focus() { this.focused = true; globalThis.document.activeElement = this; } };
  const modal = () => {
    const attrs = new Map([['aria-hidden', 'true']]);
    const close = { hidden: false, offsetParent: {}, isConnected: true, focus() { globalThis.document.activeElement = this; } };
    return {
      style: {}, inert: false, close,
      setAttribute: (key, value) => attrs.set(key, value),
      getAttribute: key => attrs.get(key),
      hasAttribute: key => attrs.has(key),
      querySelector: selector => selector === '.ov-close' ? close : null,
      querySelectorAll: () => [close],
    };
  };
  const first = modal(), second = modal();
  globalThis.document = {
    activeElement: outside,
    body: { classList: { toggle: (name, on) => on ? classes.add(name) : classes.delete(name) } },
    querySelector: selector => selector === '.wrap' ? wrap : null,
  };
  try {
    openModal(first, { focusSelector: '.ov-close' });
    openModal(second, { focusSelector: '.ov-close' });
    assert.equal(first.style.zIndex, '50');
    assert.equal(second.style.zIndex, '51');
    assert.equal(first.inert, true);
    assert.equal(first.getAttribute('aria-hidden'), 'true');
    assert.equal(second.inert, false);
    assert.equal(second.getAttribute('aria-hidden'), 'false');
    assert.equal(globalThis.document.activeElement, second.close);

    closeModal(second);
    assert.equal(first.inert, false);
    assert.equal(first.getAttribute('aria-hidden'), 'false');
    assert.equal(globalThis.document.activeElement, first.close);
    assert.equal(wrap.inert, true);

    closeModal(first);
    assert.equal(wrap.inert, false);
    assert.equal(classes.has('modal-open'), false);
    assert.equal(outside.focused, true);
  } finally {
    closeModal(second);
    closeModal(first);
    globalThis.document = previousDocument;
  }
});

test('startHeartbeat：立即敲一次 /api/heartbeat（POST），stopHeartbeat 停止', () => {
  const seen = [];
  globalThis.fetch = async (url, opt) => { seen.push({ url, method: opt && opt.method }); return resp({ body: '' }); };
  startHeartbeat();
  stopHeartbeat();
  assert.deepEqual(seen[0], { url: '/api/heartbeat', method: 'POST' });
});

test('stopHeartbeat：唤醒监听器随之移除（不泄漏、可安全重启）', () => {
  const add = {}, remove = {};
  const mk = () => ({
    visibilityState: 'visible',
    addEventListener: ev => { add[ev] = (add[ev] || 0) + 1; },
    removeEventListener: ev => { remove[ev] = (remove[ev] || 0) + 1; },
  });
  globalThis.document = mk();
  globalThis.window = mk();
  globalThis.fetch = async () => resp({ body: '' });
  startHeartbeat();
  stopHeartbeat();
  for (const ev of ['visibilitychange', 'focus', 'pageshow']) {
    assert.equal(add[ev], 1, ev + ' 应注册一次');
    assert.equal(remove[ev], 1, ev + ' 应移除一次');
  }
  delete globalThis.document; delete globalThis.window;
});

test('quitApp：停心跳并 POST /api/quit', async () => {
  let seen;
  globalThis.fetch = async (url, opt) => { seen = { url, method: opt && opt.method }; return resp({ body: '' }); };
  await quitApp();
  assert.equal(seen.url, '/api/quit');
  assert.equal(seen.method, 'POST');
});

test('refreshSession + sessionReason：解析 /api/session 的精确原因字段', async () => {
  globalThis.fetch = async () => resp({ body: JSON.stringify({ nick: '', exp: 0, reason: 'expired' }) });
  assert.equal(await refreshSession(true), false);
  assert.equal(sessionReason(), 'expired');
});

test('refreshSession：解析 nick/exp；force 时带 ?refresh=1，普通启动不带；失败返回 false', async () => {
  let seenUrl;
  globalThis.fetch = async url => { seenUrl = url; return resp({ body: JSON.stringify({ nick: '阿三', exp: 1893456000 }) }); };
  assert.equal(await refreshSession(false), true);
  assert.equal(seenUrl, '/api/session');
  await refreshSession(true);
  assert.equal(seenUrl, '/api/session?refresh=1');

  globalThis.fetch = async () => resp({ ok: false, status: 500, body: '' });
  assert.equal(await refreshSession(), false);
});

test('rankByRelevance：完全相同 > 前缀 > 包含（越靠前越优）> 其余；同档按名字更短、总分降序', () => {
  const arr = [
    { player_name: '张三丰', total_point: 10 },
    { player_name: '李四', total_point: 100 },     // 不含“张三”→ 末档
    { player_name: '小张三', total_point: 99 },     // 包含（位置靠后）
    { player_name: '张三', total_point: 5 },        // 完全相同
    { player_name: '张三疯子', total_point: 1 },     // 前缀，但比“张三丰”长
  ];
  const out = rankByRelevance(arr, '张三').map(p => p.player_name);
  assert.deepEqual(out, ['张三', '张三丰', '张三疯子', '小张三', '李四']);
  // 空查询：不改变原始相对顺序（稳定）
  assert.deepEqual(rankByRelevance(arr, '').map(p => p.player_name), arr.map(p => p.player_name));
});

test('英文名搜索：只尝试原输入和首字母大写形式，并按 player_id 合并去重', () => {
  assert.deepEqual(playerSearchVariants('jacky'), ['jacky', 'Jacky']);
  assert.deepEqual(playerSearchVariants('Jacky'), ['Jacky']);
  assert.deepEqual(playerSearchVariants('张三'), ['张三']);
  assert.deepEqual(playerSearchVariants(''), []);

  const merged = mergePlayerSearchResults([
    [{ player_id: 1, player_name: 'jacky', total_point: 10 }],
    { items: [{ player_id: 1, player_name: 'Jacky', total_point: 20 }, { player_id: 2, player_name: 'Jacky', total_point: 5 }] },
  ]);
  assert.deepEqual(merged.map(p => [p.player_id, p.player_name, p.total_point]), [
    [1, 'jacky', 10], [2, 'Jacky', 5],
  ]);
});

test('rankByRelevance：英文姓名忽略大小写后比较', () => {
  const arr = [
    { player_name: 'NotJacky', total_point: 100 },
    { player_name: 'JackyBoy', total_point: 20 },
    { player_name: 'JACKY', total_point: 5 },
    { player_name: 'jacky', total_point: 10 },
  ];
  assert.deepEqual(rankByRelevance(arr, 'jAcKy').map(p => p.player_name), [
    'jacky', 'JACKY', 'JackyBoy', 'NotJacky',
  ]);
});

test('rankByRelevance：英文姓名字面完全匹配优先于忽略大小写匹配', () => {
  const arr = [
    { player_name: 'jacky', total_point: 100 },
    { player_name: 'JACKY', total_point: 50 },
    { player_name: 'Jacky', total_point: 1 },
  ];
  assert.deepEqual(rankByRelevance(arr, 'Jacky').map(p => p.player_name), [
    'Jacky', 'jacky', 'JACKY',
  ]);
});

test('英文名补搜：任一变体请求失败时不把不完整结果显示为未找到', async () => {
  const previousDocument = globalThis.document;
  const previousFetch = globalThis.fetch;
  const elements = {
    '#q': { value: 'jacky' },
    '#results': { innerHTML: '' },
    '#detail': { innerHTML: '' },
  };
  const seen = [];
  globalThis.document = { querySelector: selector => elements[selector] || null };
  globalThis.fetch = async url => {
    seen.push(url);
    if (url.endsWith('name=jacky')) {
      return resp({ ok: false, status: 500, body: JSON.stringify({ error: { message: '上游搜索失败' } }) });
    }
    return resp({ body: '[]' });
  };
  try {
    await searchName();
    assert.deepEqual(seen, [
      '/api/players/search?name=jacky',
      '/api/players/search?name=Jacky',
    ]);
    assert.match(elements['#results'].innerHTML, /搜索失败：上游搜索失败/);
    assert.doesNotMatch(elements['#results'].innerHTML, /没找到/);
  } finally {
    globalThis.document = previousDocument;
    globalThis.fetch = previousFetch;
  }
});

test('批量搜索：按换行和常用标点拆分，保留英文名空格并忽略重复输入', () => {
  assert.deepEqual(parseBatchNames('张三\n李四， Jack Smith;张三、jack smith'), ['张三', '李四', 'Jack Smith']);
  assert.deepEqual(parseBatchNames(' ；，\n '), []);
});

test('批量输入人数：按查找口径去重，空行不计数，英文名中的空格保留', () => {
  const state = batchInputState('张三\n\n李四，Jack Smith;张三、jack smith', 12);
  assert.deepEqual(state.names, ['张三', '李四', 'Jack Smith']);
  assert.equal(state.count, 3);
  assert.equal(state.duplicates, 2);
  assert.equal(state.canSearch, true);
  assert.equal(batchInputState(' \n；， ', 12).count, 0);
  assert.equal(batchInputState(' \n；， ', 12).canSearch, false);
});

test('批量输入人数：最多查找 12 人，剩余名额按实际新增人数校验', () => {
  const twelve = Array.from({ length: 12 }, (_, i) => '选手' + i).join('\n');
  assert.equal(batchInputState(twelve, 12).canSearch, true);
  const over = batchInputState(twelve + '\n其他选手', 12);
  assert.equal(over.count, 13);
  assert.equal(over.canSearch, false);
  assert.match(over.note, /已超出 1 人/);
  const limited = batchInputState('张三\n李四', 1);
  assert.equal(limited.canSearch, true);
  assert.match(limited.note, /实际新增人数/);
  assert.equal(batchInputState('张三', 0).canSearch, false);
});

async function withBatchModal(check) {
  const previous = { document: globalThis.document, fetch: globalThis.fetch };
  const slotIDs = Array.from({ length: 12 }, (_, index) => ['slot', 'name', 'state', 'editor', 'saved', 'edit', 'save'].map(part => `#batch-${part}-${index}`)).flat();
  const nodes = Object.fromEntries(['#pop', '#batch-input-meta', '#batch-capacity', '#batch-results', '#batch-actions', '#batch-run', '#results', ...slotIDs].map(key => [key, {
    innerHTML: '', textContent: '', value: '', hidden: false, style: {}, dataset: {},
    focus() { globalThis.document.activeElement = this; }, select() {}, setAttribute() {}, querySelectorAll: () => [],
  }]));
  for (let index = 0; index < 12; index++) nodes[`#batch-name-${index}`].dataset.slot = String(index);
  nodes['#pop'].querySelector = selector => nodes[selector] || null;
  globalThis.document = { querySelector: selector => nodes[selector] || null, querySelectorAll: () => [], activeElement: nodes['#batch-name-0'] };
  __resetBasket(); setView('search');
  try {
    showBatchSearch();
    await check(nodes);
  } finally {
    closePop(); __resetBasket(); Object.assign(globalThis, previous);
  }
}

test('批量弹窗：固定展示 12 格，回车前后的输入样式和人数明确区分', async () => {
  await withBatchModal(async nodes => {
    assert.match(nodes['#pop'].innerHTML, /oninput="syncBatchInput\(\)"/);
    assert.equal((nodes['#pop'].innerHTML.match(/class="batch-slot"/g) || []).length, 12);
    assert.doesNotMatch(nodes['#pop'].innerHTML, /textarea/);
    assert.match(nodes['#batch-input-meta'].innerHTML, /已录入 0 人/);
    assert.equal(nodes['#batch-run'].disabled, true);
    assert.equal(nodes['#batch-results'].hidden, true);
    assert.equal(nodes['#batch-actions'].hidden, true);
    nodes['#batch-name-0'].value = '张三'; syncBatchInput();
    assert.equal(nodes['#batch-slot-0'].dataset.state, 'draft');
    assert.match(nodes['#batch-input-meta'].innerHTML, /已录入 0 人.*待录入 1 人/);
    confirmBatchName(0);
    assert.equal(nodes['#batch-editor-0'].hidden, true);
    assert.equal(nodes['#batch-saved-0'].hidden, false);
    assert.equal(nodes['#batch-slot-0'].dataset.state, 'confirmed');
    assert.equal(globalThis.document.activeElement, nodes['#batch-name-1']);
    nodes['#batch-name-1'].value = '李四'; syncBatchInput(); confirmBatchName(1);
    assert.match(nodes['#batch-input-meta'].innerHTML, /已录入 2 人/);
    assert.equal(nodes['#batch-run'].textContent, '查找 2 名选手');
    assert.equal(nodes['#batch-run'].disabled, false);
    assert.equal(nodes['#batch-results'].hidden, true);
    removeBatchName(0); removeBatchName(1);
    assert.equal(nodes['#batch-run'].disabled, true);
    assert.equal(nodes['#batch-actions'].hidden, true);
  });
});

test('批量弹窗：中文选字回车不录入，普通回车录入，重复名字不占名额', async () => {
  await withBatchModal(async nodes => {
    const input = nodes['#batch-name-0'];
    input.value = '张三'; syncBatchInput();
    let prevented = 0;
    const key = { key: 'Enter', preventDefault() { prevented++; } };
    batchNameKeydown({ ...key, isComposing: true }, input);
    batchNameKeydown({ ...key, keyCode: 229 }, input);
    assert.equal(prevented, 0);
    assert.equal(nodes['#batch-slot-0'].dataset.state, 'draft');
    batchNameKeydown(key, input);
    assert.equal(prevented, 1);
    assert.equal(nodes['#batch-slot-0'].dataset.state, 'confirmed');
    nodes['#batch-name-1'].value = '张三'; syncBatchInput(); confirmBatchName(1);
    assert.equal(nodes['#batch-name-1'].value, '');
    assert.match(nodes['#batch-input-meta'].innerHTML, /已忽略重复输入/);
    editBatchName(0);
    assert.equal(nodes['#batch-editor-0'].hidden, false);
    assert.equal(globalThis.document.activeElement, input);
    input.value = '李四'; syncBatchInput(); confirmBatchName(0);
    assert.equal(nodes['#batch-edit-0'].textContent, '李四');
  });
});

test('批量弹窗：整份名单粘贴后直接成为标签，保留英文空格并去重', async () => {
  await withBatchModal(async nodes => {
    const input = nodes['#batch-name-0'];
    let prevented = false;
    pasteBatchNames({ preventDefault() { prevented = true; }, clipboardData: { getData: () => '张三\nJack Smith；张三、jack smith\n李四' } }, input);
    assert.equal(prevented, true);
    assert.match(nodes['#batch-input-meta'].innerHTML, /已录入 3 人.*已忽略 2 个重复名字/);
    assert.equal(nodes['#batch-edit-1'].textContent, 'Jack Smith');
    assert.equal(nodes['#batch-slot-2'].dataset.state, 'confirmed');
    assert.equal(globalThis.document.activeElement, nodes['#batch-name-3']);
    assert.equal(nodes['#batch-results'].hidden, true);
  });
});

test('批量弹窗：12 个名字全部录入后聚焦查找，超量粘贴不截断或覆盖', async () => {
  await withBatchModal(async nodes => {
    const names = Array.from({ length: 12 }, (_, i) => '选手' + i).join('\n');
    const paste = text => ({ preventDefault() {}, clipboardData: { getData: () => text } });
    pasteBatchNames(paste(names + '\n其他'), nodes['#batch-name-0']);
    assert.match(nodes['#batch-input-meta'].innerHTML, /13 个新名字，未录入/);
    assert.equal(nodes['#batch-name-0'].value, '');
    pasteBatchNames(paste(names), nodes['#batch-name-0']);
    assert.match(nodes['#batch-input-meta'].innerHTML, /已录入 12 人/);
    assert.equal(globalThis.document.activeElement, nodes['#batch-run']);
    editBatchName(0);
    nodes['#batch-name-0'].selectionStart = 0;
    nodes['#batch-name-0'].selectionEnd = nodes['#batch-name-0'].value.length;
    pasteBatchNames(paste('新人一\n新人二'), nodes['#batch-name-0']);
    assert.match(nodes['#batch-input-meta'].innerHTML, /还剩 1 个空位/);
    assert.equal(nodes['#batch-name-0'].value, '选手0');
    assert.equal(nodes['#batch-name-11'].value, '选手11');
  });
});

test('批量弹窗：查找后显示结果，完成后才显示确认，修改名单后清除旧结果', async () => {
  await withBatchModal(async nodes => {
    const requests = [];
    globalThis.fetch = (url, options) => new Promise(resolve => requests.push({ url, options, resolve }));
    nodes['#batch-name-0'].value = '张三'; syncBatchInput();
    const pending = runBatchSearch();
    assert.equal(nodes['#batch-results'].hidden, false);
    assert.match(nodes['#batch-results'].innerHTML, /查找中/);
    assert.equal(nodes['#batch-actions'].hidden, true);
    await runBatchSearch();
    assert.equal(requests.length, 1);
    requests[0].resolve(resp({ body: JSON.stringify([{ player_id: 1, player_name: '张三' }]) }));
    await pending;
    assert.match(nodes['#batch-results'].innerHTML, /已确定/);
    assert.equal(nodes['#batch-actions'].hidden, false);
    assert.match(nodes['#batch-actions'].innerHTML, /将 1 人加入对比篮/);
    nodes['#batch-name-1'].value = '张三'; syncBatchInput();
    assert.equal(nodes['#batch-results'].hidden, false);
    nodes['#batch-name-0'].value = '李四'; syncBatchInput();
    assert.equal(nodes['#batch-results'].hidden, true);
    assert.equal(nodes['#batch-actions'].hidden, true);
    confirmBatchPlayers();
    assert.equal(basketCount(), 0);
    assert.equal(requests.length, 1);
  });
});

test('批量弹窗：名单修改或关闭重开后，迟到的查询不会恢复旧结果', async () => {
  await withBatchModal(async nodes => {
    const requests = [];
    globalThis.fetch = (url, options) => new Promise(resolve => requests.push({ options, resolve }));
    nodes['#batch-name-0'].value = '张三'; syncBatchInput();
    const oldSearch = runBatchSearch();
    nodes['#batch-name-0'].value = '李四'; syncBatchInput();
    assert.equal(requests[0].options.signal.aborted, true);
    requests[0].resolve(resp({ body: JSON.stringify([{ player_id: 1, player_name: '张三' }]) }));
    await oldSearch;
    assert.equal(nodes['#batch-results'].hidden, true);
    const beforeClose = runBatchSearch();
    closePop(); showBatchSearch();
    nodes['#batch-name-0'].value = '王五'; syncBatchInput();
    const currentSearch = runBatchSearch();
    requests[1].resolve(resp({ body: JSON.stringify([{ player_id: 2, player_name: '李四' }]) }));
    await beforeClose;
    assert.doesNotMatch(nodes['#batch-results'].innerHTML, /李四/);
    assert.equal(nodes['#batch-run'].disabled, true);
    requests[2].resolve(resp({ body: JSON.stringify([{ player_id: 3, player_name: '王五' }]) }));
    await currentSearch;
    assert.match(nodes['#batch-results'].innerHTML, /王五/);
    assert.equal(nodes['#batch-actions'].hidden, false);
  });
});

test('批量弹窗：空名单、超限和篮满不发请求，提示不占用结果区域', async () => {
  await withBatchModal(async nodes => {
    let requests = 0;
    globalThis.fetch = async () => { requests++; throw new Error('Unexpected request'); };
    await runBatchSearch();
    nodes['#batch-name-0'].value = Array.from({ length: 13 }, (_, i) => '选手' + i).join('\n'); syncBatchInput();
    await runBatchSearch();
    assert.match(nodes['#batch-input-meta'].innerHTML, /已超出 1 人/);
    assert.equal(nodes['#batch-results'].hidden, true);
    addManyToBasket(Array.from({ length: 12 }, (_, i) => ({ id: String(i + 1), name: '选手' + i })));
    nodes['#batch-name-0'].value = '张三'; syncBatchInput();
    await runBatchSearch();
    assert.match(nodes['#batch-input-meta'].innerHTML, /对比篮已满/);
    assert.match(nodes['#batch-capacity'].textContent, /已保留 12 人 · 还能添加 0 人/);
    assert.equal(nodes['#batch-actions'].hidden, true);
    assert.equal(requests, 0);
  });
});

test('添加人员：已有姓名固定且不参与查找，只在剩余名额录入', async () => {
  await withBatchModal(async nodes => {
    addManyToBasket([{ id: '1', name: '张三' }, { id: '2', name: '李四' }]);
    showBatchSearch();
    assert.equal((nodes['#pop'].innerHTML.match(/batch-slot-locked/g) || []).length, 2);
    assert.doesNotMatch(nodes['#pop'].innerHTML, /id="batch-name-[01]"/);
    assert.match(nodes['#batch-capacity'].textContent, /已保留 2 人 · 还能添加 10 人/);
    editBatchName(0); removeBatchName(1);
    nodes['#batch-name-0'].value = '不能改写';
    nodes['#batch-name-2'].value = '王五';
    const queries = [];
    globalThis.fetch = async url => {
      queries.push(new URL(url, 'http://localhost').searchParams.get('name'));
      return resp({ body: JSON.stringify([{ player_id: 3, player_name: '王五' }]) });
    };
    nodes['#batch-name-2'].value = Array.from({ length: 11 }, (_, i) => '新选手' + i).join(';');
    await runBatchSearch();
    assert.equal(queries.length, 0);
    assert.match(nodes['#batch-input-meta'].innerHTML, /本次最多填写 10 个名字/);
    nodes['#batch-name-2'].value = '王五';
    await runBatchSearch();
    assert.deepEqual(queries, ['王五']);
    confirmBatchPlayers();
    assert.equal(basketCount(), 3);
    assert.equal(inBasket('1'), true);
    assert.equal(inBasket('2'), true);
  });
});

test('更换全部人员：满员仍能查找原选手，取消保留名单，确认后才替换', async () => {
  await withBatchModal(async nodes => {
    addManyToBasket(Array.from({ length: 12 }, (_, i) => ({ id: String(i + 1), name: '选手' + i })));
    showBatchSearch('replace');
    assert.equal((nodes['#pop'].innerHTML.match(/class="batch-slot"/g) || []).length, 12);
    assert.match(nodes['#batch-capacity'].textContent, /原名单 12 人 · 新名单最多 12 人/);
    closePop();
    assert.equal(basketCount(), 12);
    showBatchSearch('replace');
    nodes['#batch-name-0'].value = '张三'; nodes['#batch-name-1'].value = '李四';
    globalThis.fetch = async url => {
      const name = new URL(url, 'http://localhost').searchParams.get('name');
      return resp({ body: JSON.stringify([{ player_id: name === '张三' ? 1 : 2, player_name: name }]) });
    };
    await runBatchSearch();
    assert.equal(basketCount(), 12);
    assert.doesNotMatch(nodes['#batch-results'].innerHTML, / disabled/);
    assert.match(nodes['#batch-actions'].innerHTML, /确认更换为 2 人并对比/);
    confirmBatchPlayers();
    assert.equal(basketCount(), 2);
    assert.equal(inBasket('1'), true);
    assert.equal(inBasket('12'), false);
  });
});

test('批量搜索：唯一完全同名自动确定，多个同名或只有模糊结果时等待选择', async () => {
  const data = {
    '张三': [{ player_id: 1, player_name: '张三' }, { player_id: 2, player_name: '张三丰' }],
    '李四': [{ player_id: 3, player_name: '李四' }, { player_id: 4, player_name: '李四' }],
    '王五': [{ player_id: 5, player_name: '小王五' }],
  };
  const entries = await resolveBatchPlayerNames(['张三', '李四', '王五'], { search: async name => data[name] || [] });
  assert.equal(entries[0].status, 'resolved');
  assert.equal(entries[0].selectedId, '1');
  assert.equal(entries[1].status, 'ambiguous');
  assert.equal(entries[1].selectedId, '');
  assert.equal(entries[2].status, 'ambiguous');
  assert.equal(entries[2].selectedId, '');
});

test('批量搜索：所有姓名变体共享并发上限，单行失败不影响其他名字', async () => {
  let active = 0, peak = 0;
  const search = async name => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 2));
    active--;
    if (name === 'bad') throw new Error('上游失败');
    return [{ player_id: name.toLowerCase(), player_name: name.toLowerCase() }];
  };
  const entries = await resolveBatchPlayerNames(['alpha', 'beta', 'bad'], { search, concurrency: 2 });
  assert.ok(peak <= 2, `并发峰值 ${peak}`);
  assert.equal(entries[0].status, 'resolved');
  assert.equal(entries[1].status, 'resolved');
  assert.equal(entries[2].status, 'error');
  assert.equal(entries[2].error, '上游失败');
});

test('批量确认：排除已在篮中和重复选择，按实际新增人数校验容量', () => {
  const entry = (id, name = 'P' + id) => ({ selectedId: String(id), candidates: [{ player_id: id, player_name: name }] });
  const entries = [entry(1), entry(2), entry(2, '重复 P2'), entry(3)];
  const roomForTwo = batchSelectionState(entries, 2, id => id === '1');
  assert.deepEqual(roomForTwo.players.map(p => p.player_id), [2, 3]);
  assert.equal(roomForTwo.already, 1);
  assert.equal(roomForTwo.duplicates, 1);
  assert.equal(roomForTwo.over, false);
  assert.equal(batchSelectionState(entries, 1, id => id === '1').over, true);
});

test('prefetchPlayer：打全量 detail，在途去重、settle 后可再预热', async () => {
  const seen = [];
  globalThis.fetch = async url => { seen.push(url); return resp({ body: JSON.stringify({ player: { name: 'x' } }) }); };
  prefetchPlayer('42'); prefetchPlayer('42');   // 在途去重：只发一次
  assert.equal(seen.length, 1);
  assert.equal(seen[0], '/api/players/detail?id=42&zone=ALL');
  await new Promise(r => setTimeout(r, 0));      // 让 .finally 从在途表移除
  prefetchPlayer('42');                          // settle 后可再预热（失败/取消/LRU 淘汰后同理）
  assert.equal(seen.length, 2);
});

// —— 共享渲染原语（详情表/角色表/对比表共用，避免重复排序/格式化）——
import { kvMap, metricOf, arrowFor, sortableTh, sortRows } from '../internal/server/web/js/format.js';
import { renderCompareHTML, renderBasketHTML, inBasket, addToBasket, addManyToBasket, removeFromBasket, basketCount, compareLayerNeedsFull, sortCompare, toggleCompareRadarMetric, toggleCompareRadarPicker, resetCompareRadarMetrics, __resetBasket, __setCompareState, MAX } from '../internal/server/web/js/compare.js';

test('kvMap / metricOf：KV[]→map；取值缺失显 —、百分比补 %', () => {
  assert.deepEqual(kvMap([{ key: 'a', val: 1 }, { key: 'b', val: 2 }]), { a: 1, b: 2 });
  assert.deepEqual(kvMap(null), {});
  assert.equal(metricOf({ a: 5 }, 'a'), 5);
  assert.equal(metricOf({ a: 54 }, 'a', true), '54%');
  assert.equal(metricOf({}, 'x'), '—');
  assert.equal(metricOf(null, 'x'), '—');
});

test('arrowFor：当前排序列高亮 ▾/▴，其余列显示中性 ↕', () => {
  assert.equal(arrowFor({ key: 'a', dir: -1 }, 'a'), '<span class="sort-ind on">▾</span>');
  assert.equal(arrowFor({ key: 'a', dir: 1 }, 'a'), '<span class="sort-ind on">▴</span>');
  assert.equal(arrowFor({ key: 'a', dir: -1 }, 'b'), '<span class="sort-ind">↕</span>');
  assert.equal(arrowFor(null, 'a'), '<span class="sort-ind">↕</span>');
});

test('sortableTh：列头使用真实按钮并暴露排序方向', () => {
  const html = sortableTh('sortGames', 'total_point', '总分', { key: 'total_point', dir: -1 });
  assert.match(html, /<th class="sortable" aria-sort="descending">/);
  assert.match(html, /<button type="button" class="sort-button" onclick="sortGames\('total_point'\)">/);
  assert.doesNotMatch(html, /<th[^>]*onclick=/);
});

test('sortRows：数值列缺失恒排末（不受方向影响）；字符串列空串恒末', () => {
  const rows = [{ k: 3 }, { k: null }, { k: 1 }, { k: 8 }];
  assert.deepEqual(sortRows(rows, 'k', -1).map(r => r.k), [8, 3, 1, null]);   // 降序，缺失末
  assert.deepEqual(sortRows(rows, 'k', 1).map(r => r.k), [1, 3, 8, null]);    // 升序，缺失仍末
  const srows = [{ s: 'b' }, { s: '' }, { s: 'a' }];
  assert.deepEqual(sortRows(srows, 's', 1, 'str').map(r => r.s), ['a', 'b', '']);
  const orig = [{ k: 2 }, { k: 1 }];
  sortRows(orig, 'k', 1);
  assert.deepEqual(orig.map(r => r.k), [2, 1]);   // 不改原数组
});

// —— 对比篮 reducer（DOM 用最小桩，只验证纯粹的增删/去重/封顶逻辑）——
test('对比篮：加入/去重/封顶 12/移除', () => {
  __resetBasket();
  globalThis.document = { querySelector: () => null };   // renderBasket 取不到 #basket → 早退
  const el = (id, name) => ({ dataset: { id, name, avatar: '', sect: '' }, classList: { add() {} }, disabled: false, textContent: '' });
  assert.equal(inBasket('1'), false);
  addToBasket(el('1', '张三'));
  assert.equal(inBasket('1'), true);
  assert.equal(basketCount(), 1);
  addToBasket(el('1', '张三'));                 // 重复不加
  assert.equal(basketCount(), 1);
  for (let i = 2; i <= 15; i++) addToBasket(el(String(i), 'P' + i));
  assert.equal(basketCount(), MAX);             // 封顶 12
  removeFromBasket('1');
  assert.equal(inBasket('1'), false);
  assert.equal(basketCount(), MAX - 1);
  __resetBasket();
  delete globalThis.document;
});

test('对比篮：移除按钮包含选手名，便于识别目标', () => {
  __resetBasket();
  globalThis.document = { querySelector: () => null };
  addToBasket({ dataset: { id: '9', name: '鱼', avatar: '', sect: '' } });
  assert.match(renderBasketHTML(), /<button[^>]*class="bk-x"[^>]*aria-label="将鱼移出对比"/);
  __resetBasket();
  delete globalThis.document;
});

test('对比篮：批量加入只接收新选手并遵守 12 人上限', () => {
  __resetBasket();
  globalThis.document = { querySelector: () => null };
  assert.equal(addManyToBasket([
    { player_id: 1, player_name: '张三', sects: [{ name: '甲' }] },
    { player_id: 1, player_name: '重复张三' },
    { id: 2, name: '李四', sect: '乙' },
  ]), 2);
  assert.equal(basketCount(), 2);
  assert.equal(inBasket('1'), true);
  assert.equal(inBasket('2'), true);
  assert.equal(addManyToBasket(Array.from({ length: 20 }, (_, i) => ({ id: i + 3, name: 'P' + i }))), 10);
  assert.equal(basketCount(), MAX);
  __resetBasket();
  delete globalThis.document;
});

test('多人对比：普通概览保持浅层，按身份、同场和身份样本补充需要完整数据', () => {
  assert.equal(compareLayerNeedsFull('shallow'), false);
  assert.equal(compareLayerNeedsFull('deep'), true);
  assert.equal(compareLayerNeedsFull('shared'), true);
});

// —— 对比表纯渲染 ——
const cstate = (over = {}) => ({
  basket: [{ id: '1', name: '张三', avatar: '', sect: '甲' }, { id: '2', name: '李四', avatar: '', sect: '乙' }],
  rows: {
    '1': { head: { comprehensive: [{ key: 'round_total', val: 120 }, { key: 'win_pct', val: 58 }], good: [{ key: 'toulang_pct', val: 54 }] } },
    '2': { head: { comprehensive: [{ key: 'round_total', val: 98 }, { key: 'win_pct', val: 61 }], good: [{ key: 'toulang_pct', val: 49 }] } },
  },
  scope: { zone: 'ALL', season: '' }, layer: 'shallow', group: 'comprehensive', deepMode: 'matrix', metric: 'avg', role: '',
  sharedMode: 'summary', sharedEdition: '', sharedOrder: 'desc', sharedLimit: 10, sort: { key: '', dir: -1 }, hidden: [],
  ...over,
});

test('renderCompareHTML：空篮子提示', () => {
  assert.match(renderCompareHTML({ basket: [] }), /对比篮是空的/);
});

test('renderCompareHTML：顶层按阵营/按身份/同场对比切换 + 综合组列标签(经 fmt)/百分比/仅显示存在的列', () => {
  const html = renderCompareHTML(cstate());
  assert.match(html, /按阵营/); assert.match(html, /按身份/); assert.match(html, /同场对比/);   // 顶层切换
  assert.match(html, /张三/); assert.match(html, /李四/);
  assert.match(html, /总场次/); assert.match(html, /胜率/);         // fmt 出的中文标签
  assert.match(html, /58%/);                                         // win_pct 补 %
  assert.match(html, />120</);                                       // round_total 原值
  assert.doesNotMatch(html, /MVP次数/);                              // mvp_num 无数据 → 不成列
  assert.match(html, /<button type="button" class="qf on" aria-pressed="true" onclick="setCompareLayer\('shallow'\)">按阵营<\/button>/);
});

test('renderCompareHTML：缺失单元格显 —', () => {
  const s = cstate();
  s.rows['2'].head.comprehensive = [{ key: 'win_pct', val: 61 }];   // 李四没有 round_total
  const html = renderCompareHTML(s);
  assert.match(html, /总场次/);        // 列仍在（张三有）
  assert.match(html, /—/);             // 李四该格为 —
});

test('renderCompareHTML：点列头排序（数值降序/升序，缺失末）', () => {
  const desc = renderCompareHTML(cstate({ sort: { key: 'round_total', dir: -1 } }));
  assert.ok(desc.indexOf('张三') < desc.indexOf('李四'));   // 120 > 98
  const asc = renderCompareHTML(cstate({ sort: { key: 'round_total', dir: 1 } }));
  assert.ok(asc.indexOf('李四') < asc.indexOf('张三'));
});

test('renderCompareHTML：按阵营的 2 至 4 名可见选手显示可自定义多人雷达图', () => {
  const head = (offset) => ({
    comprehensive: [{ key: 'win_pct', val: 50 + offset }],
    good: [
      { key: 'win_pct', val: 51 + offset },
      { key: 'toulang_pct', val: 52 + offset },
      { key: 'zhanbian_pct', val: 53 + offset },
    ],
    wolf: [{ key: 'win_pct', val: 54 + offset }],
  });
  const basket = Array.from({ length: 4 }, (_, index) => ({ id: String(index + 1), name: '选手' + (index + 1), avatar: '', sect: '' }));
  const rows = Object.fromEntries(basket.map((player, index) => [player.id, { head: head(index) }]));
  const html = renderCompareHTML(cstate({ basket, rows, radarPickerOpen: true, radarSelection: DEFAULT_RADAR_METRICS }));
  assert.match(html, /多人表现雷达图/);
  assert.match(html, /选择维度 5\/7/);
  assert.equal((html.match(/class="compare-radar-shape/g) || []).length, 4);
  assert.match(html, /4\/4 人有数据/);

  assert.doesNotMatch(renderCompareHTML(cstate({ basket, rows, layer: 'deep' })), /多人表现雷达图/);
  const fifth = { id: '5', name: '选手5', avatar: '', sect: '' };
  assert.doesNotMatch(renderCompareHTML(cstate({ basket: [...basket, fifth], rows: { ...rows, '5': { head: head(4) } } })), /多人表现雷达图/);
});

test('多人对比：排序和雷达图选择操作都保留矩阵横向位置', () => {
  const previousDocument = globalThis.document;
  const before = { scrollLeft: 680 };
  const after = { scrollLeft: 0 };
  let painted = false;
  const detail = {
    querySelector(selector) {
      if (selector !== '.cmp-wrap') return null;
      return painted ? after : before;
    },
  };
  Object.defineProperty(detail, 'innerHTML', {
    get() { return this._html || ''; },
    set(html) { this._html = html; painted = true; },
  });
  const state = cstate();
  __setCompareState({
    ...state,
    custom: [],
    hidden: new Set(),
    gen: 0,
    abort: null,
  }, state.basket);
  globalThis.document = { querySelector: selector => selector === '#detail' ? detail : null };
  setView('compare');
  try {
    const actions = [
      () => sortCompare('round_total'),
      () => toggleCompareRadarPicker(),
      () => toggleCompareRadarMetric('summary.cunhuo_pct', true),
      () => resetCompareRadarMetrics(),
    ];
    actions.forEach((action, index) => {
      painted = false;
      before.scrollLeft = 680 + index;
      after.scrollLeft = 0;
      action();
      assert.equal(after.scrollLeft, 680 + index);
    });
  } finally {
    __resetBasket();
    setView('search');
    globalThis.document = previousDocument;
  }
});

test('renderCompareHTML：勾选子集——隐藏的人不出现，提示已隐藏 N 人', () => {
  const html = renderCompareHTML(cstate({ hidden: ['2'] }));
  assert.match(html, /张三/);
  assert.doesNotMatch(html, /李四/);
  assert.match(html, /已隐藏 1 人/);
});

test('renderCompareHTML：深层-按身份——身份选择器(并集) + 选中身份的多指标列，未打过该身份显 —', () => {
  const s = cstate({ layer: 'deep', deepMode: 'byrole', role: '预言家' });
  s.rows['1'].full = { roles: [{ role: '预言家', n: 10, avg: 6.2, win: 60, mvp: 3, svp: 1, bgx: 0 }] };
  s.rows['2'].full = { roles: [{ role: '女巫', n: 5, avg: 5, win: 40, mvp: 0, svp: 0, bgx: 1 }] };
  const html = renderCompareHTML(s);
  assert.match(html, /选择身份/);       // 身份选择器
  assert.match(html, /预言家/); assert.match(html, /女巫/);   // 并集
  assert.match(html, /场次/); assert.match(html, /场均分/);   // 角色多指标列
  assert.match(html, /60%/);            // 张三 预言家 胜率
  assert.match(html, /—/);              // 李四 没打过预言家 → —
});

test('renderCompareHTML：深层-人×身份矩阵——身份成列、格=选中指标、点身份列排序', () => {
  const s = cstate({ layer: 'deep', deepMode: 'matrix', metric: 'avg', sort: { key: '预言家', dir: -1 } });
  s.rows['1'].full = { roles: [{ role: '预言家', n: 10, avg: 6.8, win: 60, mvp: 3, svp: 1, bgx: 0 }, { role: '平民', n: 5, avg: 6.0, win: 50, mvp: 0, svp: 0, bgx: 0 }] };
  s.rows['2'].full = { roles: [{ role: '预言家', n: 8, avg: 5.9, win: 50, mvp: 1, svp: 0, bgx: 1 }] };
  const html = renderCompareHTML(s);
  assert.match(html, /预言家/); assert.match(html, /平民/);   // 身份成列
  assert.match(html, /6\.8/); assert.match(html, /5\.9/);      // 场均分格
  assert.ok(html.indexOf('张三') < html.indexOf('李四'));       // 按预言家场均分降序 6.8>5.9
});

test('renderCompareHTML：深层-按身份，有身份可选但未选 → 提示先选身份', () => {
  const s = cstate({ layer: 'deep', deepMode: 'byrole', role: '' });
  s.rows['1'].full = { roles: [{ role: '预言家', n: 10, avg: 6.2, win: 60, mvp: 3, svp: 1, bgx: 0 }] };
  s.rows['2'].full = { roles: [{ role: '女巫', n: 5, avg: 5, win: 40, mvp: 0, svp: 0, bgx: 1 }] };
  assert.match(renderCompareHTML(s), /选择一个身份/);
});

test('renderCompareHTML：深层-按身份，全部失败 → 显示错误（不停在“选择一个身份/加载中”）', () => {
  const s = cstate({ layer: 'deep', deepMode: 'byrole', role: '' });
  s.rows['1'] = { fullErr: '炸了' }; s.rows['2'] = { fullErr: '炸了' };
  const html = renderCompareHTML(s);
  assert.match(html, /身份数据获取失败/);
  assert.doesNotMatch(html, /选择一个身份/);
});

test('renderCompareHTML：深层-按身份，加载完成但无身份数据 → 空状态', () => {
  const s = cstate({ layer: 'deep', deepMode: 'byrole', role: '' });
  s.rows['1'] = { full: { roles: [] } }; s.rows['2'] = { full: { roles: [] } };
  const html = renderCompareHTML(s);
  assert.match(html, /暂无可用的身份数据/);
  assert.doesNotMatch(html, /选择一个身份/);
});

test('refreshSession：解析 /api/session 下发的版本号 → appVersion', async () => {
  globalThis.fetch = async () => resp({ body: JSON.stringify({ nick: 'n', exp: 1893456000, version: 'v1.2.3' }) });
  await refreshSession();
  assert.equal(appVersion(), 'v1.2.3');
});

test('renderCompareHTML：深层-数据仍在拉 → 加载中（非永久占位）', () => {
  // 默认 rows 只有 head、无 full/fullErr → 视为预热中
  const html = renderCompareHTML(cstate({ layer: 'deep', deepMode: 'matrix' }));
  assert.match(html, /正在加载身份数据/);
});

test('renderCompareHTML：深层-全部失败 → 显示错误，不再卡“加载中”', () => {
  const s = cstate({ layer: 'deep', deepMode: 'matrix' });
  s.rows['1'] = { fullErr: '炸了' }; s.rows['2'] = { fullErr: '炸了' };
  assert.match(renderCompareHTML(s), /身份数据获取失败/);
});

test('renderCompareHTML：深层-加载完成但无身份数据 → 空状态，不再卡“加载中”', () => {
  const s = cstate({ layer: 'deep', deepMode: 'matrix' });
  s.rows['1'] = { full: { roles: [] } }; s.rows['2'] = { full: { roles: [] } };
  assert.match(renderCompareHTML(s), /暂无可用的身份数据/);
});

test('renderCompareHTML：深层-HTTP200 部分降级(games_error, roles 空) → 判为失败，不误报“暂无”', () => {
  const s = cstate({ layer: 'deep', deepMode: 'matrix' });
  s.rows['1'] = { full: { roles: [], games_error: '逐场炸了' } };
  s.rows['2'] = { full: { roles: [], games_error: '逐场炸了' } };
  const html = renderCompareHTML(s);
  assert.match(html, /身份数据获取失败/);
  assert.doesNotMatch(html, /暂无可用的身份数据/);
});

test('renderCompareHTML：深层-一人失败、其余成功但空角色 → 提示部分失败，不伪装成“空”', () => {
  const s = cstate({ layer: 'deep', deepMode: 'byrole', role: '' });
  s.rows['1'] = { full: { roles: [], games_error: '逐场炸了' } };   // 失败(200 降级)
  s.rows['2'] = { full: { roles: [] } };                              // 成功但该作用域无对局
  const html = renderCompareHTML(s);
  assert.match(html, /部分选手的身份数据获取失败/);
  assert.doesNotMatch(html, /暂无可用的身份数据/);
  assert.doesNotMatch(html, /选择一个身份/);
});

// —— 布局分支 / 自定义 / 最优高亮（重设计新增）——
test('renderCompareHTML：≤4 人 → 卡片列布局，头像为矩形照片(cmpc-photo)', () => {
  const html = renderCompareHTML(cstate());
  assert.match(html, /class="cmpc cmpc-n2"/);
  assert.match(html, /cmpc-photo/);
  assert.doesNotMatch(html, /cmp-tbl/);
});

test('renderCompareHTML：少人数卡片沿用个人队徽选择，不在对比页提供选择入口', () => {
  const choices = new Map([['profile-crest:1', 'jinfeng-xiyulou'], ['profile-crest:2', 'none']]);
  globalThis.localStorage = { getItem: key => choices.get(key) || '' };
  try {
    const s = cstate({
      basket: [
        { id: '1', name: '张三', avatar: '', sect: '鱼乐会 · 金风细雨楼' },
        { id: '2', name: '李四', avatar: '', sect: '鱼乐会' },
      ],
    });
    const html = renderCompareHTML(s);
    assert.match(html, /class="cmpc-crest"[^>]*jinfeng-xiyulou-crest\.webp/);
    assert.doesNotMatch(html, /yulehui-crest\.webp/);
    assert.doesNotMatch(html, /showProfileCrestPicker|资料队徽|选择队徽/);
  } finally {
    delete globalThis.localStorage;
  }
});

test('renderCompareHTML：≥5 人 → 表格布局(cmp-tbl)，非卡片列', () => {
  const basket = [], rows = {};
  for (let i = 1; i <= 5; i++) {
    basket.push({ id: String(i), name: 'P' + i, avatar: '' });
    rows[String(i)] = { head: { comprehensive: [{ key: 'round_total', val: 100 + i }, { key: 'win_pct', val: 50 + i }] } };
  }
  const html = renderCompareHTML(cstate({ basket, rows }));
  assert.match(html, /cmp-tbl/);
  assert.doesNotMatch(html, /class="cmpc(?:\s|")/);
});

test('renderCompareHTML：自定义组——跨 好人/狼人 勾选项成行，带组前缀标签', () => {
  const s = cstate({ group: 'custom', custom: [['good', 'toulang_pct'], ['wolf', 'molang_pct']] });
  s.rows['1'].head.wolf = [{ key: 'molang_pct', val: 30 }];
  s.rows['2'].head.wolf = [{ key: 'molang_pct', val: 20 }];
  const html = renderCompareHTML(s);
  assert.match(html, /好人·投狼率/);   // 组前缀 + fmt 标签
  assert.match(html, /狼人·摸狼率/);
  assert.match(html, /自定义/);         // tab 存在
});

test('renderCompareHTML：最优高亮——只亮归一化指标(胜率/场均分取 max)，原始次数(场次/背锅)不亮', () => {
  const s = cstate({ group: 'custom', custom: [['comprehensive', 'win_pct'], ['comprehensive', 'round_point_avg'], ['comprehensive', 'round_total'], ['comprehensive', 'bgx_num']] });
  s.rows['1'].head.comprehensive = [{ key: 'win_pct', val: 58 }, { key: 'round_point_avg', val: 6.2 }, { key: 'round_total', val: 120 }, { key: 'bgx_num', val: 2 }];
  s.rows['2'].head.comprehensive = [{ key: 'win_pct', val: 61 }, { key: 'round_point_avg', val: 6.8 }, { key: 'round_total', val: 98 }, { key: 'bgx_num', val: 5 }];
  const html = renderCompareHTML(s);
  assert.match(html, /cmp-best">61%/);         // 胜率 61>58 最优
  assert.match(html, /cmp-best">6\.8/);        // 场均分 6.8>6.2 最优
  assert.doesNotMatch(html, /cmp-best">120/);  // 场次是原始次数 → 不亮
  assert.doesNotMatch(html, /cmp-best">2</);   // 背锅次数是原始次数 → 不亮
});

test('renderCompareHTML：卡片列-深层部分选手失败 → 卡头标 ⚠（不伪装成无数据）', () => {
  const s = cstate({ layer: 'deep', deepMode: 'matrix', metric: 'avg' });
  s.rows['1'] = { full: { roles: [{ role: '预言家', n: 10, avg: 6.2, win: 60 }] } };
  s.rows['2'] = { fullErr: '炸了' };
  const html = renderCompareHTML(s);
  assert.match(html, /class="cmpc cmpc-n2"/);   // 2 人 → 大图卡片列
  assert.match(html, /cmp-err/);        // 失败选手卡头 ⚠，而非只显 —
});

test('renderCompareHTML：自定义-已选指标在当前作用域无人拥有时，选择器仍保留可取消', () => {
  const s = cstate({ group: 'custom', custom: [['wolf', 'molang_pct']] });   // 篮内无人有 wolf 数据
  const html = renderCompareHTML(s);
  assert.match(html, /toggleCompareCustom\('wolf','molang_pct'\)/);   // chip 仍在，可取消勾选
  assert.match(html, /狼人·摸狼率/);                                  // 该行仍渲染（值为 —）
});

const sharedState = (over = {}) => {
  const s = cstate({ layer: 'shared', ...over });
  s.rows = {
    '1': { head: s.rows['1'].head, full: { games: [
      { game_id: 10, play_date: '2026-06-29', season_id: 28, round: 1, edition_name: '梦魇守卫', seat: 1, rpt_name: '平民', total_point: 99, win: 1 },
      { game_id: 11, play_date: '2026-06-28', season_id: 28, round: 3, edition_name: '石像鬼守墓人', seat: 7, rpt_name: '猎人', total_point: 6, win: 1, mvp: 1 },
    ] } },
    '2': { head: s.rows['2'].head, full: { games: [
      { game_id: 11, play_date: '2026-06-28', season_id: 28, round: 3, edition_name: '石像鬼守墓人', seat: 3, rpt_name: '石像鬼', total_point: 4, win: 0, bgx: 1 },
      { game_id: 12, play_date: '2026-06-27', season_id: 28, round: 2, edition_name: '狼王摄梦人', seat: 9, rpt_name: '狼', total_point: 88, win: 0 },
    ] } },
  };
  return s;
};

test('renderCompareHTML：同场表现只按 game_id 交集汇总，且使用精简核心指标', () => {
  const html = renderCompareHTML(sharedState());
  assert.match(html, /表现对比/); assert.match(html, /对局明细/);
  assert.match(html, /2 人共同参加 1 场对局/);
  assert.match(html, /class="cmpc cmpc-n2"/);       // 2～4 人沿用卡片对比，并按人数放大照片
  assert.doesNotMatch(html, /cmp-tbl/);
  assert.match(html, /总分/); assert.match(html, /场均分/); assert.match(html, /胜率/);
  assert.match(html, /cmp-best">6</);               // 唯一共同局里张三 6 分
  assert.doesNotMatch(html, />99</);                // 非共同局不参与汇总
  assert.doesNotMatch(html, />88</);
  assert.match(html, /cmp-best">0</);               // 背锅更少者高亮
});

test('renderCompareHTML：同场逐场矩阵只显示共同局，并可打开现有单局复盘', () => {
  const html = renderCompareHTML(sharedState({ sharedMode: 'games' }));
  assert.match(html, /cmp-games-tbl/); assert.match(html, /cmp-games-mobile/);
  assert.match(html, /2026-06-28/); assert.match(html, /石像鬼守墓人/);
  assert.match(html, /7号 · 猎人/); assert.match(html, /3号 · 石像鬼/);
  assert.match(html, /openGame\(11\)/);
  assert.doesNotMatch(html, /2026-06-29/); assert.doesNotMatch(html, /2026-06-27/);
});

test('renderCompareHTML：同场数据未齐时显示稳定进度，不提前展示变化中的交集', () => {
  const s = sharedState();
  delete s.rows['2'].full;
  s.rows['2'].loadingFull = true;
  const html = renderCompareHTML(s);
  assert.match(html, /正在查找共同对局/); assert.match(html, /已读取 1\/2 名选手/);
  assert.doesNotMatch(html, /共同参加 1 场/);
});

test('renderCompareHTML：同场隐藏只影响显示，不改变参与求交集的人数', () => {
  const html = renderCompareHTML(sharedState({ hidden: ['2'] }));
  assert.match(html, /仍按 2 人查找共同对局，当前隐藏 1 人/);
  assert.match(html, /2 人共同参加 1 场对局/);
  assert.doesNotMatch(html, /李四/);
});

test('renderCompareHTML：逐场截断时不把零交集误报成确定无共同对局', () => {
  const s = sharedState();
  s.rows['1'].full = { games: [{ game_id: 20 }], games_trunc: true };
  s.rows['2'].full = { games: [{ game_id: 21 }] };
  const html = renderCompareHTML(s);
  assert.match(html, /当前结果可能遗漏共同对局/);
  assert.match(html, /在已获取的数据中未找到共同对局/);
  assert.doesNotMatch(html, /所选选手没有共同参加/);
});

test('renderCompareHTML：任一选手逐场失败时不计算伪交集', () => {
  const s = sharedState();
  s.rows['2'] = { fullErr: 'upstream failed' };
  const html = renderCompareHTML(s);
  assert.match(html, /李四的逐场数据获取失败/);
  assert.match(html, /无法确认这些选手的共同对局/);
});


// 这条守卫会挡下“新加了内联入口却忘了 Object.assign(window,...)”的漏挂（如 setSearchMode 一度漏挂）。
test('index.html 内联处理器都已挂到 window', () => {
  const html = readFileSync('./internal/server/web/index.html', 'utf8');
  const main = readFileSync('./internal/server/web/js/main.js', 'utf8');
  const block = main.match(/Object\.assign\(window,\s*\{([\s\S]*?)\}\)/)[1];
  const exposed = new Set(block.split(/[\s,]+/).filter(Boolean));
  const attrs = [...html.matchAll(/\son\w+="([^"]*)"/g)].map(m => m[1]).join(';');
  const called = new Set([...attrs.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)].map(m => m[1]));
  const builtins = new Set(['if', 'for', 'while', 'return', 'event']);   // 控制流/全局，非本项目函数
  const missing = [...called].filter(n => !exposed.has(n) && !builtins.has(n));
  assert.deepEqual(missing, [], '未挂到 window 的内联处理器: ' + missing.join(', '));
});

// 上面的守卫只扫静态 index.html；各 JS 模块「动态生成的 HTML 字符串」里的内联处理器它看不到
// （如 events.js/compare.js 里 `onclick="..."` 与经 sortableTh('handler',...) 生成的排序表头）。
// 这条补扫这些文件：任一裸函数调用（排除 obj.method() 形式）或 sortableTh 的处理器名，都必须挂到 window，
// 否则点击时抛 ReferenceError（本条即挡下「新加动态处理器却忘了 Object.assign」）。
test('各 JS 模块动态生成的内联处理器都已挂到 window', () => {
  const main = readFileSync('./internal/server/web/js/main.js', 'utf8');
  const exposed = new Set(main.match(/Object\.assign\(window,\s*\{([\s\S]*?)\}\)/)[1].split(/[\s,]+/).filter(Boolean));
  const builtins = new Set(['if', 'for', 'while', 'return', 'event', 'this']);
  const missing = new Set();
  for (const f of ['ui.js', 'compare.js', 'compare-views.js', 'lineup-view.js', 'events.js', 'options.js', 'draw-tool.js']) {
    const src = readFileSync('./internal/server/web/js/' + f, 'utf8');
    for (const attr of src.matchAll(/\son\w+="([^"]*)"/g)) {
      const inline = attr[1].replace(/\$\{[^}]*\}/g, '');   // 去掉 ${...} 插值（那是生成期调用，如 esc()），只留真正的内联处理器
      for (const call of inline.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
        if (!exposed.has(call[1]) && !builtins.has(call[1])) missing.add(call[1]);
      }
    }
    for (const st of src.matchAll(/sortableTh\(\s*'([^']+)'/g)) {
      if (!exposed.has(st[1]) && !builtins.has(st[1])) missing.add(st[1]);
    }
  }
  assert.deepEqual([...missing], [], '动态 HTML 里未挂到 window 的处理器: ' + [...missing].join(', '));
});

test('首页：个人数据、赛事数据和华山工具箱同级，常用功能直接可见', () => {
  const html = readFileSync('./internal/server/web/index.html', 'utf8');
  const options = readFileSync('./internal/server/web/js/options.js', 'utf8');
  const visibleCopySources = ['ui.js', 'compare.js', 'events.js', 'options.js', 'rules.js']
    .map(file => readFileSync('./internal/server/web/js/' + file, 'utf8')).join('\n');
  assert.match(html, /狼人杀的最高境界，<br>就是修身养性。/);
  assert.match(html, /数据来自华山论剑官方 · 登录信息仅用于本次查询 · <span class="home-credit">本工具由 <b>Will<\/b> 制作 · © 2026<\/span>/);
  const choices = html.match(/<div class="home-choices">([\s\S]*?)<\/div>/)[1];
  assert.ok(choices.indexOf('个人数据') < choices.indexOf('赛事数据'));
  assert.ok(choices.indexOf('赛事数据') < choices.indexOf('华山工具箱'));
  assert.match(html, /id="tools-page"[\s\S]*id="rules-open"[\s\S]*华山规则/);
  const actions = html.match(/<section class="home-actions"[\s\S]*?<\/section>/)[0];
  for (const label of ['主题', '使用说明', '分享给朋友', '更新日志', '检查更新', '退出程序']) assert.match(actions, new RegExp(label));
  assert.equal((actions.match(/<button/g) || []).length, 6);
  assert.doesNotMatch(actions, /showFAQ\(\)|常见问题/);
  assert.match(actions, /onclick="showTheme\(\)"[\s\S]*id="theme-current-name"/);
  assert.doesNotMatch(html, /id="opt"|id="optmenu"|id="copy-token"|aria-label="功能菜单"/);
  assert.doesNotMatch(html, /不用再|后续还会|以后新增|继续扩充|官方接口|不下发到页面|本机处理/);
  assert.doesNotMatch(visibleCopySources, /不用再点右上角|不用再找右上角|工具箱会继续扩充|后续都可以放到这里|数据为打开程序时抓取的快照|已达安全上限|上方选|暂时无法计算|Bearer 前缀|在后台计算|按需加载/);
  assert.match(options, /<details id="help-token"[\s\S]*获取 Token[\s\S]*<\/details>/);
  assert.match(options, /tokenAction[\s\S]*copyLoginToken\(\)/);
});

test('cmpVer：语义化版本比较，忽略前导 v 与预发布后缀', () => {
  assert.equal(cmpVer('0.3.0', '0.2.0'), 1);
  assert.equal(cmpVer('v0.2.0', '0.2.0'), 0);
  assert.equal(cmpVer('0.2.0-beta', 'v0.2.0'), 0);   // 去后缀后相等
  assert.equal(cmpVer('0.2.1', '0.2.0'), 1);
  assert.equal(cmpVer('0.2.0', '0.10.0'), -1);       // 数值比较，非字典序
  assert.equal(cmpVer('1.0', '1.0.0'), 0);
});

test('latest：检查更新走本地 /api/latest', async () => {
  let seen;
  globalThis.fetch = async url => { seen = url; return resp({ body: JSON.stringify({ configured: true, version: '0.3.0', url: 'https://x/y', notes: 'n' }) }); };
  const d = await latest();
  assert.equal(seen, '/api/latest');
  assert.equal(d.version, '0.3.0');
});

test('shareText：分享文案包含 Windows 和 Apple Silicon Mac 链接', () => {
  const text = shareText({ url: 'https://x/legacy.exe', downloads: {
    windows_amd64: 'https://x/win.exe', mac_arm64: 'https://x/mac-arm',
  } });
  assert.match(text, /Windows：https:\/\/x\/win\.exe/);
  assert.match(text, /Mac（Apple 芯片）：https:\/\/x\/mac-arm/);
  assert.doesNotMatch(text, /legacy\.exe/);
});

test('RELEASES：当前 VERSION 有对应的程序内更新日志条目', () => {
  const version = readFileSync(new URL('../VERSION', import.meta.url), 'utf8').trim();
  assert.ok(RELEASES.some(r => r.v === version), `更新日志缺少 v${version} 条目（RELEASES 未同步 VERSION）`);
});

test('autoCheckUpdate：有新版本才静默弹窗；已最新 / 服务器错误一律不打扰、不报错', async () => {
  const about = { innerHTML: '', style: {} };
  globalThis.document = { querySelector: s => (s === '#about' ? about : null) };
  globalThis.fetch = async () => resp({ body: JSON.stringify({ nick: 'n', exp: 1893456000, version: 'v0.2.1' }) });
  await refreshSession();                       // 当前版本 = v0.2.1
  // 有新版本 → 静默弹窗
  globalThis.fetch = async () => resp({ body: JSON.stringify({ configured: true, version: '0.3.0', url: 'https://x/y.exe', notes: 'n' }) });
  about.innerHTML = '';
  await autoCheckUpdate();
  assert.match(about.innerHTML, /发现新版本 v0\.3\.0/);
  assert.match(about.innerHTML, /立即下载新版本/);
  closeAbout();
  // 已是最新 → 不弹
  globalThis.fetch = async () => resp({ body: JSON.stringify({ configured: true, version: '0.2.1' }) });
  about.innerHTML = '';
  await autoCheckUpdate();
  assert.equal(about.innerHTML, '');
  // 服务器错误 → 静默、不抛错
  globalThis.fetch = async () => resp({ ok: false, status: 500, body: '' });
  about.innerHTML = '';
  await autoCheckUpdate();
  assert.equal(about.innerHTML, '');
  // 启动竞态：当前版本尚未就绪(空) → 不把任何远端版本误判为新版
  globalThis.fetch = async () => resp({ body: JSON.stringify({ nick: 'n', exp: 1893456000 }) }); // 无 version
  await refreshSession();
  assert.equal(appVersion(), '');
  globalThis.fetch = async () => resp({ body: JSON.stringify({ configured: true, version: '9.9.9', url: 'https://x/y.exe' }) });
  about.innerHTML = '';
  await autoCheckUpdate();
  assert.equal(about.innerHTML, '');
});
