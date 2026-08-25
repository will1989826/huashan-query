// zone.js —— 赛区(赛区代码/中文名/解析)展示层的单一事实源。
// 个人页与对比页据此把赛区代码显示成中文、把用户输入解析回代码；赛事页据此取默认赛区。
// 注意：本表服务“个人/对比”页（沿用历史精简代码），与后端赛事资料字典（另一套更全的赛区代码）各自独立，互不合并。

// 赛事筛选缺省赛区（上海）；api.js、events.js 统一引用，避免散落字面量。
export const EVENT_ZONE_DEFAULT = 'SH';

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

// 赛区名/代码/中文 → 代码（纯函数：显式传入选手参赛赛区列表，避免依赖全局状态）
export function resolveZone(val, joined) {
  const t = String(val || '').trim();
  if (!t || t === '全部赛区') return 'ALL';
  const j = (joined || []).find(x => x.text === t || x.ordering === t);
  if (j) return j.ordering;
  const z = ZONES.find(([c, l]) => l === t || c === t); return z ? z[0] : 'ALL';
}
