import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LINEUP_EDITIONS, newLineup, changeLineupEdition, assignSeat, assignSeatsInOrder, hasCompleteSeats, setLineupSeatOrder, assignRole, clearLineup } from '../internal/server/web/js/lineup.js';
import { identityMetrics, identityMetricResult } from '../internal/server/web/js/identity-metrics.js';
import * as compare from '../internal/server/web/js/compare.js';
import { setView } from '../internal/server/web/js/view.js';

const ids = Array.from({ length: 12 }, (_, i) => String(i + 1));
const players = ids.map(id => ({ id, name: `选手${id}` }));
const base = () => changeLineupEdition(newLineup(), 'edition-basic');
const kv = values => Object.entries(values).map(([key, val]) => ({ key, val }));

test('ordinary comparison preloads through one four-person queue and isolates failures and scope changes', async () => {
  const old = { document: globalThis.document, fetch: globalThis.fetch };
  const detail = { innerHTML: '', querySelector: () => null };
  globalThis.document = { querySelector: () => detail, querySelectorAll: () => [] };
  const requests = [];
  globalThis.fetch = (url, options) => new Promise(resolve => {
    requests.push({ params: new URL(url, 'http://localhost').searchParams, signal: options.signal, resolve, done: false });
  });
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const finish = (request, failed = false) => {
    request.done = true;
    request.resolve(new Response(JSON.stringify(failed ? { error: { message: 'Unavailable' } } : { roles: [], marker: request.params.get('season') || 'old' }), { status: failed ? 503 : 200 }));
  };
  const full = () => requests.filter(request => !request.params.has('only'));
  const state = { rows: {}, hidden: new Set(), custom: [], scope: { zone: 'ALL', season: '' }, sort: {}, layer: 'shallow', group: 'good', compareView: 'cards', gen: 0, abort: null };
  try {
    compare.__setCompareState(state, players.slice(0, 6));
    compare.openCompare();
    assert.equal(full().length, 4);
    assert.match(detail.innerHTML, /深层数据加载中，已完成 0\/6/);
    compare.addManyToBasket(players.slice(6, 8));
    compare.addToBasket({ dataset: players[8] });
    compare.setCompareLayer('deep'); compare.openCompare();
    assert.equal(full().length, 4);
    assert.equal(requests.filter(request => request.params.has('only')).length, 9);
    finish(full()[0], true); await flush();
    assert.equal(full().length, 5);
    for (const request of requests.filter(request => request.params.has('only'))) finish(request);
    await flush();
    assert.equal(full().filter(request => request.params.get('id') === '1').length, 1);
    while (full().some(request => !request.done)) {
      assert.ok(full().filter(request => !request.done).length <= 4);
      for (const request of full().filter(request => !request.done)) finish(request);
      await flush();
    }
    assert.equal(full().length, 9);
    assert.match(detail.innerHTML, /1 人读取失败/);
    compare.setCompareLayer('shallow');
    assert.equal(full().length, 9);
    compare.retryLineupData();
    assert.equal(full().length, 10);
    finish(full().at(-1)); await flush();
    assert.match(detail.innerHTML, /深层数据已就绪 9\/9/);
    compare.setCompareScope('season', '30');
    const oldScope = requests.filter(request => !request.done);
    compare.setCompareScope('season', '31');
    assert.ok(oldScope.every(request => request.signal.aborted));
    for (const request of oldScope) finish(request);
    await flush();
    assert.ok(Object.values(state.rows).every(row => !row.head && !row.full));
    while (requests.some(request => !request.done)) {
      for (const request of requests.filter(request => !request.done)) finish(request);
      await flush();
    }
    assert.ok(Object.values(state.rows).every(row => row.head.marker === '31' && row.full.marker === '31'));
  } finally {
    state.abort?.abort(); compare.__resetBasket(); setView('search'); Object.assign(globalThis, old);
  }
});

test('all seven rulebook editions contain twelve cards, four wolves and eight good players', () => {
  assert.equal(LINEUP_EDITIONS.length, 7);
  for (const edition of LINEUP_EDITIONS) {
    assert.equal(edition.roles.reduce((total, role) => total + role.count, 0), 12);
    assert.equal(edition.roles.find(role => role.role === '平民').count, 4);
    assert.equal(edition.roles.filter(role => role.count === 1).length, edition.id === 'edition-basic' ? 4 : 5);
    let lineup = changeLineupEdition(newLineup(), edition.id), cursor = 0;
    for (const { role, count } of edition.roles) {
      for (let i = 0; i < count; i++) lineup = assignRole(lineup, ids, ids[cursor++], role);
    }
    assert.equal(Object.keys(lineup.roles).length, 12);
  }
});

test('seat edits swap occupied seats and reject invalid numbers or unknown players', () => {
  let lineup = base();
  for (const id of ids) lineup = assignSeat(lineup, ids, id, Number(id));
  lineup = assignSeat(lineup, ids, '1', 2);
  assert.equal(lineup.seats['1'], 2); assert.equal(lineup.seats['2'], 1);
  assert.equal(new Set(Object.values(lineup.seats)).size, 12);
  for (const value of [-1, 13, 1.5, NaN]) assert.equal(assignSeat(lineup, ids, '1', value), lineup);
  assert.equal(assignSeat(lineup, ids, 'unknown', 2), lineup);
  lineup = assignSeat(lineup, ids, '1', 0);
  assert.equal(lineup.seats['1'], undefined);
  lineup = assignSeat(lineup, ids, '1', 1);
  assert.equal(lineup.seats['2'], undefined);
});

test('seats can be issued in roster order and displayed in complete seat order', () => {
  const issued = assignSeatsInOrder(base(), ids);
  assert.deepEqual(issued.seats, Object.fromEntries(ids.map((id, index) => [id, index + 1])));
  assert.equal(issued.seatOrder, false);
  assert.equal(hasCompleteSeats(issued, ids), true);
  const ordered = setLineupSeatOrder(issued, ids, true);
  assert.equal(ordered.seatOrder, true);
  assert.equal(clearLineup(ordered, 'seats').seatOrder, false);
  assert.equal(setLineupSeatOrder(assignSeat(issued, ids, '1', 0), ids, true).seatOrder, false);
});

test('unique identities swap, ordinary wolves and civilians enforce their roster capacities', () => {
  let lineup = assignRole(base(), ids, '1', '预言家');
  lineup = assignRole(lineup, ids, '2', '女巫');
  lineup = assignRole(lineup, ids, '2', '预言家');
  assert.equal(lineup.roles['1'], '女巫'); assert.equal(lineup.roles['2'], '预言家');
  for (const id of ['3', '4', '5', '6']) lineup = assignRole(lineup, ids, id, '狼');
  assert.deepEqual(assignRole(lineup, ids, '7', '狼').roles, lineup.roles);
  assert.equal(assignRole(lineup, ids, '7', '梦魇'), lineup);
  lineup = assignRole(lineup, ids, '7', '预言家');
  assert.equal(lineup.roles['2'], undefined);
  assert.equal(lineup.roles['7'], '预言家');
});

test('edition changes and independent clears preserve the other assignments', () => {
  let lineup = assignSeat(assignRole(base(), ids, '1', '女巫'), ids, '1', 7);
  assert.equal(changeLineupEdition(lineup, lineup.edition), lineup);
  assert.equal(changeLineupEdition(lineup, 'invalid'), lineup);
  const changed = changeLineupEdition(lineup, 'edition-detective');
  assert.deepEqual(changed.roles, {}); assert.deepEqual(changed.seats, { 1: 7 });
  assert.deepEqual(clearLineup(lineup, 'roles').seats, lineup.seats);
  assert.deepEqual(clearLineup(lineup, 'seats').roles, lineup.roles);
});

test('identity values prefer real zero and own metrics, then use only the matching camp', () => {
  const data = { head: { good: kv({ round_total: 20, round_point_avg: 6, win_pct: 60, toulang_pct: 75, nvyl_pct: 80 }),
    wolf: kv({ round_total: 10, round_point_avg: 4, hantiao_total: 5, hantiao_pct: 40 }) },
    full: { roles: [{ role: '女巫', n: 3, avg: 0, win: 0, toulang_pct: 90 }, { role: '狼人', n: 2, avg: 3 }] } };
  assert.deepEqual(identityMetricResult(data, '女巫', 'avg'), { value: 0, source: '女巫' });
  assert.deepEqual(identityMetricResult(data, '女巫', 'toulang_pct'), { value: 90, source: '女巫' });
  assert.deepEqual(identityMetricResult(data, '女巫', 'nvyl_pct'), { value: 80, source: '女巫', fallback: false });
  assert.deepEqual(identityMetricResult(data, '猎人', 'avg'), { value: 6, source: '好人整体', fallback: true });
  assert.deepEqual(identityMetricResult(data, '梦魇', 'avg'), { value: 4, source: '狼人整体', fallback: true });
  assert.deepEqual(identityMetricResult(data, '狼', 'n'), { value: 2, source: '狼' });
  assert.deepEqual(identityMetricResult(data, '猎人', 'lrql_pct'), {});
  assert.deepEqual(identityMetricResult(data, '女巫', 'hantiao_pct'), {});
  data.full.games_error = 'Unavailable';
  assert.deepEqual(identityMetricResult(data, '女巫', 'avg'), { value: 6, source: '好人整体', fallback: true });
});

test('related skill metrics never leak into other identities or create unsupported skill rates', () => {
  for (const [role, key] of [['女巫', 'nvyl_pct'], ['猎人', 'lrql_pct'], ['预言家', 'yyjyl_pct'], ['侦探', 'ztfl_pct']]) {
    const metrics = identityMetrics(role);
    assert.ok(metrics.some(item => item.key === key));
    assert.ok(metrics.some(item => item.key === 'toulang_pct'));
    assert.ok(!metrics.some(item => item.key === 'hantiao_pct'));
  }
  for (const role of ['狼', '梦魇', '石像鬼', '血月使徒']) {
    assert.ok(identityMetrics(role).some(item => item.key === 'hantiao_total'));
    assert.ok(!identityMetrics(role).some(item => item.key === 'toulang_pct'));
  }
  assert.equal(identityMetrics('守卫').filter(item => item.skill).length, 0);
});

test('single-role comparison can show camp fallback even when nobody has played the selected identity', () => {
  const state = { basket: players.slice(0, 2), rows: { 1: { head: { good: kv({ round_total: 20, round_point_avg: 5, win_pct: 50, toulang_pct: 80 }) }, full: { roles: [] } },
    2: { head: { good: kv({ round_total: 10, round_point_avg: 6, win_pct: 60 }) }, full: { roles: [] } } },
    hidden: [], scope: { zone: 'ALL', season: '' }, sort: {}, layer: 'deep', deepMode: 'byrole', role: '守卫', compareView: 'cards' };
  const html = compare.renderCompareHTML(state);
  assert.match(html, /守卫 · 场均分/);
  assert.match(html, /identity-source">好人整体/);
  assert.match(html, /投狼率/);
  assert.doesNotMatch(html, /该赛区 \/ 赛季内暂无可用的身份数据/);
});

test('four-character lineup identities use a compact single-line presentation', () => {
  const edition = LINEUP_EDITIONS.find(item => item.roles.some(({ role }) => role === '怪盗狼王'));
  assert.ok(edition);
  const lineup = assignRole(changeLineupEdition(newLineup(), edition.id), ids, '1', '怪盗狼王');
  const html = compare.renderCompareHTML({ basket: players, lineupOpen: true, lineup, rows: {}, scope: { zone: 'ALL', season: '' } });
  assert.match(html, /lineup-role-result assigned long-role[^>]*>[\s\S]*?<strong>怪盗狼王<\/strong>/);
});

test('12-person screen reuses data, preserves assignments across profile returns and releases removed players', () => {
  const old = { document: globalThis.document, fetch: globalThis.fetch };
  const detail = { innerHTML: '', querySelector: () => null };
  let requests = 0;
  globalThis.document = { querySelector: selector => selector === '#detail' ? detail : null, querySelectorAll: () => [] };
  globalThis.fetch = async () => { requests++; throw new Error('Unexpected request'); };
  const state = { basket: players, rows: Object.fromEntries(ids.map(id => [id, { head: { good: kv({ round_total: 10, toulang_pct: 80 }), wolf: kv({ hantiao_total: 4 }) }, full: { roles: [{ role: '女巫', n: 2, avg: 6, win: 50 }] } }])),
    hidden: new Set(), custom: [], scope: { zone: 'ALL', season: '' }, sort: {}, layer: 'shallow', group: 'good', compareView: 'cards', gen: 1, abort: new AbortController() };
  try {
    compare.__setCompareState(state, players); setView('compare'); compare.openLineup();
    assert.match(detail.innerHTML, /12 人号码与身份/);
    assert.match(detail.innerHTML, /身份数据已就绪 12\/12/);
    compare.setLineupEdition('edition-basic');
    compare.setLineupSeat('3', 1); compare.setLineupSeat('1', 2);
    assert.deepEqual(state.lineup.seats, { 3: 1, 1: 2 });
    assert.match(detail.innerHTML, /按顺序发号码/);
    assert.match(detail.innerHTML, /toggleLineupSeatOrder\(\)" disabled>按号码排列座次/);
    compare.assignLineupSeatsInOrder();
    assert.equal(state.lineup.seats['1'], 1); assert.equal(state.lineup.seats['12'], 12);
    compare.setLineupSeat('3', 1);
    compare.toggleLineupSeatOrder();
    assert.ok(detail.innerHTML.indexOf('data-lineup-player="3"') < detail.innerHTML.indexOf('data-lineup-player="1"'));
    compare.toggleLineupSeatOrder();
    assert.ok(detail.innerHTML.indexOf('data-lineup-player="1"') < detail.innerHTML.indexOf('data-lineup-player="3"'));
    compare.setLineupRole('3', '女巫');
    assert.equal(state.lineup.roles['3'], '女巫');
    assert.match(detail.innerHTML, /女巫毒狼率/);
    // 回退到阵营整体数据的指标必须标注来源；身份自有数据不标注。
    assert.match(detail.innerHTML, /<dd>80%<\/dd><small class="identity-source">好人整体<\/small>/);
    assert.doesNotMatch(detail.innerHTML, /<dd>2<\/dd><small/);
    assert.match(detail.innerHTML, /lineup-seat assigned/);
    assert.match(detail.innerHTML, /lineup-identity assigned/);
    assert.match(detail.innerHTML, /lineup-card-actions[^>]*><label[^>]*>改号码/);
    assert.match(detail.innerHTML, /改身份<select data-lineup-control/);
    compare.setLineupRole('3', '狼');
    assert.match(detail.innerHTML, /lineup-card lineup-wolf[^>]*data-lineup-player="3"/);
    compare.setLineupRole('3', '女巫');
    assert.doesNotMatch(detail.innerHTML, /paintLineup|发身份|补齐剩余身份|lineup-palette/);
    assert.equal(compare.paintLineup, undefined);
    compare.closeLineup(); compare.openLineup();
    setView('detail'); compare.resumeCompare();
    assert.equal(state.lineup.roles['3'], '女巫');
    compare.setLineupEdition('edition-detective');
    assert.deepEqual(state.lineup.roles, {}); assert.equal(state.lineup.seats['3'], 1);
    compare.removeFromBasket('3');
    assert.equal(state.lineupOpen, false); assert.equal(state.lineup.seats['3'], undefined);
    assert.match(detail.innerHTML, /onclick="openLineup\(\)" disabled/);
    assert.equal(requests, 0);
  } finally {
    state.abort.abort(); compare.__resetBasket(); setView('search'); Object.assign(globalThis, old);
  }
});

test('background data completion waits for an open lineup selector to close before repainting', async () => {
  const old = { document: globalThis.document, fetch: globalThis.fetch };
  let blur;
  const active = {
    tagName: 'SELECT',
    getAttribute: name => name === 'data-lineup-control' ? '' : name === 'aria-label' ? '选手1的号码' : null,
    addEventListener: (name, handler) => { if (name === 'blur') blur = handler; },
  };
  const detail = { innerHTML: '', contains: element => element === active, querySelector: () => null };
  const requests = [];
  globalThis.document = { activeElement: null, querySelector: selector => selector === '#detail' ? detail : null, querySelectorAll: () => [] };
  globalThis.fetch = (url, options) => new Promise(resolve => requests.push({ url, options, resolve }));
  const state = { basket: players, rows: Object.fromEntries(ids.map(id => [id, { head: { good: [], wolf: [] } }])),
    hidden: new Set(), custom: [], scope: { zone: 'ALL', season: '' }, sort: {}, layer: 'shallow', group: 'good', compareView: 'cards', gen: 1, abort: new AbortController() };
  try {
    compare.__setCompareState(state, players); setView('compare'); compare.openLineup();
    globalThis.document.activeElement = active;
    const before = detail.innerHTML;
    requests[0].resolve(new Response(JSON.stringify({ roles: [] }), { status: 200 }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(detail.innerHTML, before);
    assert.equal(typeof blur, 'function');
    globalThis.document.activeElement = null;
    blur();
    assert.notEqual(detail.innerHTML, before);
    assert.match(detail.innerHTML, /身份数据加载中，已完成 1\/12/);
  } finally {
    state.abort.abort(); compare.__resetBasket(); setView('search'); Object.assign(globalThis, old);
  }
});

test('lineup loading progress stays visible before identities are assigned and distinguishes failed records', () => {
  const state = { basket: players, lineupOpen: true, lineup: base(), rows: Object.fromEntries(ids.slice(0, 4).map(id => [id, { full: { roles: [] } }])) };
  assert.match(compare.renderCompareHTML(state), /身份数据加载中，已完成 4\/12/);
  state.rows['5'] = { fullErr: 'Unavailable' };
  assert.match(compare.renderCompareHTML(state), /身份数据加载中，已完成 5\/12 · 1 人读取失败/);
  for (const id of ids.slice(5)) state.rows[id] = { full: { roles: [] } };
  const html = compare.renderCompareHTML(state);
  assert.match(html, /身份数据读取完成，1 人读取失败/);
  assert.match(html, /重试缺失数据/);
  assert.doesNotMatch(html, /身份数据已就绪/);
});
