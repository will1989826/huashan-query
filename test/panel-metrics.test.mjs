import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PANEL_RATES, panelRate, rateDescription, withPanelRates, withSummaryRates,
} from '../internal/server/web/js/panel-metrics.js';
import { fmt, kvMap } from '../internal/server/web/js/format.js';
import { renderDetailHTML, setProfileMetricDisplay, setRoleSort, __setV } from '../internal/server/web/js/ui.js';
import {
  addToBasket, renderCompareHTML, setCompareLayer, setCompareOverviewMetric, setCompareScope,
  toggleCompareCustom, toggleCompareOverviewOrder, setCompareView, __setCompareState, __resetBasket,
} from '../internal/server/web/js/compare.js';
import { overviewContext } from '../internal/server/web/js/compare-views.js';
import { setView } from '../internal/server/web/js/view.js';

const stats = (rounds, mvp, svp = 0, bgx = 0, sheriff = 0) => [
  { key: 'round_total', val: rounds }, { key: 'mvp_num', val: mvp }, { key: 'svp_num', val: svp },
  { key: 'bgx_num', val: bgx }, { key: 'jingzhang_num', val: sheriff },
];
function comparison(over = {}) {
  return {
    basket: [1, 2, 3].map(id => ({ id: String(id), name: '选手' + id })),
    rows: {
      '1': { head: { comprehensive: stats(10, 2, 1, 2, 5), good: stats(4, 2), wolf: stats(6, 0, 1, 2) } },
      '2': { head: { comprehensive: stats(100, 10, 20, 5, 40), good: stats(40, 10), wolf: stats(60, 0) } },
      '3': { head: { comprehensive: stats(0, 0), good: stats(0, 0), wolf: stats(0, 0) } },
    },
    layer: 'shallow', group: 'comprehensive', scope: { zone: 'ALL', season: '' },
    compareView: 'cards', hidden: [], sort: { key: '', dir: -1 }, custom: [],
    deepMode: 'matrix', metric: 'avg', role: '', ...over,
  };
}
function personal(over = {}) {
  return {
    id: '1', gf: {}, sort: { key: 'play_date', dir: -1 }, limit: 20, detailTab: 'overview',
    model: { player: { id: '1', name: '选手1' }, zone: 'ALL', comprehensive: stats(10, 2, 1, 0, 5), good: stats(4, 2), wolf: stats(6, 0), games: [], roles: [], editions: [] },
    ...over,
  };
}
const ids = html => [...html.matchAll(/data-overview-person="(\d+)"/g)].map(match => match[1]);
const cardHTML = (html, id) => html.match(new RegExp(`data-overview-person="${id}">([\\s\\S]*?)</article>`))?.[1] || '';
const supportingFacts = (html, id) => [...(cardHTML(html, id).split('class="cmp-overview-facts">')[1] || '').matchAll(/data-overview-metric="([^"]+)"[^>]*><div><span>([^<]+)<\/span><b>([^<]+)<\/b>/g)].map(match => [match[2], match[3]]);
const selectMetric = (state, metric) => { state.overviewChoices = { [overviewContext(state)]: { metric, dir: -1 } }; };

test('rates accept real zero but reject missing, fractional, negative or impossible counts', () => {
  assert.equal(panelRate(0, 10), 0);
  assert.equal(panelRate('3', '12'), 25);
  assert.equal(panelRate(1, 3), 100 / 3);
  for (const count of [null, undefined, '', ' ', false, 'bad', -1, 0.5, 11, Infinity]) assert.equal(panelRate(count, 10), null);
  for (const rounds of [null, undefined, '', ' ', false, 'bad', -1, 0, 0.5, Infinity]) assert.equal(panelRate(0, rounds), null);
});

test('derived rates use only the matching panel denominator and retain all raw values', () => {
  const source = stats(20, 2, 3, 1, 8);
  const original = structuredClone(source);
  const values = kvMap(withPanelRates(source));
  assert.deepEqual([values.mvp_pct, values.svp_pct, values.bgx_pct, values.jingzhang_pct], [10, 15, 5, 40]);
  assert.deepEqual(source, original);
  for (const item of original) assert.equal(values[item.key], item.val);
  assert.equal(kvMap(withPanelRates(stats(4, 2))).mvp_pct, 50);
  assert.equal(kvMap(withPanelRates([{ key: 'mvp_num', val: 2 }])).mvp_pct, undefined);
  assert.equal(kvMap(withPanelRates(stats(null, 2))).mvp_pct, null);
  assert.deepEqual(withPanelRates(null), []);
});

test('hidden and multi-action counters do not create misleading per-game probabilities', () => {
  const values = kvMap(withPanelRates([
    ...stats(10, 1), { key: 'htsp_num', val: 3 }, { key: 'zhanbian_snum', val: 24 },
    { key: 'fds_total', val: 30 }, { key: 'fds_snum', val: 15 }, { key: 'renming_num', val: 40 },
    { key: 'hantiao_total', val: 4 }, { key: 'hantiao_snum', val: 2 }, { key: 'hantiao_pct', val: 50 },
    { key: 'zidao_num', val: 2 },
  ], ['bgx_num', 'htsp_num']));
  assert.equal(values.bgx_pct, undefined);
  assert.equal(values.hantiao_pct, 50);
  assert.equal(values.fds_total, 30);
  assert.deepEqual(Object.keys(values).filter(key => key.endsWith('_pct')).sort(), ['hantiao_pct', 'jingzhang_pct', 'mvp_pct', 'svp_pct']);
});

test('existing supplied rates are not overwritten and presentation does not round raw data', () => {
  const items = [...stats(3, 1), { key: 'mvp_pct', val: 30 }];
  assert.equal(withPanelRates(items).filter(item => item.key === 'mvp_pct').length, 1);
  assert.equal(kvMap(withPanelRates(items)).mvp_pct, 30);
  const value = panelRate(1, 3);
  assert.equal(fmt('mvp_pct', value).val, '33.33%');
  assert.equal(fmt('bgx_pct', 0).val, '0%');
  assert.equal(fmt('jingzhang_pct', null).val, '—');
  assert.ok(value > 33.33);
  assert.equal(withSummaryRates({ n: 10, mvp: 2, mvp_pct: 19 }).mvp_pct, 19);
  assert.doesNotMatch(rateDescription('jingzhang_pct', true), /undefined/);
  assert.match(rateDescription('jingzhang_pct', true), /警长次数/);
});

test('summary rates use the existing row count without reading game records', () => {
  const source = { role: '预言家', n: 8, mvp: 2, svp: 1, bgx: 0 };
  const value = withSummaryRates(source);
  assert.deepEqual([value.mvp_pct, value.svp_pct, value.bgx_pct], [25, 12.5, 0]);
  assert.equal(source.mvp_pct, undefined);
  assert.equal(value.jingzhang_pct, undefined);
  assert.equal(withSummaryRates({ n: 8 }).mvp_pct, null);
});

test('numeric filter controls, state and handlers are removed from production code', () => {
  for (const file of ['js/compare.js', 'js/compare-views.js', 'js/ui.js', 'js/main.js', 'js/panel-metrics.js', 'js/options.js', 'panel-metrics.css']) {
    const source = readFileSync(new URL('../internal/server/web/' + file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /[Mm]etricFilter|panelFilters|metric-filter|数值筛选/, file);
  }
});

test('personal overview displays all four rates, their sources, and ratio-only selection', () => {
  const state = personal();
  let html = renderDetailHTML(state);
  for (const rate of PANEL_RATES) assert.match(html, new RegExp(`data-panel-metric="${rate.key}"`));
  assert.match(html, /2 次 \/ 10 场/);
  assert.match(html, /50%/);
  html = renderDetailHTML({ ...state, metricDisplay: 'ratios' });
  assert.doesNotMatch(html, /data-panel-metric="mvp_num"/);
  assert.match(html, /data-panel-metric="mvp_pct"/);
  assert.deepEqual(state.model.comprehensive, stats(10, 2, 1, 0, 5));
});

test('personal role and edition tables retain rate sorting and ignore obsolete numeric filters', () => {
  for (const tab of ['roles', 'editions']) {
    const state = personal({ detailTab: tab, [tab === 'roles' ? 'roleSort' : 'editionSort']: { key: 'mvp_pct', dir: -1 } });
    state.model[tab] = [
      { role: '狼人', edition: '版型甲', n: 100, mvp: 10, svp: 1, bgx: 0 },
      { role: '预言家', edition: '版型乙', n: 10, mvp: 2, svp: 0, bgx: 1 },
      { role: '平民', edition: '版型丙', n: 0, mvp: 0, svp: 0, bgx: 0 },
    ];
    let html = renderDetailHTML(state);
    const names = () => [...html.matchAll(/data-summary-name="([^"]+)"/g)].map(match => match[1]);
    assert.deepEqual(names(), tab === 'roles' ? ['预言家', '狼人', '平民'] : ['版型乙', '版型甲', '版型丙']);
    state.panelFilters = { [tab]: { metric: 'mvp_pct', min: '15' } };
    html = renderDetailHTML(state);
    assert.deepEqual(names(), tab === 'roles' ? ['预言家', '狼人', '平民'] : ['版型乙', '版型甲', '版型丙']);
    assert.doesNotMatch(html, /数值筛选|符合筛选|清除筛选/);
    assert.match(html, /MVP率/);
  }
});

test('comparison rates use each camp denominator and are available to custom selection', () => {
  const state = comparison({ group: 'good' });
  state.overviewChoices = { [overviewContext(state)]: { metric: 'mvp_pct', dir: -1 } };
  let html = renderCompareHTML(state);
  assert.match(html, /50%/);
  assert.match(html, /25%/);
  assert.deepEqual(ids(html), ['1', '2', '3']);
  html = renderCompareHTML({ ...state, group: 'wolf' });
  assert.doesNotMatch(html, /option value="bgx_pct"/);
  html = renderCompareHTML({ ...state, group: 'custom', custom: [['good', 'mvp_pct'], ['comprehensive', 'bgx_pct']] });
  assert.match(html, /好人·MVP率/);
  assert.match(html, /综合·背锅率/);
});

test('obsolete comparison filters do not hide players in any of the three views', () => {
  const state = comparison({ focusedIDs: ['1', '2', '3'] });
  state.metricFilters = { [overviewContext(state)]: { metric: 'mvp_pct', min: '15' } };
  for (const view of ['cards', 'focus', 'full']) {
    const html = renderCompareHTML({ ...state, compareView: view });
    assert.doesNotMatch(html, /数值筛选|符合筛选|清除筛选/);
    if (view !== 'full') assert.deepEqual(ids(html), view === 'cards' ? ['2', '1', '3'] : ['1', '2', '3']);
    else for (const person of state.basket) assert.match(html, new RegExp(person.name));
    if (view === 'focus') {
      assert.equal((html.match(/data-spotlight-id=/g) || []).length, 3);
      assert.match(html, /焦点对照 3 \/ 4 人/);
    }
  }
  assert.equal(state.basket.length, 3);
  assert.deepEqual(state.focusedIDs, ['1', '2', '3']);
  const empty = renderCompareHTML({ ...state, compareView: 'focus', focusedIDs: [] });
  assert.match(empty, /从上方名单选择选手/);
  assert.doesNotMatch(empty, /清除筛选/);
});

test('every derived rate shows its own rounds and count followed by average and win rate', () => {
  for (const view of ['cards', 'focus']) {
    for (const group of ['comprehensive', 'good', 'wolf']) {
      for (const rate of PANEL_RATES.filter(rate => group !== 'wolf' || rate.key !== 'bgx_pct')) {
        const state = comparison({ compareView: view, group });
        const source = state.rows['1'].head[group];
        source.push({ key: 'round_point_avg', val: 3.25 }, { key: 'win_pct', val: 65 });
        selectMetric(state, rate.key);
        const html = renderCompareHTML(state), raw = kvMap(source);
        assert.deepEqual(supportingFacts(html, '1'), [
          ['场次', String(raw.round_total)], [fmt(rate.count, 0).name, String(raw[rate.count])],
          ['场均分', '3.25'], ['胜率', '65%'],
        ]);
        assert.deepEqual(supportingFacts(html, '3').map(item => item[1]), ['0', '0', '—', '—']);
      }
    }
  }
});

test('custom rate-only selections obtain supporting facts and sample badge from the same camp', () => {
  const state = comparison({ group: 'custom', custom: [['good', 'svp_pct'], ['comprehensive', 'mvp_pct']] });
  state.rows['1'].head.good.push({ key: 'round_point_avg', val: -1.25 }, { key: 'win_pct', val: 25 });
  selectMetric(state, 'good:svp_pct');
  const html = renderCompareHTML(state);
  assert.deepEqual(supportingFacts(html, '1'), [
    ['好人·场次', '4'], ['好人·尽力次数', '0'], ['好人·场均分', '-1.25'], ['好人·胜率', '25%'],
  ]);
  assert.match(cardHTML(html, '1'), /class="cmp-sample">4 场/);
  assert.deepEqual(state.custom, [['good', 'svp_pct'], ['comprehensive', 'mvp_pct']]);
  assert.match(renderCompareHTML({ ...state, compareView: 'full' }), /综合·MVP率/);
});

test('role matrix and single-role cards use the selected role summary, never other roles or head totals', () => {
  for (const deepMode of ['matrix', 'byrole']) {
    const state = comparison({ layer: 'deep', deepMode, metric: 'mvp_pct', role: '预言家' });
    state.rows['1'].full = { roles: [
      { role: '狼人', n: 20, mvp: 5, avg: 5, win: 80 },
      { role: '预言家', n: 3, mvp: 1, avg: -2, win: 33 },
    ] };
    state.rows['2'].full = { roles: [{ role: '狼人', n: 40, mvp: 10, avg: 4, win: 60 }] };
    state.rows['3'].full = { roles: [] };
    selectMetric(state, deepMode === 'matrix' ? '预言家' : 'mvp_pct');
    const html = renderCompareHTML(state);
    assert.deepEqual(supportingFacts(html, '1'), [['场次', '3'], ['MVP次数', '1'], ['场均分', '-2'], ['胜率', '33%']]);
    assert.deepEqual(supportingFacts(html, '2').map(item => item[1]), ['—', '—', '—', '—']);
    assert.match(cardHTML(html, '1'), /33\.33%/);
  }
});

test('official action rates display real action denominators rather than relabeling them as games', () => {
  for (const [metric, denominator, numerator] of [
    ['zhanbian_pct', 'zhanbian_total', 'zhanbian_snum'],
    ['hantiao_pct', 'hantiao_total', 'hantiao_snum'],
    ['fds_pct', 'fds_total', 'fds_snum'],
  ]) {
    const state = comparison();
    state.rows['1'].head.comprehensive.push({ key: metric, val: 60 }, { key: denominator, val: 25 }, { key: numerator, val: 15 });
    selectMetric(state, metric);
    const html = renderCompareHTML(state);
    assert.deepEqual(supportingFacts(html, '1').slice(0, 2), [[fmt(denominator, 0).name, '25'], [fmt(numerator, 0).name, '15']]);
    assert.match(html, /不是场次/);
  }
});

test('round-based official rates use known games without rendering an unknowable count', () => {
  const state = comparison();
  state.rows['1'].head.comprehensive.push({ key: 'win_pct', val: 67 }, { key: 'cunhuo_pct', val: 60 });
  for (const metric of ['win_pct', 'cunhuo_pct']) {
    selectMetric(state, metric);
    const html = renderCompareHTML(state);
    const facts = supportingFacts(html, '1');
    assert.deepEqual(facts[0], ['场次', '10']);
    assert.ok(!facts.some(([label]) => label === (metric === 'win_pct' ? '胜场' : '存活场次')));
    assert.match(html, /当前分组场次作为分母/);
  }
});

test('other official rates without original counts remain explicitly unknown', () => {
  const state = comparison();
  state.rows['1'].head.comprehensive.push({ key: 'win_pct', val: 67 }, { key: 'toulang_pct', val: 75 });
  selectMetric(state, 'toulang_pct');
  const facts = supportingFacts(renderCompareHTML(state), '1');
  assert.deepEqual(facts.slice(0, 2), [['参考场次', '10'], ['对应次数', '—']]);
});

test('role-specific official rates show identity matches, average and win rate from full game data', () => {
  const samples = [
    ['nvyl_pct', '女巫'], ['ztfl_pct', '侦探'], ['lrql_pct', '猎人'], ['yyjyl_pct', '预言家'],
  ];
  for (const [metric, role] of samples) {
    const state = comparison({ group: 'good' });
    state.rows['1'].head.good.push({ key: metric, val: 50 });
    state.rows['1'].full = { roles: [{ role, n: 4, avg: 6.25, win: 75 }] };
    selectMetric(state, metric);
    const html = renderCompareHTML(state);
    assert.deepEqual(supportingFacts(html, '1'), [
      [`${role}场次`, '4'], [`${role}场均分`, '6.25'], [`${role}胜率`, '75%'], ['好人场次', '4'],
    ]);
    assert.match(html, /也会复用于“按身份”比较和排序/);
  }
  const custom = comparison({ group: 'custom', custom: [['good', 'nvyl_pct']] });
  custom.rows['1'].head.good.push({ key: 'nvyl_pct', val: 50 });
  custom.rows['1'].full = { roles: [{ role: '女巫', n: 4, avg: 5.5, win: 50 }] };
  custom.overviewChoices = { [overviewContext(custom)]: { metric: 'good:nvyl_pct', dir: -1 } };
  assert.deepEqual(supportingFacts(renderCompareHTML(custom), '1'), [
    ['好人·女巫场次', '4'], ['好人·女巫场均分', '5.5'], ['好人·女巫胜率', '50%'], ['好人·分组场次', '4'],
  ]);

  const degraded = comparison({ group: 'good' });
  degraded.rows['1'].head.good.push({ key: 'nvyl_pct', val: 50 });
  degraded.rows['1'].full = { roles: [], games_error: '逐场读取失败' };
  selectMetric(degraded, 'nvyl_pct');
  assert.deepEqual(supportingFacts(renderCompareHTML(degraded), '1')[0], ['女巫场次', '—']);
  assert.deepEqual(supportingFacts(renderCompareHTML(degraded), '1').map(item => item[1]), ['—', '—', '—', '4']);
  assert.match(renderCompareHTML(degraded), /完整逐场数据读取失败/);

  const mismatch = comparison({ group: 'good' });
  mismatch.rows['1'].head.good.push({ key: 'nvyl_pct', val: 50 });
  mismatch.rows['1'].full = { roles: [] };
  selectMetric(mismatch, 'nvyl_pct');
  assert.deepEqual(supportingFacts(renderCompareHTML(mismatch), '1')[0], ['女巫场次', '—']);
  assert.deepEqual(supportingFacts(renderCompareHTML(mismatch), '1').map(item => item[1]), ['—', '—', '—', '4']);
  assert.match(renderCompareHTML(mismatch), /逐场数据中未找到对应的女巫身份/);
});

test('stale role-rate preferences do not fetch full data after their column disappears', async () => {
  const previous = { document: globalThis.document, fetch: globalThis.fetch };
  const detailElement = { innerHTML: '', querySelector() { return null; } };
  const basketElement = { innerHTML: '', hidden: false };
  const urls = [];
  globalThis.document = {
    querySelector: selector => selector === '#detail' ? detailElement : selector === '#basket' ? basketElement : null,
    querySelectorAll: () => [],
  };
  globalThis.fetch = async url => {
    urls.push(String(url));
    return new Response(JSON.stringify({ good: [{ key: 'round_total', val: 4 }] }), { status: 200 });
  };
  const custom = comparison({
    group: 'custom', custom: [['good', 'nvyl_pct']], gen: 2, abort: new AbortController(),
  });
  Object.values(custom.rows).forEach(row => row.head.good.push({ key: 'nvyl_pct', val: 50 }));
  custom.overviewChoices = { [overviewContext(custom)]: { metric: 'good:nvyl_pct', dir: -1 } };
  __setCompareState(custom, custom.basket);
  setView('compare');
  try {
    toggleCompareCustom('good', 'nvyl_pct');
    addToBasket({ dataset: { id: '4', name: '选手4' } });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(urls.length, 1);
    assert.match(urls[0], /only=head/);

    const scoped = comparison({ group: 'good', gen: 7, abort: new AbortController() });
    Object.values(scoped.rows).forEach(row => row.head.good.push({ key: 'nvyl_pct', val: 50 }));
    selectMetric(scoped, 'nvyl_pct');
    __setCompareState(scoped, scoped.basket);
    urls.length = 0;
    setCompareScope('season', '30');
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(urls.length, scoped.basket.length);
    assert.ok(urls.every(url => url.includes('only=head')));
  } finally {
    custom.abort.abort();
    __resetBasket(); setView('search');
    Object.assign(globalThis, previous);
  }
});

test('selecting a role-specific rate loads full data once and reuses it for identity comparison', async () => {
  const previous = { document: globalThis.document, fetch: globalThis.fetch };
  const state = comparison({ group: 'good', gen: 4, abort: new AbortController() });
  Object.values(state.rows).forEach(row => row.head.good.push({ key: 'nvyl_pct', val: 50 }));
  const detailElement = { innerHTML: '', querySelector() { return null; } };
  let requests = 0;
  globalThis.document = { querySelector: selector => selector === '#detail' ? detailElement : null };
  globalThis.fetch = async url => {
    requests++;
    assert.doesNotMatch(String(url), /only=head/);
    return new Response(JSON.stringify({ roles: [{ role: '女巫', n: 4, avg: 6, win: 50 }] }), { status: 200 });
  };
  __setCompareState(state, state.basket);
  setView('compare');
  try {
    setCompareOverviewMetric('nvyl_pct');
    assert.match(detailElement.innerHTML, /正在读取完整逐场数据/);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(requests, state.basket.length);
    assert.match(detailElement.innerHTML, /女巫场次/);
    assert.match(detailElement.innerHTML, /女巫场均分/);
    assert.match(detailElement.innerHTML, /女巫胜率/);
    assert.match(detailElement.innerHTML, />4</);
    setCompareLayer('deep');
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(requests, state.basket.length);
    assert.match(detailElement.innerHTML, /女巫/);
  } finally {
    state.abort.abort();
    __resetBasket(); setView('search');
    Object.assign(globalThis, previous);
  }
});

test('MVP and lower burden rates have explicit highlight direction; effort and sheriff rates stay neutral', () => {
  for (const [metric, expected] of [['mvp_pct', true], ['bgx_pct', true], ['svp_pct', false], ['jingzhang_pct', false]]) {
    const state = comparison();
    state.overviewChoices = { [overviewContext(state)]: { metric, dir: -1 } };
    const html = renderCompareHTML(state);
    const primary = [...html.matchAll(/class="cmp-overview-primary">([\s\S]*?)<div class="cmp-overview-facts">/g)].map(match => match[1]);
    assert.equal(primary.some(text => text.includes('stat best')), expected);
    assert.equal(primary.some(text => text.includes('此项为最优值')), expected);
    if (metric === 'bgx_pct') assert.ok(primary.find(text => text.includes('stat best')).includes('5%'));
  }
});

test('role matrix rates use each role count; shared rates keep the whole-basket intersection', () => {
  const state = comparison({ layer: 'deep', metric: 'mvp_pct' });
  Object.values(state.rows).forEach((row, i) => {
    row.full = { roles: [{ role: '预言家', n: (i + 1) * 10, mvp: 2 }], games: [{ game_id: 1, mvp: i === 0 ? 1 : 0, total_point: 5, win: 1 }] };
    if (i < 2) row.full.games.push({ game_id: 2, mvp: 1 });
  });
  assert.match(renderCompareHTML(state), /6\.67%/);
  state.layer = 'shared'; state.sharedMode = 'summary'; state.compareView = 'focus';
  selectMetric(state, 'mvp_pct');
  state.focusedIDs = ['1', '2'];
  state.hidden = ['3'];
  const html = renderCompareHTML(state);
  assert.match(html, /3 人共同参加 1 场对局/);
  assert.deepEqual(ids(html), ['1', '2']);
  assert.match(html, /100%/);
  assert.deepEqual(supportingFacts(html, '1'), [['场次', '1'], ['MVP次数', '1'], ['场均分', '5'], ['胜率', '100%']]);
  assert.deepEqual(supportingFacts(html, '2'), [['场次', '1'], ['MVP次数', '0'], ['场均分', '5'], ['胜率', '100%']]);
});

test('rate selection, supporting facts, sorting and view switching issue no additional requests', () => {
  const previous = { document: globalThis.document, fetch: globalThis.fetch };
  const detail = { innerHTML: '', querySelector: () => null };
  globalThis.document = { querySelector: selector => selector === '#detail' ? detail : null };
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error('Unexpected request'); };
  try {
    const state = comparison({ hidden: new Set() });
    __setCompareState(state, state.basket); setView('compare');
    setCompareOverviewMetric('mvp_pct');
    assert.deepEqual(ids(detail.innerHTML), ['1', '2', '3']);
    assert.deepEqual(supportingFacts(detail.innerHTML, '1').slice(0, 2), [['场次', '10'], ['MVP次数', '2']]);
    toggleCompareOverviewOrder();
    assert.deepEqual(ids(detail.innerHTML), ['2', '1', '3']);
    setCompareView('focus'); setCompareView('full');
    assert.match(detail.innerHTML, /MVP率/);
    const person = personal(); __setV(person); setView('detail');
    setProfileMetricDisplay('ratios');
    person.detailTab = 'roles'; person.model.roles = [{ role: '预言家', n: 10, mvp: 2, svp: 0, bgx: 0 }];
    setRoleSort('mvp_pct');
    assert.match(detail.innerHTML, /20%/);
    assert.doesNotMatch(detail.innerHTML, /数值筛选/);
    assert.equal(requests, 0);
  } finally {
    __resetBasket(); __setV(null); setView('search'); Object.assign(globalThis, previous);
  }
});

test('rate controls share theme colors and both desktop stylesheets are embedded', () => {
  const css = readFileSync(new URL('../internal/server/web/panel-metrics.css', import.meta.url), 'utf8');
  const page = readFileSync(new URL('../internal/server/web/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /#[\da-f]{3,8}\b|rgba?\(|hsla?\(/i);
  assert.match(page, /href="panel-metrics.css"/);
});
