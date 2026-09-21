// trait.js —— 详情页「特性画像」tab（桌面版）。读官方按赛区 T0 值（V.model 的 综合/好人/狼人），
// 套 /framework.json 的同侪阈值 + 联动规则，输出档位(很低→很高)+同侪排名(前/后X%)+联动解读。
// 与离线 research/applier.py 同口径（band5/rank_label/规则命中）。自算 T2 需后台逐场重建，暂置灰。
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

const CAMP_SRC = { summary_json: 'comprehensive', haoren_json: 'good', langren_json: 'wolf' };
const CAMP_ZH = { comprehensive: '综合', good: '好人', wolf: '狼人' };
const GROUP_ORDER = ['跨阵营', '好人面', '狼人面', '总体'];

function num(x) {
  if (x == null) return NaN;
  const n = typeof x === 'number' ? x : parseFloat(x);
  return Number.isFinite(n) ? n : NaN;
}

// 官方 T0 取值：pct/raw 直接取；rate=次数/该组场次×100；role_conditioned 无样本(<=0)则跳过。
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

// 同侪百分位排名，每 10% 一档：上位「前X%」、下位「后X%」（按数值）。
function rankLabel(v, t, deciles) {
  let b = 0;
  for (const k of deciles) if (v >= t['p' + k]) b++;
  if (b >= 5) { const lo = 100 - (b + 1) * 10, hi = 100 - b * 10; return lo <= 0 ? '前10%' : `前${lo}~${hi}%`; }
  const lo = b * 10, hi = (b + 1) * 10;
  return lo <= 0 ? '后10%' : `后${lo}~${hi}%`;
}

function fmtVal(v, kind) {
  if (kind === 'raw') return (Math.round(v * 100) / 100).toString();
  return (Math.round(v * 10) / 10) + '%';
}

export function traitHTML(m) {
  if (!FW) return '<div class="muted" style="padding:16px">画像框架加载中…</div>';
  const maps = { comprehensive: kvMap(m.comprehensive || []), good: kvMap(m.good || []), wolf: kvMap(m.wolf || []) };
  const dec = FW.deciles;

  // 逐指标：算档位 + 排名；notable = 偏离中等的
  const bands = {};                       // label -> 5档
  const notable = { 综合: [], 好人: [], 狼人: [] };
  for (const def of FW.t0_metrics) {
    const v = t0Value(maps, def);
    if (v == null) continue;
    const band = band5(v, def);
    bands[def.label] = band;
    if (band !== '中等') {
      const short = def.label.split('·')[1] || def.label;
      notable[CAMP_ZH[def.camp]].push(`${esc(short)} ${esc(fmtVal(v, def.kind))}（${esc(rankLabel(v, def, dec))}）`);
    }
  }

  // 联动规则命中
  const fired = [];
  for (const r of FW.t0_rules) {
    if (r.when.every(c => (c.band_in || []).includes(bands[c.metric]))) fired.push([r.group, r.tag]);
  }

  const dateStr = (FW.source_max_date || '').slice(0, 10) || '未知';
  const head = `
    <div class="trait-note">
      <div class="trait-testing">⚠ 特性画像为测试功能，口径仍在打磨，结论仅供参考。</div>
      <p><b>数据源</b>：华山官方公开对局，参照分布截止 ${esc(dateStr)}（共 ${esc(String(FW.source_games || '—'))} 局）。画像基于上方所选<b>赛区/赛季</b>的官方指标。</p>
      <p><b>怎么算</b>：把你的官方指标与全体选手同项分布对比，给出<b>档位</b>（很低→很高）和<b>同侪排名</b>（前/后 X%）；多项组合成<b>联动</b>解读。同名对比按同阵营分别取分布。</p>
    </div>`;

  let linkHTML = '<div class="muted" style="padding:2px 0 8px">各项接近中等，暂无明显联动特征。</div>';
  const groups = GROUP_ORDER.map(g => {
    const tags = fired.filter(([grp]) => grp === g).map(([, tag]) => tag);
    if (!tags.length) return '';
    return `<div class="trait-group"><h4>${esc(g)}</h4>${tags.map(t => `<div class="trait-tag">▸ ${esc(t)}</div>`).join('')}</div>`;
  }).join('');
  if (groups.trim()) linkHTML = groups;

  const notableHTML = ['综合', '好人', '狼人'].map(t =>
    notable[t].length ? `<div class="trait-notable-row"><span class="trait-camp">${t}</span>${notable[t].join('，')}</div>` : ''
  ).join('') || '<div class="muted" style="padding:2px 0">各项接近中等。</div>';

  const selfReason = '自算画像需要在后台逐场重建你的对局（找狼命中、站对边、第一天对跳、警徽投票等），该能力仍在开发，暂不可用。';
  const selfCalc = `
    <div class="trait-selfcalc-box">
      <button type="button" class="trait-selfcalc" disabled aria-disabled="true" title="${esc(selfReason)}">自算画像（开发中）</button>
      <span class="trait-selfcalc-reason">${esc(selfReason)}</span>
    </div>`;

  return `
    <div class="trait-view">
      ${head}
      <div class="sec"><h3>🔗 联动画像 <small>· 跨阵营优先</small></h3><div class="trait-links">${linkHTML}</div></div>
      <div class="sec"><h3>📊 关键指标 <small>· 只列偏离中等；同侪排名每 10% 一档</small></h3><div class="trait-notable">${notableHTML}</div></div>
      <div class="sec"><h3>🧮 自算画像 <small>· 逐场重建（深度）</small></h3>${selfCalc}</div>
    </div>`;
}
