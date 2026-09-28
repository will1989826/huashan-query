// trait.js —— 详情页「特性画像」tab（桌面版）。
// T0：官方按赛区指标(V.model)套 /framework.json 出档位+全体排名+联动（先出，第一页）。
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
// 联动分组与指标分组共用同一套阵营名（跨阵营＝同时看好人与狼人的解读）。
const GROUP_ORDER = ['跨阵营', '好人', '狼人', '总体'];
// 关键项（摘要只扫这些；同 applier HEAD）。表格另把框架已建分布的其余指标按字母序补齐，见 rowMetrics。
const T2_HEAD = [
  ['good', 'findwolf_rate'], ['good', 'zhanbian_rate'], ['good', 'badge_seer_hit_rate'],
  ['good', 'seer_duel_win_rate'], ['good', 'survival_rate'], ['good', 'god_survival_rate'], ['good', 'badge_vote_rate'],
  ['wolf', 'survival_rate'], ['wolf', 'win_rate'], ['wolf', 'hantiao_duel_win_rate'],
  ['wolf', 'charge_survival_rate'], ['wolf', 'hook_survival_rate'],
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

// 档位→配色类：偏低一侧冷色、偏高一侧暖色、中等中性灰（见 styles.css --band-*，随主题适配）。
const BAND_CLS = { '很低': 'b-vlow', '偏低': 'b-low', '中等': 'b-mid', '偏高': 'b-high', '很高': 'b-vhigh' };
const bandCls = b => BAND_CLS[b] || 'b-mid';

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

// 数值格式化：raw 两位小数；pct/rate 一位小数百分比。
function fmtT0(v, kind) {
  if (v == null) return '—';
  return kind === 'raw' ? String(Math.round(v * 100) / 100) : (Math.round(v * 10) / 10) + '%';
}

// 联动标签下的贡献值行：把触发该规则的每个指标的实际数值+档位列出。
// lookup(clause) -> { name, text, band } | null
function contribHTML(when, lookup) {
  const parts = (when || []).map(lookup).filter(Boolean)
    .map(x => `${esc(x.name)} ${esc(x.text)}<em class="${bandCls(x.band)}">${esc(x.band)}</em>`);
  return parts.length ? `<div class="trait-contrib">${parts.join('，')}</div>` : '';
}

// 摘要卡片：指标名/数值/档位徽标/全体排名各归其位，避免数字和维度挤在一行。
function chipsHTML(items) {
  return `<div class="trait-chips">${items.map(x => `
    <div class="trait-chip"><span class="tc-name">${esc(x.name)}</span>
      <div class="tc-main"><b class="tc-val">${esc(x.text)}</b><span class="trait-band ${bandCls(x.band)}">${esc(x.band)}</span></div>
      <span class="tc-rank">全体 ${esc(x.rank)}</span></div>`).join('')}</div>`;
}

// ============ T0 官方视图 ============
function renderT0(m, t2state) {
  const maps = { comprehensive: kvMap(m.comprehensive || []), good: kvMap(m.good || []), wolf: kvMap(m.wolf || []) };
  const dec = FW.deciles;
  const bands = {}, vals = {}, notable = { 综合: [], 好人: [], 狼人: [] };
  // 全指标表格行（按 综合/好人/狼人 分组）；同时收集偏离中等的做摘要。
  const rowsByCamp = { 综合: [], 好人: [], 狼人: [] };
  for (const def of FW.t0_metrics) {
    const zh = CAMP_ZH[def.camp];
    const v = t0Value(maps, def);
    const short = def.label.split('·')[1] || def.label;
    if (v == null) {
      rowsByCamp[zh].push(`<tr><td class="trait-mcell">${esc(short)}</td><td>—</td><td class="rk">—</td><td class="rk">—</td></tr>`);
      continue;
    }
    const band = band5(v, def), rank = rankLabel(v, def, dec), text = fmtT0(v, def.kind);
    bands[def.label] = band;
    vals[def.label] = { name: def.label, text, band };
    rowsByCamp[zh].push(`<tr><td class="trait-mcell">${esc(short)}</td><td>${esc(text)}</td><td class="rk"><span class="${bandCls(band)}">${esc(band)}</span></td><td class="rk">${esc(rank)}</td></tr>`);
    if (band !== '中等') notable[zh].push({ name: short, text, band, rank });
  }
  const fired = [];
  for (const r of FW.t0_rules) if (r.when.every(c => (c.band_in || []).includes(bands[c.metric]))) fired.push(r);

  const dateStr = (FW.source_max_date || '').slice(0, 10) || '未知';
  const head = `
    <div class="trait-note">
      <div class="trait-testing">⚠ 特性画像为测试功能，统计方式仍在打磨，结论仅供参考。</div>
      <p><b>数据源</b>：华山官方公开对局，对比基准取自 ${esc(dateStr)} 前的 ${esc(String(FW.source_games || '—'))} 局。画像基于上方所选<b>赛区/赛季</b>的官方指标。</p>
      <p><b>怎么算</b>：把你的官方指标与全体选手同项分布对比，给出<b>档位</b>（很低→很高）和<b>全体排名</b>（前/后 X%）；多项组合成<b>联动</b>解读。同名指标按阵营分开比：你的好人胜率只和其他选手的好人胜率比。</p>
    </div>`;

  const t0lookup = c => { const x = vals[c.metric]; return x ? { name: x.name, text: x.text, band: x.band } : null; };
  const groups = GROUP_ORDER.map(g => {
    const rs = fired.filter(r => r.group === g);
    if (!rs.length) return '';
    const tags = rs.map(r => `<div class="trait-tag">▸ ${esc(r.tag)}${contribHTML(r.when, t0lookup)}</div>`).join('');
    return `<div class="trait-group"><h4>${esc(g)}</h4>${tags}</div>`;
  }).join('');
  const linkHTML = groups.trim() ? groups : '<div class="muted" style="padding:2px 0 8px">各项接近中等，暂无明显联动特征。</div>';

  const notableHTML = ['综合', '好人', '狼人'].map(t =>
    notable[t].length ? `<div class="trait-nblock"><span class="trait-camp">${t}</span>${chipsHTML(notable[t])}</div>` : ''
  ).join('') || '<div class="muted" style="padding:2px 0">各项接近中等。</div>';

  // 全指标表格（默认折叠）
  const total = FW.t0_metrics.length;
  const tbodies = ['综合', '好人', '狼人'].map(t =>
    rowsByCamp[t].length ? `<tbody><tr class="trait-tsub"><td colspan="4">${t}</td></tr>${rowsByCamp[t].join('')}</tbody>` : ''
  ).join('');
  const allHTML = `<details class="trait-more"><summary>展开全部指标（${total} 项）</summary>
    <div class="trait-tablewrap"><table class="trait-table"><thead><tr><th>指标</th><th>数值</th><th>档位</th><th>全体排名</th></tr></thead>${tbodies}</table></div></details>`;

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
      <div class="sec"><h3>🔗 联动画像 <small>· 跨阵营的解读排在前面 · 标签下列出触发它的数值</small></h3><div class="trait-links">${linkHTML}</div></div>
      <div class="sec"><h3>📊 关键指标 <small>· 摘要只列明显偏高或偏低的项；展开看全部</small></h3><div class="trait-notable">${notableHTML}</div>${allHTML}</div>
      <div class="sec"><h3>🧮 自算画像 <small>· 逐场重建出的深度指标</small></h3><div class="trait-selfcalc-box">${selfBtn}</div></div>
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

  // 联动：用最近100(自算封顶=最宽窗口)的收缩值定档（仅样本达门槛）
  const bands = {}, wideVals = {};
  const wide = scopes['recent|100'] || {};
  for (const camp of ['good', 'wolf']) {
    const mset = wide[camp] || {};
    for (const mk in mset) {
      const cell = mset[mk], t = (thr['recent|100'] || {})[mk + '|' + camp];
      if (!t || !cell || cell.den < minDen) continue;
      const sv = smoothVal(cell, t), band = band5(sv, t), rank = rankLabel(sv, t, dec);
      bands[mk + '|' + camp] = band;
      const lbl = (label[mk] || mk).replace(/^自算·/, '');
      wideVals[mk + '|' + camp] = { name: (camp === 'good' ? '好·' : '狼·') + lbl, text: (Math.round(cell.value * 1000) / 10) + '%', band, rank };
    }
  }
  const fired = [];
  for (const r of FW.t2_rules) {
    if (r.when.every(c => bands[c.metric_key + '|' + c.camp] && c.band_in.includes(bands[c.metric_key + '|' + c.camp]))) fired.push(r);
  }
  const t2lookup = c => wideVals[c.metric_key + '|' + c.camp] || null;
  const groups = GROUP_ORDER.map(g => {
    const rs = fired.filter(r => r.group === g);
    if (!rs.length) return '';
    const tags = rs.map(r => `<div class="trait-tag">▸ ${esc(r.tag)}${contribHTML(r.when, t2lookup)}</div>`).join('');
    return `<div class="trait-group"><h4>${esc(g)}</h4>${tags}</div>`;
  }).join('');
  const linkHTML = groups.trim() ? groups : '<div class="muted" style="padding:2px 0 8px">各项接近中等，暂无明显联动特征。</div>';

  // 摘要：最近100场口径下偏离中等的项（与联动定档同源）
  const notable = { 好人: [], 狼人: [] };
  for (const [camp, mk] of T2_HEAD) {
    const v = wideVals[mk + '|' + camp];
    if (v && v.band !== '中等') notable[camp === 'good' ? '好人' : '狼人'].push({ name: (label[mk] || mk).replace(/^自算·/, ''), text: v.text, band: v.band, rank: v.rank });
  }
  const notableHTML = ['好人', '狼人'].map(t =>
    notable[t].length ? `<div class="trait-nblock"><span class="trait-camp">${t}</span>${chipsHTML(notable[t])}</div>` : ''
  ).join('') || '<div class="muted" style="padding:2px 0">最近100场各项接近中等。</div>';

  // 多范围列：最近20 / 最近50 / 最近100 / 当年 / 去年(最新两个自然年)
  const years = Object.keys(scopes).filter(k => k.startsWith('year|')).map(k => k.slice(5)).sort().reverse();
  const cols = [['recent|20', '最近20场'], ['recent|50', '最近50场'], ['recent|100', '最近100场']];
  if (years[0]) cols.push(['year|' + years[0], years[0] + '年']);
  if (years[1]) cols.push(['year|' + years[1], years[1] + '年']);

  // 全指标表格：行=指标(好/狼分组)，列=各范围，单元格=数值%(上)+全体排名(下)。
  // 行取“关键项在前 + 框架已建分布的其余项按字母序补齐”：每项框架都有 recent|100 行，以此为准，
  // 之后给框架新增指标，表格自动带出，前端不用维护清单。
  const rowMetrics = camp => {
    const keyed = T2_HEAD.filter(([c]) => c === camp).map(([, mk]) => mk);
    const extra = Object.keys(thr['recent|100'] || {})
      .filter(k => k.endsWith('|' + camp))
      .map(k => k.split('|')[0])
      .filter(mk => !keyed.includes(mk))
      .sort();
    return keyed.concat(extra);
  };
  const cell2 = (camp, mk, sk) => {
    const cell = ((scopes[sk] || {})[camp] || {})[mk], t = (thr[sk] || {})[mk + '|' + camp];
    if (!cell || cell.den <= 0 || !t) return '<td class="rk">—</td>';
    const pct = (Math.round(cell.value * 1000) / 10) + '%';
    if (cell.den < minDen) return `<td class="small">${esc(pct)}<span class="rk">样本少，不排名</span></td>`;   // 太少不排名
    const flag = cell.den < 30 ? '（样本偏少）' : '';                                                        // 偏少仍排名但标注
    const sv = smoothVal(cell, t), bcls = bandCls(band5(sv, t));                                        // 排名按档位着色
    return `<td${cell.den < 30 ? ' class="small"' : ''}>${esc(pct)}<span class="rk ${bcls}">${esc(rankLabel(sv, t, dec))}${esc(flag)}</span></td>`;
  };
  const bodyRows = camp => rowMetrics(camp).map(mk => {
    const lbl = (label[mk] || mk).replace(/^自算·/, '');
    return `<tr><td class="trait-mcell">${esc(lbl)}</td>${cols.map(([sk]) => cell2(camp, mk, sk)).join('')}</tr>`;
  }).join('');
  const th = `<thead><tr><th>指标</th>${cols.map(([, cl]) => `<th>${esc(cl)}</th>`).join('')}</tr></thead>`;
  const total = rowMetrics('good').length + rowMetrics('wolf').length;
  const rowsHTML = `<details class="trait-more"><summary>展开全部指标（${total} 项）</summary>
    <div class="trait-tablewrap"><table class="trait-table"><colgroup><col class="trait-mcol"></colgroup>${th}
    <tbody><tr class="trait-tsub"><td colspan="${cols.length + 1}">好人</td></tr>${bodyRows('good')}</tbody>
    <tbody><tr class="trait-tsub"><td colspan="${cols.length + 1}">狼人</td></tr>${bodyRows('wolf')}</tbody></table></div></details>`;

  const g = resp.games || {};
  const head = `
    <div class="trait-note">
      <div class="trait-testing">⚠ 自算画像为测试功能，逐场重建的统计方式仍在打磨，结论仅供参考。</div>
      <p><b>怎么算</b>：把你本赛区<b>最近约100场</b>逐局重新推演（阵营/身份/投票/死亡），统计找狼命中、站对边、第一天对跳、警徽投票等深度指标，再与全体选手同项分布对比出档位与排名。其中胜率、存活率、站对边率等与官方同名的项按逐场重新计算，分母与官方汇总不同，数值不会一致。样本少时向全体平均值靠拢，避免少数局把排名带偏。</p>
      <p><b>本次样本</b>：好人 ${esc(String(g.good || 0))} 局、狼人 ${esc(String(g.wolf || 0))} 局（取最近约100场）。场次多的选手也只算最近100场，避免等待过久；每项样本少会标注。</p>
    </div>`;

  return `
    <div class="trait-view">
      <div class="trait-backbar"><button type="button" class="qf" onclick="setTraitMode('t0')">← 返回官方画像</button></div>
      ${head}
      <div class="sec"><h3>🔗 自算联动 <small>· 跨阵营的解读排在前面 · 按最近100场定档 · 标签下列出触发它的数值</small></h3><div class="trait-links">${linkHTML}</div></div>
      <div class="sec"><h3>📊 自算关键指标 <small>· 摘要只列最近100场明显偏高或偏低的关键项；展开看全部指标和各范围</small></h3><div class="trait-notable">${notableHTML}</div>${rowsHTML}</div>
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
