// 纯函数与常量：仅保留“展示层”——转义、配色、单局技能/投票/标记的文案格式化、赛区名解析。
// 筛选/聚合/阵营归类/候选等“计算”已下沉到 Go(player 层)，前端只渲染后端给出的模型。

export const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const uniq = a => [...new Set(a)];

export const ZONES = [["ALL", "全部赛区"], ["SH", "上海"], ["BJ", "北京"], ["XM", "厦门"], ["SD", "山东"], ["NJ", "南京"], ["WH", "武汉"], ["CQ", "重庆"], ["XA", "西安"], ["CS", "长沙"], ["HF", "合肥"], ["NC", "南昌"]];
const ZMAP = Object.fromEntries(ZONES);
export const zh = z => ZMAP[z] || z;
// 赛区代码 → 中文名（优先接口给的 joined_zone_ids，覆盖 HSHZ 等带前缀的新代码，再退静态表）
export function zoneName(code, joined) {
  const j = (joined || []).find(x => x.ordering === code);
  return j ? j.text : zh(code);
}
// 荣誉徽标用的赛区名：去掉尾部“赛区”
export const honorZoneName = (code, joined) => zoneName(code, joined).replace(/赛区$/, '');

// 字段 → [中文名, 是否百分比]（带 % 的一律以“率”结尾）。展示层标签表——Go 只给字段名与数值。
export const F = {
  total_point: ["总分", 0], round_total: ["总场次", 0], round_point_avg: ["场均分", 0],
  win_pct: ["胜率", 1], cunhuo_pct: ["存活率", 1], renming_num: ["人命值", 0],
  mvp_num: ["MVP次数", 0], svp_num: ["尽力次数", 0], bgx_num: ["背锅次数", 0], jingzhang_num: ["警长次数", 0],
  toulang_pct: ["投狼率", 1], zhanbian_snum: ["站对边数", 0], zhanbian_total: ["站边次数", 0], zhanbian_pct: ["站对边率", 1],
  molang_pct: ["摸狼率", 1], nvyl_pct: ["女巫毒狼率", 1], ztfl_pct: ["侦探翻狼率", 1], yyjyl_pct: ["预言家验狼率", 1], tjh_pct: ["警徽投对率", 1],
  lrql_pct: ["猎人带狼率", 1], htsp_num: ["悍跳神牌次数", 0],
  wei_hantiao_num: ["未悍跳次数", 0], hantiao_snum: ["悍跳成功次数", 0], hantiao_total: ["悍跳次数", 0],
  hantiao_pct: ["悍跳成功率", 1], zidao_num: ["自刀次数", 0],
  fds_snum: ["刀神次数", 0], fds_total: ["刀人次数", 0], fds_pct: ["刀神率", 1]
};
// fmt：字段名+数值 → {展示名, 展示值}。缺失显示 —，百分比补 %。
export function fmt(k, v) { const m = F[k]; const name = m ? m[0] : k; const pct = m ? m[1] : k.endsWith('_pct'); return { name, val: (v == null || v === '') ? '—' : (pct ? v + '%' : v) }; }

// —— 共享表格/键值原语（详情表、角色表、对比表共用，避免各处重复排序/格式化逻辑）——
// KV[] → {key: val} 映射（取某个指标值用）。
export const kvMap = arr => Object.fromEntries((arr || []).map(t => [t.key, t.val]));
// 从 KV 映射取单个指标的展示值：缺失显 —，百分比补 %（不查中文标签，标签由调用方给）。
export const metricOf = (map, key, pct) => { const v = map ? map[key] : undefined; return (v == null || v === '') ? '—' : (pct ? v + '%' : v); };
// 排序箭头：当前排序列显示 ▾/▴，否则空。
export const arrowFor = (sort, key) => (sort && sort.key === key) ? (sort.dir < 0 ? ' ▾' : ' ▴') : '';
// 可排序表头：handler=内联处理器名（如 'sortGames' / 'setRoleSort' / 'sortCompare'），点击调用 handler(key)。
export const sortableTh = (handler, key, label, sort) => `<th class="sortable" onclick="${handler}('${esc(key)}')">${esc(label)}${arrowFor(sort, key)}</th>`;
// 按列排序（返回新数组，不改原）。type='num'（默认）按数值，缺失/非数值恒排末、不受 dir 影响；type='str' 按字典序，空串恒排末。
export function sortRows(rows, key, dir, type = 'num') {
  const arr = (rows || []).slice();
  if (type === 'str') {
    arr.sort((a, b) => {
      const x = a[key] || '', y = b[key] || '';
      if (x === y) return 0;
      if (x === '') return 1; if (y === '') return -1;   // 空串恒末
      return dir * (x < y ? -1 : 1);
    });
    return arr;
  }
  arr.sort((a, b) => {
    const av = a[key], bv = b[key];
    const am = av == null || av === '', bm = bv == null || bv === '';
    if (am && bm) return 0;
    if (am) return 1; if (bm) return -1;                 // 缺失恒末
    return dir * ((+av || 0) - (+bv || 0));
  });
  return arr;
}

// 阵营判定（逐场表“阵营”快捷筛选用）：好人 = 非狼且不在狼阵营附加集
export const isGoodCamp = r => !/狼/.test(r || '') && !WOLFSIDE.has(r);

// —— 单局复盘 analysis 展示层 ——
// 死因 key → 中文（Go 只给 key）。demon_hunter 兼指“猎中狼”与“误猎好人反噬”，用中性词。
export const CAUSE = {
  knife: '狼刀', poison: '女巫毒', guard_witch: '同守同救', exile: '放逐', self_destruct: '自爆',
  hunter_shot: '猎人开枪', duel: '骑士决斗', demon_hunter: '猎魔人', detective: '侦探指定',
  dog_bite: '警犬撕咬', gargoyle: '石像鬼', dream: '摄梦', wolfking_take: '狼王带走', wolfbeauty_link: '狼美连人'
};
export const causeText = c => CAUSE[c] || '出局';
// 投票目标阵营着色：投到狼=绿(vhit)、投到好人=红(vmiss)。纯客观（目标身份已公开）。
export const voteHitClass = targetRole => isGoodCamp(targetRole) ? 'vmiss' : 'vhit';

// —— 身份配色/技能（展示层）——
export const WOLFSIDE = new Set(['石像鬼', '血月使徒', '梦魇']);
export const isWolf = r => /狼/.test(r || '');
// 身份配色：平民=灰；狼阵营（含石像鬼/血月使徒）=红系；神职=一套高区分度的珠宝色（冷暖兼有、避开红以免与狼混淆）
const WOLF_COLOR = { '狼': '#ff6b6b', '狼王': '#ff2d2d', '白狼王': '#ff9463', '狼美人': '#ff5c9a', '隐狼': '#c0392b', '石像鬼': '#d6604a', '血月使徒': '#a8324a', '恶狼骑士': '#ff7a45', '机械狼': '#e0554b', '梦魇': '#b5495b', '怪盗狼王': '#ff5a5f' };
const GOD_COLOR = { '预言家': '#5aa2f5', '女巫': '#b083f0', '猎人': '#e0a24f', '白痴': '#e6cf6b', '守卫': '#3fc2ad', '骑士': '#c2cf5e', '守墓人': '#8f9de6', '摄梦人': '#4fd39a', '猎魔人': '#8a6fe0', '警犬': '#63c8e6', '熊': '#c9ad72', '侦探': '#79c0d6' };
export function roleColor(r) {
  r = r || '';
  if (r === '平民') return '#93a1b2';
  if (/狼/.test(r) || WOLFSIDE.has(r)) return WOLF_COLOR[r] || '#ff6b6b';   // 石像鬼/血月使徒等并入狼阵营红系
  return GOD_COLOR[r] || '#5aa2f5';
}
export const roleWeight = r => r === '平民' ? '' : ';font-weight:700';
// 单局弹层专用「阵营三色」：把细分身份色收拢成 狼=红 / 神=蓝 / 民=灰，减少牌局详情里的颜色数量。
// 逐场表 / 角色表仍用 roleColor 的细分珠宝色——只有牌局弹层收敛。
export function campColor(r) {
  r = r || '';
  if (r === '平民') return 'var(--sub)';
  if (/狼/.test(r) || WOLFSIDE.has(r)) return 'var(--danger)';
  return 'var(--blue)';
}
// 技能只显示动作：少数角色固定动词（数据里技能名=角色名或需归一），其余用「角色名」自动拆前缀
const ROLE_WORDS = ['预言家', '摄梦人', '守墓人', '猎魔人', '白狼王', '狼美人', '狼王', '女巫', '猎人', '白痴', '警犬', '守卫', '骑士', '侦探', '熊', '狼'];
// 技能名 → 动作动词。用于两类：技能名=角色名时自动拆前缀会拆空、或拆出的动词不达意的角色。
// 依据《华山论剑选手执行手册》各版型技能描述显式给动词（键=数据里的技能名，非角色名——
// 梦魇/狼美人的行里同时含“狼刀”条目，按技能名归一才不会把狼刀也误标成本角色动词）。
const SKILL_NAME_FIX = {
  '女巫解': '救',      // 女巫两种药：解药→救；毒药“女巫毒”由前缀自动拆出“毒”
  '梦魇': '恐惧',      // 梦魇每晚“恐惧”一名选手，使其当天失去技能
  '狼美人': '魅惑',    // 狼美人每晚“魅惑”一名玩家，出局时带走被魅惑者
  '猎魔人': '狩猎',    // 猎魔人每晚“狩猎”：命中狼则狼亡、命中好人则自亡
  '石像鬼': '查验',    // 石像鬼每晚“查验”一名选手身份；三小狼全灭后的猎杀记在“狼刀”名下（另行合并），故本条恒为查验
  '骑士骑': '决斗',    // 骑士白天“决斗”一名玩家：目标为狼则狼亡、为好人则骑士亡
  '侦探翻': '翻牌',    // 侦探发动技能“翻牌”指定一名选手死亡并公开身份
};
const ROLE_VERB = { '预言家': '验', '摄梦人': '摄', '猎人': '带', '守卫': '守' };  // 单主动技能角色，按角色名固定动词
const SELF_SHIELD_ROLES = new Set(['怪盗狼王']);  // 对“自己”发动技能视为顶盾（显示“顶盾”，不带座位号）
export function skillLabel(name, rpt) {
  if (SKILL_NAME_FIX[name]) return SKILL_NAME_FIX[name];
  if (ROLE_VERB[rpt]) return ROLE_VERB[rpt];
  let s = String(name || '').trim();
  const cut = w => { if (w && s.length >= w.length && s.startsWith(w)) { s = s.slice(w.length); return true; } return false; };
  if (!cut(rpt)) for (const w of ROLE_WORDS) { if (cut(w)) break; }
  return s.trim();   // 可能为空
}
// 单条技能的动作文本（不含 D 天前缀）：怪盗狼王对自己发动 = “顶盾”（无座位号）；否则 “动词→目标座位”。
export function skillText(k, rptName, seat) {
  const self = k.target_seats.length === 1 && String(k.target_seats[0]) === String(seat);
  if (self && SELF_SHIELD_ROLES.has(rptName)) return '顶盾';
  const verb = skillLabel(k.name, rptName);
  return (verb ? verb : '') + '→' + k.target_seats.join(',');
}
export function seatVotes(s, days) {
  const out = [];
  for (let d = 1; d <= days; d++) { const v = s['vote_day' + d]; if (v != null && v !== '' && String(v) !== '0') out.push('D' + d + '→' + esc(v)); }
  if (s.vote_jinhui != null && s.vote_jinhui !== '' && Number(s.vote_jinhui) !== 0) out.push('警徽→' + esc(s.vote_jinhui));
  return out.join('　') || '—';
}
export function seatSkills(s) {
  const out = [];
  (s.skills || []).forEach(k => { if (k && k.name && Array.isArray(k.target_seats) && k.target_seats.length) { out.push('D' + k.day + ' ' + esc(skillText(k, s.rpt_name, s.seat))); } });
  return out.join('　') || '—';
}
export function seatMarks(s, g) {
  const m = [];
  if (g.mvp_seat === s.seat) m.push('<span class="gm mvp">MVP</span>');
  if (g.svp_seat === s.seat) m.push('<span class="gm svp">尽力</span>');
  for (let d = 1; d <= 6; d++) if (s['zibao' + d]) m.push('<span class="gm bgx">自爆D' + d + '</span>');
  if (s.day_of_hantiao) m.push('<span class="tag2">悍跳' + (s.hantiao_rpt_name ? esc(s.hantiao_rpt_name) : '') + ' D' + s.day_of_hantiao + '</span>');
  if (s.day_of_jinhui) m.push('<span class="tag2">警徽生效D' + s.day_of_jinhui + '</span>');
  return m.join('');
}

// —— 按天视图（方案A）辅助 ——
// 角色小图标：狼阵营统一 🐺，神职各有其表，其余用圆点。纯装饰，缺省不影响信息。
const ROLE_EMOJI = {
  '预言家': '🔮', '女巫': '🧪', '猎人': '🏹', '守卫': '🛡️', '摄梦人': '💤', '守墓人': '⚰️',
  '侦探': '🔍', '骑士': '⚔️', '白痴': '🃏', '警犬': '🐕', '熊': '🐻', '猎魔人': '🗡️'
};
export function roleEmoji(r) {
  r = r || '';
  if (/狼/.test(r) || WOLFSIDE.has(r)) return '🐺';
  return ROLE_EMOJI[r] || '·';
}
// 座位号 → “N号 名字·角色(带色)”；找不到该座位只显示“N号”。用于技能行动方 / 目标 / 警徽当选的统一标注。
export function seatRef(seat, bySeat) {
  const n = String(seat == null ? '' : seat);
  const s = bySeat && (bySeat.get(Number(seat)) || bySeat.get(n));
  if (!s) return `${esc(n)}号`;
  const rp = s.rpt_name || '';
  const role = rp ? `·<span style="color:${campColor(rp)}${roleWeight(rp)}">${esc(rp)}</span>` : '';
  return `${esc(n)}号 ${esc(s.player_name || '')}${role}`;
}

// 赛区名/代码/中文 → 代码（纯函数：显式传入选手参赛赛区列表，避免依赖全局状态）
export function resolveZone(val, joined) {
  const t = String(val || '').trim();
  if (!t || t === '全部赛区') return 'ALL';
  const j = (joined || []).find(x => x.text === t || x.ordering === t);
  if (j) return j.ordering;
  const z = ZONES.find(([c, l]) => l === t || c === t); return z ? z[0] : 'ALL';
}
