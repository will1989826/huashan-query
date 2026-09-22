// trait.js —— 详情页「特性画像」tab（桌面版）。
// T0：官方按赛区指标(V.model)套 /framework.json 出档位+同侪排名+联动（先出，第一页）。
// T2：点「自算画像」按钮进入——后台调 /api/players/trait 逐场重建聚合，加载时按钮置灰写明原因，
//      就绪可点，进入自算界面（联动+关键指标，同 applier 口径）。band5/rank_label/规则命中与离线一致。
import { esc, kvMap } from './format.js';

let FW = null;
let fwPromise = null;

export function frameworkReady() { return FW !== null; }

export function ensureFramework() {
  if (FW) return Promise.resolve(FW);
  if (!fwPromise) {
    fwPromise = fetch('framework.json')
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(j => { FW = j; return j; })
      .catch(err => { fwPromise = null; throw err; });
  }
  return fwPromise;
}

// —— T2 自算数据后台加载（按 选手|赛区 缓存）——
const T2 = {};            // key -> {status:'loading'|'ready'|'error', data, err}
let rerender = () => {};
export function setTraitRerender(fn) { rerender = fn; }

function t2Key(id, zone) { return id + '|' + (zone || 'ALL'); }

function ensureT2(id, zone) {
  const k = t2Key(id, zone);
  if (T2[k]) return T2[k];
  T2[k] = { status: 'loading' };
  fetch('api/players/trait?id=' + encodeURIComponent(id) + '&zone=' + encodeURIComponent(zone || 'ALL'))
    .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(data => { T2[k] = { status: 'ready', data }; rerender(); })
    .catch(err => { T2[k] = { status: 'error', err }; rerender(); });
  return T2[k];
}

export function reloadT2(id, zone) { delete T2[t2Key(id, zone)]; }

const CAMP_SRC = { summary_json: 'comprehensive', haoren_json: 'good', langren_json: 'wolf' };
const CAMP_ZH = { comprehensive: '综合', good: '好人', wolf: '狼人' };
const GROUP_ORDER = ['跨阵营', '好人面', '狼人面', '总体'];
const T2_GROUP_ORDER = ['跨阵营·自算', '好人面·自算', '狼人面·自算', '总体·自算'];
// 关键指标多范围表（同 applier HEAD）
const T2_HEAD = [
  ['good', 'findwolf_rate'], ['good', 'zhanbian_rate'], ['good', 'badge_seer_hit_rate'],
  ['good', 'seer_duel_win_rate'], ['good', 'survival_rate'], ['good', 'god_survival_rate'], ['good', 'badge_vote_rate'],
  ['wolf', 'survival_rate'], ['wolf', 'win_rate'], ['wolf', 'hantiao_duel_win_rate'],
  ['wolf', 'exposed_survival_rate'], ['wolf', 'charge_survival_rate'], ['wolf', 'hook_survival_rate'],
];

function num(x) {
  if (x == null) return NaN;
  const n = typeof x === 'number' ? x : parseFloat(x);
  return Number.isFinite(n) ? n : NaN;
}

function t0Value(maps, def) {
  const map = maps[CAMP_SRC[def.source]] || {};
  const rt = num(map['round_total']);
  let v = num(map[def.key]);
  if (!Number.isFinite(v) || !(rt >= 1)) return null;
  if (def.kind === 'rate') { if (rt === 0) return null; v = 100 * v / rt; }
  if (def.role_conditioned && v <= 0) return null;
  return v;
}

function band5(v, t) {
  if (v < t.p10) return '很低';
  if (v < t.p30) return '偏低';
  if (v <= t.p70) return '中等';
  if (v < t.p90) return '偏高';
  return '很高';
}

function rankLabel(v, t, deciles) {
  let b = 0;
  for (const k of deciles) if (v >= t['p' + k]) b++;
  if (b >= 5) { const lo = 100 - (b + 1) * 10, hi = 100 - b * 10; return lo <= 0 ? '前10%' : `前${lo}~${hi}%`; }
  const lo = b * 10, hi = (b + 1) * 10;
  return lo <= 0 ? '后10%' : `后${lo}~${hi}%`;
}

function confLabel(den) {
  if (den < 10) return '样本极少';
  if (den < 30) return '样本较少';
  if (den < 80) return '样本适中';
  return '样本充足';
}

// ============ T0 官方视图 ============
function renderT0(m, t2state) {
  const maps = { comprehensive: kvMap(m.comprehensive || []), good: kvMap(m.good || []), wolf: kvMap(m.wolf || []) };
  const dec = FW.deciles;
  const bands = {}, notable = { 综合: [], 好人: [], 狼人: [] };
  for (const def of FW.t0_metrics) {
    const v = t0Value(maps, def);
    if (v == null) continue;
    const band = band5(v, def);
    bands[def.label] = band;
    if (band !== '中等') {
      const short = def.label.split('·')[1] || def.label;
      notable[CAMP_ZH[def.camp]].push(`${esc(short)} ${esc(def.kind === 'raw' ? String(Math.round(v * 100) / 100) : (Math.round(v * 10) / 10) + '%')}（${esc(rankLabel(v, def, dec))}）`);
    }
  }
  const fired = [];
  for (const r of FW.t0_rules) if (r.when.every(c => (c.band_in || []).includes(bands[c.metric]))) fired.push([r.group, r.tag]);

  const dateStr = (FW.source_max_date || '').slice(0, 10) || '未知';
  const head = `
    <div class="trait-note">
      <div class="trait-testing">⚠ 特性画像为测试功能，口径仍在打磨，结论仅供参考。</div>
      <p><b>数据源</b>：华山官方公开对局，参照分布截止 ${esc(dateStr)}（共 ${esc(String(FW.source_games || '—'))} 局）。画像基于上方所选<b>赛区/赛季</b>的官方指标。</p>
      <p><b>怎么算</b>：把你的官方指标与全体选手同项分布对比，给出<b>档位</b>（很低→很高）和<b>同侪排名</b>（前/后 X%）；多项组合成<b>联动</b>解读。同名对比按同阵营分别取分布。</p>
    </div>`;

  const groups = GROUP_ORDER.map(g => {
    const tags = fired.filter(([grp]) => grp === g).map(([, tag]) => tag);
    if (!tags.length) return '';
    return `<div class="trait-group"><h4>${esc(g)}</h4>${tags.map(t => `<div class="trait-tag">▸ ${esc(t)}</div>`).join('')}</div>`;
  }).join('');
  const linkHTML = groups.trim() ? groups : '<div class="muted" style="padding:2px 0 8px">各项接近中等，暂无明显联动特征。</div>';

  const notableHTML = ['综合', '好人', '狼人'].map(t =>
    notable[t].length ? `<div class="trait-notable-row"><span class="trait-camp">${t}</span>${notable[t].join('，')}</div>` : ''
  ).join('') || '<div class="muted" style="padding:2px 0">各项接近中等。</div>';

  // 自算入口按钮：随后台加载状态变化
  let selfBtn;
  if (t2state.status === 'ready') {
    selfBtn = `<button type="button" class="trait-selfcalc ready" onclick="setTraitMode('t2')">进入自算画像 →</button><span class="trait-selfcalc-reason">已在后台完成逐场重建，点击查看自算深度指标（找狼/站对边/对跳/警徽…）。</span>`;
  } else if (t2state.status === 'error') {
    selfBtn = `<button type="button" class="trait-selfcalc" onclick="traitReload()">重试自算</button><span class="trait-selfcalc-reason">自算数据读取失败（可能场次较多或网络波动），点“重试自算”重新计算。</span>`;
  } else {
    selfBtn = `<button type="button" class="trait-selfcalc" disabled aria-disabled="true">自算画像计算中…</button><span class="trait-selfcalc-reason">正在后台逐场重建你的对局（找狼命中、站对边、第一天对跳、警徽投票等），完成前不可进入；算完此按钮会亮起。</span>`;
  }

  return `
    <div class="trait-view">
      ${head}
      <div class="sec"><h3>🔗 联动画像 <small>· 跨阵营优先</small></h3><div class="trait-links">${linkHTML}</div></div>
      <div class="sec"><h3>📊 关键指标 <small>· 只列偏离中等；同侪排名每 10% 一档</small></h3><div class="trait-notable">${notableHTML}</div></div>
      <div class="sec"><h3>🧮 自算画像 <small>· 逐场重建（深度）</small></h3><div class="trait-selfcalc-box">${selfBtn}</div></div>
    </div>`;
}

// ============ T2 自算视图（多范围 + 小样本收缩）============
// 阈值建在收缩后的值上，故排名前先收缩：smoothed=(num+baseline*prior)/(den+prior)。
function smoothVal(cell, t) {
  const p = FW.prior_weight || 0;
  return (cell.num + (t.baseline || 0) * p) / (cell.den + p);
}

function t2Thresholds() {
  const thr = {}; // scopeKey -> (mk|camp) -> row
  for (const t of FW.t2_metrics) {
    const sk = t.period_type === 'career' ? 'career|all' : t.period_type + '|' + t.period_key;
    (thr[sk] = thr[sk] || {})[t.metric_key + '|' + t.camp] = t;
  }
  return thr;
}

function renderT2(m, resp) {
  const dec = FW.deciles, thr = t2Thresholds(), minDen = FW.min_denominator || 10;
  const scopes = resp.scopes || {};
  const label = {};
  for (const t of FW.t2_metrics) label[t.metric_key] = t.label;

  // 联动：用生涯范围的收缩值定档（仅样本达门槛）
  const bands = {};
  const career = scopes['career|all'] || {};
  for (const camp of ['good', 'wolf']) {
    const mset = career[camp] || {};
    for (const mk in mset) {
      const cell = mset[mk], t = (thr['career|all'] || {})[mk + '|' + camp];
      if (!t || !cell || cell.den < minDen) continue;
      bands[mk + '|' + camp] = band5(smoothVal(cell, t), t);
    }
  }
  const fired = [];
  for (const r of FW.t2_rules) {
    if (r.when.every(c => bands[c.metric_key + '|' + c.camp] && c.band_in.includes(bands[c.metric_key + '|' + c.camp]))) fired.push([r.group, r.tag]);
  }
  const groups = T2_GROUP_ORDER.map(g => {
    const tags = fired.filter(([grp]) => grp === g).map(([, tag]) => tag);
    if (!tags.length) return '';
    return `<div class="trait-group"><h4>${esc(g)}</h4>${tags.map(t => `<div class="trait-tag">▸ ${esc(t)}</div>`).join('')}</div>`;
  }).join('');
  const linkHTML = groups.trim() ? groups : '<div class="muted" style="padding:2px 0 8px">各项接近中等，暂无明显联动特征。</div>';

  // 多范围列：生涯 / 最近50 / 最近20 / 最新自然年
  const years = Object.keys(scopes).filter(k => k.startsWith('year|')).map(k => k.slice(5)).sort().reverse();
  const cols = [['career|all', '生涯'], ['recent|50', '最近50'], ['recent|20', '最近20']];
  if (years.length) cols.push(['year|' + years[0], years[0] + '年']);

  const rows = T2_HEAD.map(([camp, mk]) => {
    const lbl = (label[mk] || mk).replace(/^自算·/, '');
    const campZh = camp === 'good' ? '好' : '狼';
    const cells = cols.map(([sk, cl]) => {
      const cell = ((scopes[sk] || {})[camp] || {})[mk], t = (thr[sk] || {})[mk + '|' + camp];
      if (!cell || cell.den <= 0 || !t) return `<span class="trait-range muted">${esc(cl)} —</span>`;
      const pct = (Math.round(cell.value * 1000) / 10) + '%';
      if (cell.den < minDen) return `<span class="trait-range small">${esc(cl)} ${esc(pct)}<i>样本少</i></span>`;   // 太少不排名
      const flag = cell.den < 30 ? '·偏少' : '';                                                                 // 偏少仍排名但标注
      return `<span class="trait-range${cell.den < 30 ? ' small' : ''}">${esc(cl)} ${esc(pct)}<i>${esc(rankLabel(smoothVal(cell, t), t, dec))}${esc(flag)}</i></span>`;
    }).join('');
    return `<div class="trait-notable-row"><span class="trait-camp">${campZh}</span><b class="trait-mlabel">${esc(lbl)}</b>${cells}</div>`;
  }).join('');

  const g = resp.games || {};
  const head = `
    <div class="trait-note">
      <div class="trait-testing">⚠ 自算画像为测试功能，逐场重建口径仍在打磨，结论仅供参考。</div>
      <p><b>怎么算</b>：把你本赛区的每一局重新推演（阵营/身份/投票/死亡），统计找狼命中、站对边、第一天对跳、警徽投票等<b>官方没有的深度指标</b>，与全体选手同项分布对比出档位与排名。样本少时向全体平均收缩，避免少数局把排名带偏。</p>
      <p><b>本次样本</b>：好人 ${esc(String(g.good || 0))} 局、狼人 ${esc(String(g.wolf || 0))} 局（本赛区）。每项右侧标注样本置信。</p>
    </div>`;

  return `
    <div class="trait-view">
      <div class="trait-backbar"><button type="button" class="qf" onclick="setTraitMode('t0')">← 返回官方画像</button></div>
      ${head}
      <div class="sec"><h3>🔗 自算联动 <small>· 跨阵营优先 · 生涯口径</small></h3><div class="trait-links">${linkHTML}</div></div>
      <div class="sec"><h3>📊 自算关键指标 <small>· 多范围 · 同侪排名每 10% 一档</small></h3><div class="trait-notable">${rows}</div></div>
    </div>`;
}

// ============ 入口 ============
export function traitHTML(m, mode) {
  if (!FW) return '<div class="muted" style="padding:16px">画像框架加载中…</div>';
  const id = (m.player && m.player.id) || '', zone = m.zone || 'ALL';
  const t2state = ensureT2(id, zone);          // 进入 tab 即后台加载自算
  if (mode === 't2' && t2state.status === 'ready') return renderT2(m, t2state.data);
  return renderT0(m, t2state);
}
