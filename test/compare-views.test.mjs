import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  renderCompareHTML, setCompareView, setCompareOverviewMetric, toggleCompareOverviewOrder,
  toggleCompareSpotlight, setCompareGroup, setCompareLayer, setCompareMetric, setCompareRole,
  setSharedMode, openCompare, addManyToBasket, rememberComparePosition, resumeCompare,
  __setCompareState, __resetBasket,
} from '../internal/server/web/js/compare.js';
import {
  compareBarScale, compareBarPosition, compareNumber, focusedCompareIDs,
  loadCompareView, saveCompareView, overviewContext,
} from '../internal/server/web/js/compare-views.js';
import { setView } from '../internal/server/web/js/view.js';

function fixture(count = 12, over = {}) {
  const basket = Array.from({ length: count }, (_, i) => ({ id: String(i + 1), name: '选手' + (i + 1), avatar: 'search-thumb.png', sect: '鱼乐会' }));
  const rows = Object.fromEntries(basket.map((p, i) => [p.id, {
    head: {
      player: { name: p.name, avatar: `portrait-${p.id}.png` },
      comprehensive: [{ key: 'round_total', val: 80 + i }, { key: 'round_point_avg', val: i - 3 }, { key: 'win_pct', val: 50 + i }, { key: 'mvp_num', val: i }],
      good: [{ key: 'win_pct', val: 60 + i }, { key: 'toulang_pct', val: 70 + i }, { key: 'zhanbian_pct', val: 60 + i }],
      wolf: [{ key: 'win_pct', val: 50 + i }],
    },
    full: { roles: [{ role: '预言家', n: 8 + i, avg: i - 2, win: 60 + i }] },
  }]));
  return {
    basket, rows, scope: { zone: 'SH', season: '29' }, layer: 'shallow', group: 'comprehensive',
    custom: [], deepMode: 'matrix', metric: 'avg', role: '', sharedMode: 'summary',
    hidden: [], sort: { key: '', dir: -1 }, compareView: 'cards', overviewChoices: {}, focusedIDs: null,
    ...over,
  };
}
const visibleIDs = html => [...html.matchAll(/data-overview-person="(\d+)"/g)].map(match => match[1]);
function metricBarWidth(html, id, metric) {
  const card = html.match(new RegExp(`data-overview-person="${id}">([\\s\\S]*?)</article>`))?.[1] || '';
  const metricHTML = card.split(`data-overview-metric="${metric}"`)[1] || '';
  return Number(metricHTML.match(/<i style="left:[^;]+;width:([^%]+)%"/)?.[1]);
}

test('comparison views preserve all 12 players, raw values and preferred profile photos', () => {
  for (const view of ['cards', 'full']) {
    const html = renderCompareHTML(fixture(12, { compareView: view }));
    assert.match(html, /data-compare-view="full"/);
    assert.match(html, new RegExp(`data-compare-view="${view}" aria-pressed="true"`));
    for (let i = 1; i <= 12; i++) assert.match(html, new RegExp(`portrait-${i}\\.png`));
    assert.doesNotMatch(html, /search-thumb/);
    assert.match(html, /-3/);
    assert.match(html, /61%/);
    if (view !== 'full') assert.equal(visibleIDs(html).length, 12);
    else assert.match(html, /class="cmp-tbl"/);
  }
  assert.match(renderCompareHTML(fixture(2, { compareView: 'full' })), /cmpc-n2/);
  const state = fixture(2);
  state.rows['1'].full.player = { avatar: 'full-portrait.png' };
  assert.match(renderCompareHTML(state), /full-portrait\.png/);
  assert.match(renderCompareHTML({ ...state, compareView: 'full' }), /full-portrait\.png/);
  assert.match(renderCompareHTML(state), /--people:2;--people-medium:2;--people-narrow:2;--people-small:2/);
});

test('bar domains handle negatives, zero, missing values and percentage scales', () => {
  const people = [{ id: 0 }, { id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
  const row = { rawFor: id => [-4, 0, 8, null, 'bad'][id], render: String };
  const scale = compareBarScale(row, people);
  assert.deepEqual(scale, { min: -4, max: 8, span: 12, percent: false });
  assert.equal(compareBarPosition(-4, scale).start, 0);
  assert.ok(Math.abs(compareBarPosition(-4, scale).width - 100 / 3) < 1e-10);
  assert.equal(compareBarPosition(0, scale).missing, false);
  assert.equal(compareBarPosition(0, scale).width, 0);
  assert.equal(compareBarPosition(null, scale).missing, true);
  for (const value of [undefined, null, '', ' ', NaN, Infinity, 'bad', false]) assert.equal(compareNumber(value), null);
  const percent = compareBarScale({ rawFor: () => 63, render: value => value + '%' }, people);
  assert.deepEqual([percent.min, percent.max], [0, 100]);
  assert.equal(compareBarPosition(63, percent).width, 63);
});

test('fixed score limits retain negative values and cap only bar length, not source values', () => {
  const row = { rawFor: id => [-4, 4, 10][id], render: String, barMax: 8 };
  const scale = compareBarScale(row, [{ id: 0 }, { id: 1 }, { id: 2 }]);
  assert.deepEqual(scale, { min: -4, max: 8, span: 12, percent: false });
  assert.equal(compareBarPosition(-4, scale).start, 0);
  const high = compareBarPosition(10, scale);
  assert.equal(high.start + high.width, 100);
  assert.equal(row.rawFor(2), 10);
  assert.equal(compareBarScale(row, []).max, 8);
});

test('camp average bars use fixed good and wolf caps and omit range text', () => {
  for (const [group, value] of [['comprehensive', 4.25], ['good', 4.25], ['wolf', 4]]) {
    const state = fixture(2, { group });
    Object.values(state.rows).forEach(row => { row.head[group] = [{ key: 'round_point_avg', val: value }]; });
    const html = renderCompareHTML(state);
    assert.equal(metricBarWidth(html, '1', 'round_point_avg'), 50);
    assert.doesNotMatch(html, /条形范围/);
  }
});

test('custom averages retain each source camp cap rather than using the custom group as a scope', () => {
  const state = fixture(2, { group: 'custom', compareView: 'focus', custom: [['good', 'round_point_avg'], ['wolf', 'round_point_avg']] });
  Object.values(state.rows).forEach(row => {
    row.head.good = [{ key: 'round_point_avg', val: 4.25 }];
    row.head.wolf = [{ key: 'round_point_avg', val: 4 }];
  });
  const html = renderCompareHTML(state);
  assert.equal(metricBarWidth(html, '1', 'good:round_point_avg'), 50);
  assert.equal(metricBarWidth(html, '1', 'wolf:round_point_avg'), 50);
});

test('identity average bars use the identity camp, including wolf-side roles without wolf in the name', () => {
  for (const [role, avg] of [['预言家', 4.25], ['狼人', 4], ['石像鬼', 4]]) {
    for (const deepMode of ['matrix', 'byrole']) {
      const state = fixture(2, { layer: 'deep', deepMode, role });
      Object.values(state.rows).forEach(row => { row.full.roles = [{ role, n: 10, avg, win: 50, mvp: 2 }]; });
      assert.equal(metricBarWidth(renderCompareHTML(state), '1', deepMode === 'matrix' ? role : 'avg'), 50);
      const rateState = { ...state, compareView: 'focus', metric: 'mvp_pct' };
      const primary = deepMode === 'matrix' ? role : 'mvp_pct';
      rateState.overviewChoices = { [overviewContext(rateState)]: { metric: primary, dir: -1 } };
      assert.equal(metricBarWidth(renderCompareHTML(rateState), '1', `support:${primary}:avg`), 50);
    }
  }
});

test('rate-support averages share the camp caps and mixed shared-game averages use 8.5', () => {
  const state = fixture(2, { compareView: 'focus', group: 'custom', custom: [['wolf', 'mvp_pct']] });
  Object.values(state.rows).forEach(row => {
    row.head.wolf = [{ key: 'round_total', val: 10 }, { key: 'mvp_num', val: 2 }, { key: 'round_point_avg', val: 4 }];
    row.full.games = [{ game_id: 1, total_point: 4.25, win: 1, mvp: 1 }];
  });
  assert.equal(metricBarWidth(renderCompareHTML(state), '1', 'support:wolf:mvp_pct:round_point_avg'), 50);
  const shared = { ...state, layer: 'shared' };
  assert.equal(metricBarWidth(renderCompareHTML(shared), '1', 'avg'), 50);
  shared.overviewChoices = { [overviewContext(shared)]: { metric: 'mvp_pct', dir: -1 } };
  assert.equal(metricBarWidth(renderCompareHTML(shared), '1', 'support:mvp_pct:avg'), 50);
});

test('above-cap averages keep original values and sort order while both bars stop at the cap', () => {
  const state = fixture(2, { group: 'wolf' });
  state.rows['1'].head.wolf = [{ key: 'round_point_avg', val: 9 }];
  state.rows['2'].head.wolf = [{ key: 'round_point_avg', val: 9.5 }];
  const html = renderCompareHTML(state);
  assert.deepEqual(visibleIDs(html), ['2', '1']);
  assert.equal(metricBarWidth(html, '1', 'round_point_avg'), 100);
  assert.equal(metricBarWidth(html, '2', 'round_point_avg'), 100);
  assert.match(html, /9\.5/);
});

test('overview retains stable ties and missing data stays last in both directions', () => {
  const state = fixture(5, { compareView: 'cards' });
  [2, 2, 0, undefined, -3].forEach((value, i) => { state.rows[i + 1].head.comprehensive[1].val = value; });
  state.rows['4'].headErr = 'Request failed';
  let html = renderCompareHTML(state);
  assert.deepEqual(visibleIDs(html), ['1', '2', '3', '5', '4']);
  assert.doesNotMatch(html, /cmp-ranking|data-compare-view="ranking"/);
  assert.match(html, /数据读取失败/);
  state.overviewChoices[overviewContext(state)] = { metric: 'round_point_avg', dir: 1 };
  html = renderCompareHTML(state);
  assert.deepEqual(visibleIDs(html), ['5', '3', '1', '2', '4']);
});

test('empty and pending metrics keep player identity visible without inventing scores', () => {
  const state = fixture(2);
  state.rows['1'] = { loadingHead: true };
  state.rows['2'] = { headErr: 'Request failed' };
  for (const view of ['cards', 'focus']) {
    const html = renderCompareHTML({ ...state, compareView: view });
    assert.match(html, /选手1/);
    assert.match(html, /读取中/);
    assert.match(html, /数据读取失败/);
    assert.doesNotMatch(html, /<b>0<\/b>/);
  }
});

test('focus selection stays separate from table sorting, hidden players and basket membership', () => {
  const state = fixture(12, { compareView: 'focus', sort: { key: 'win_pct', dir: -1 } });
  let html = renderCompareHTML(state);
  assert.deepEqual(visibleIDs(html), ['1', '2', '3', '4']);
  assert.equal((html.match(/data-spotlight-id=/g) || []).length, 12);
  assert.equal((html.match(/class="compare-radar-shape/g) || []).length, 4);
  html = renderCompareHTML({ ...state, focusedIDs: ['2', '7'], hidden: ['2'] });
  assert.deepEqual(visibleIDs(html), ['7']);
  assert.equal((html.match(/data-spotlight-id=/g) || []).length, 11);
  assert.deepEqual(focusedCompareIDs({ focusedIDs: ['1', '1', 'missing', '2'] }, state.basket), ['1', '2']);
  assert.match(renderCompareHTML({ ...state, focusedIDs: [] }), /从上方名单选择选手/);
});

test('all new views use the selected identity and the full-basket shared-game intersection', () => {
  for (const view of ['cards', 'focus']) {
    const state = fixture(12, { compareView: view, layer: 'deep', deepMode: 'byrole', role: '预言家' });
    let html = renderCompareHTML(state);
    assert.match(html, /8 场/);
    assert.match(html, /场均分/);
    assert.match(html, /-2/);
    state.layer = 'shared';
    Object.values(state.rows).forEach((row, i) => {
      row.full.games = [{ game_id: 101, total_point: 4, win: 1, mvp: i === 0 ? 1 : 0 }];
      if (i < 4) row.full.games.push({ game_id: 102, total_point: 99, win: 1 });
    });
    html = renderCompareHTML(state);
    assert.match(html, /12 人共同参加 1 场对局/);
    assert.doesNotMatch(html, /2 场对局/);
    if (view === 'focus') assert.match(html, /共同对局仍按全部已选选手计算/);
  }
});

test('overview counts do not become performance winners and names remain escaped', () => {
  const state = fixture(2, { overviewChoices: {} });
  state.basket[0].name = '<img onerror="bad">';
  state.overviewChoices[overviewContext(state)] = { metric: 'mvp_num', dir: -1 };
  const html = renderCompareHTML(state);
  const primary = html.match(/class="cmp-overview-primary">([\s\S]*?)<div class="cmp-overview-facts">/)[1];
  assert.doesNotMatch(primary, /领先|stat best/);
  assert.match(html, /&lt;img onerror=&quot;bad&quot;&gt;/);
  assert.doesNotMatch(html, /<img onerror="bad">/);
});

test('non-finite values never take the lead or hide a valid winner', () => {
  const state = fixture(3);
  state.rows['1'].head.comprehensive[1].val = Infinity;
  const html = renderCompareHTML(state);
  assert.deepEqual(visibleIDs(html), ['3', '2', '1']);
  assert.match(html, /class="cmp-overview-stat best"[^>]*><div><span>场均分<\/span><b>-1<\/b>/);
  assert.doesNotMatch(html, /领先/);
  assert.doesNotMatch(html, />Infinity</);
});

test('comparison direction control uses a compact explicit font size and keeps both sorting directions', () => {
  const css = readFileSync(new URL('../internal/server/web/compare-views.css', import.meta.url), 'utf8');
  assert.match(css, /#cmp-overview-direction\{[^}]*font-size:12px;[^}]*font-weight:500/);
  const state = fixture(2);
  assert.match(renderCompareHTML(state), /从高到低 ↓/);
  state.overviewChoices[overviewContext(state)] = { metric: 'round_point_avg', dir: 1 };
  assert.match(renderCompareHTML(state), /从低到高 ↑/);
});

test('switching views preserves scope, data, focus, independent sorting and table scroll without requests', () => {
  const previous = { document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch, localStorage: globalThis.localStorage };
  const state = fixture(12, { compareView: 'full', hidden: new Set(), gen: 0, abort: null });
  const data = state.rows;
  const wrap = { scrollLeft: 640 };
  let renderCount = 0;
  const detail = {
    _html: '',
    get innerHTML() { return this._html; },
    set innerHTML(value) { this._html = value; wrap.scrollLeft = 0; renderCount++; },
    querySelector: selector => selector === '.cmp-wrap' ? wrap : null,
  };
  const stored = new Map();
  let requests = 0;
  globalThis.document = { querySelector: selector => selector === '#detail' ? detail : null };
  globalThis.window = { scrollY: 200, scrollTo(x, y) { this.scrollY = y; } };
  globalThis.fetch = async () => { requests++; throw new Error('Unexpected request'); };
  globalThis.localStorage = { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) };
  __setCompareState(state, state.basket);
  setView('compare');
  try {
    setCompareView('cards');
    setCompareOverviewMetric('win_pct');
    toggleCompareOverviewOrder();
    const order = visibleIDs(detail.innerHTML);
    setCompareView('focus');
    toggleCompareSpotlight('5');
    assert.deepEqual(visibleIDs(detail.innerHTML), ['1', '2', '3', '4']);
    toggleCompareSpotlight('1');
    toggleCompareSpotlight('5');
    assert.deepEqual(state.focusedIDs, ['2', '3', '4', '5']);
    setCompareView('cards');
    assert.deepEqual(visibleIDs(detail.innerHTML), order);
    wrap.scrollLeft = 0;
    setCompareView('full');
    assert.equal(wrap.scrollLeft, 640);
    assert.deepEqual(state.sort, { key: '', dir: -1 });
    assert.deepEqual(state.scope, { zone: 'SH', season: '29' });
    assert.equal(state.rows, data);
    assert.equal(state.basket.length, 12);
    assert.equal(requests, 0);
    assert.equal(stored.get('compare-view'), 'full');
    state.layer = 'shared';
    setCompareView('cards');
    assert.equal(stored.get('compare-view'), 'cards');
    const rendersBeforeGames = renderCount;
    setSharedMode('games');
    assert.equal(state.compareView, 'full');
    assert.equal(state.sharedMode, 'games');
    assert.equal(stored.get('compare-view'), 'cards');
    assert.equal(renderCount, rendersBeforeGames + 1);
    setCompareView('focus');
    assert.equal(state.sharedMode, 'summary');
    assert.deepEqual(state.focusedIDs, ['2', '3', '4', '5']);
  } finally {
    __resetBasket(); setView('search');
    Object.assign(globalThis, previous);
  }
});

test('returning from a profile preserves compare scope, sorting, focus and both scroll positions without requests', () => {
  const previous = { document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch };
  const state = fixture(12, { compareView: 'full', hidden: new Set(['12']), sort: { key: 'win_pct', dir: 1 } });
  const wrap = { scrollLeft: 520 };
  const detail = { set innerHTML(value) { this.html = value; wrap.scrollLeft = 0; }, querySelector: () => wrap };
  const nav = { innerHTML: '', hidden: false };
  globalThis.document = { querySelector: selector => selector === '#detail' ? detail : selector === '#detail-navigation' ? nav : null };
  globalThis.window = { scrollY: 730, scrollTo(x, y) { this.scrollY = y; } };
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error('Unexpected request'); };
  __setCompareState(state, state.basket); setView('compare');
  try {
    rememberComparePosition();
    setView('detail');
    assert.match(nav.innerHTML, /返回对比/);
    detail.innerHTML = 'profile'; globalThis.window.scrollY = 0;
    resumeCompare();
    assert.equal(wrap.scrollLeft, 520);
    assert.equal(globalThis.window.scrollY, 730);
    assert.deepEqual(state.scope, { zone: 'SH', season: '29' });
    assert.deepEqual(state.sort, { key: 'win_pct', dir: 1 });
    assert.deepEqual([...state.hidden], ['12']);
    assert.match(detail.html, /data-compare-view="full" aria-pressed="true"/);
    assert.equal(requests, 0);
    assert.match(nav.innerHTML, /添加人员/);
  } finally {
    __resetBasket(); setView('search'); Object.assign(globalThis, previous);
  }
});

test('small full-data columns retain their horizontal scroll when switching modes', () => {
  const previous = globalThis.document;
  const state = fixture(4, { compareView: 'full', hidden: new Set() });
  const columns = { scrollLeft: 200 };
  const detail = { innerHTML: '', querySelector: selector => selector === '.cmpc' ? columns : null };
  globalThis.document = { querySelector: selector => selector === '#detail' ? detail : null };
  __setCompareState(state, state.basket);
  setView('compare');
  try {
    setCompareView('cards');
    columns.scrollLeft = 0;
    setCompareView('full');
    assert.equal(columns.scrollLeft, 200);
  } finally {
    __resetBasket(); setView('search');
    globalThis.document = previous;
  }
});

test('only interactions with stable columns preserve the current horizontal offset', () => {
  const previous = globalThis.document;
  const state = fixture(12, { compareView: 'full', hidden: new Set(), gen: 0, abort: null });
  const wrap = { scrollLeft: 480 };
  const detail = {
    _html: '',
    get innerHTML() { return this._html; },
    set innerHTML(value) { this._html = value; wrap.scrollLeft = 0; },
    querySelector: selector => selector === '.cmp-wrap' ? wrap : null,
  };
  globalThis.document = { querySelector: selector => selector === '#detail' ? detail : null };
  __setCompareState(state, state.basket);
  setView('compare');
  try {
    setCompareGroup('good');
    assert.equal(wrap.scrollLeft, 0);
    setCompareLayer('deep');
    wrap.scrollLeft = 360;
    setCompareMetric('win');
    assert.equal(wrap.scrollLeft, 360);
    setCompareRole('预言家');
    assert.equal(wrap.scrollLeft, 0);
  } finally {
    __resetBasket(); setView('search');
    globalThis.document = previous;
  }
});

test('new comparisons default to cards and remember valid choices even when storage is unavailable', async () => {
  const previous = { document: globalThis.document, localStorage: globalThis.localStorage, fetch: globalThis.fetch };
  const state = fixture(2);
  const detail = { innerHTML: '' };
  const result = { innerHTML: '' };
  const stored = new Map();
  globalThis.document = { querySelector: selector => selector === '#detail' ? detail : selector === '#results' ? result : null };
  globalThis.localStorage = { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) };
  globalThis.fetch = async () => new Response(JSON.stringify(state.rows['1'].head), { status: 200 });
  try {
    assert.equal(loadCompareView(), 'cards');
    stored.set('compare-view', 'invalid');
    assert.equal(loadCompareView(), 'cards');
    stored.set('compare-view', 'ranking');
    assert.equal(loadCompareView(), 'cards');
    for (const view of ['cards', 'focus', 'full']) {
      __resetBasket();
      saveCompareView(view);
      addManyToBasket(state.basket);
      openCompare();
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.match(detail.innerHTML, new RegExp(`data-compare-view="${view}" aria-pressed="true"`));
    }
    globalThis.localStorage = { getItem() { throw new Error('Storage unavailable'); }, setItem() { throw new Error('Storage unavailable'); } };
    assert.equal(loadCompareView(), 'cards');
    assert.doesNotThrow(() => saveCompareView('focus'));
  } finally {
    __resetBasket(); setView('search');
    Object.assign(globalThis, previous);
  }
});

test('comparison styles use theme tokens and are included in the embedded page', () => {
  const css = readFileSync(new URL('../internal/server/web/compare-views.css', import.meta.url), 'utf8');
  const page = readFileSync(new URL('../internal/server/web/index.html', import.meta.url), 'utf8');
  assert.match(page, /href="compare-views.css"/);
  assert.match(css, /\.cmp-overview-photo\[hidden\]\{display:none\}/);
  assert.match(css, /\.cmp-overview-stat\.best b\{color:var\(--gold\)\}/);
  assert.doesNotMatch(css, /\.cmp-overview-stat\.best b\{[^}]*(?:background|font-weight)/);
  assert.match(css, /\.cmp-sr-only\{/);
  assert.doesNotMatch(css, /#[\da-f]{3,8}\b|rgba?\(|hsla?\(/i);
  for (const token of ['--fg', '--sub', '--card', '--card2', '--line', '--acc', '--acc-d', '--gold', '--danger']) assert.ok(css.includes(`var(${token})`));
});

test('three comparison modes render without retaining the removed ranking mode', () => {
  const html = renderCompareHTML(fixture(5, { compareView: 'cards' }));
  assert.match(html, /data-compare-view="cards" aria-pressed="true"/);
  assert.equal((html.match(/data-compare-view=/g) || []).length, 3);
  for (const name of ['全景概览', '焦点对照', '数据详览']) assert.ok(html.includes(name));
  assert.doesNotMatch(html, /指标排行|大图卡片|重点比较|cmp-ranking/);
});
