import { fmt, isGoodCamp, kvMap } from './format.js';
import { SUMMARY_RATES, withSummaryRates, withPanelRates, metricNumber } from './panel-metrics.js';

export const identityName = role => role === '狼人' ? '狼' : role;
export const IDENTITY_BASE_METRICS = [
  { key: 'n', label: '场次' }, { key: 'avg', label: '场均分' }, { key: 'win', label: '胜率', pct: true },
  { key: 'mvp', label: 'MVP' }, { key: 'svp', label: '尽力' }, { key: 'bgx', label: '背锅' },
  ...SUMMARY_RATES.map(rate => ({ key: rate.key, label: rate.label, pct: true })),
];
const SKILLS = { '女巫': 'nvyl_pct', '猎人': 'lrql_pct', '预言家': 'yyjyl_pct', '侦探': 'ztfl_pct' };
export function identityMetrics(role) {
  if (!role) return IDENTITY_BASE_METRICS;
  const good = isGoodCamp(role);
  const keys = good ? ['toulang_pct', 'zhanbian_pct', 'tjh_pct'] : ['hantiao_total', 'hantiao_snum', 'hantiao_pct'];
  const extras = [
    ...(SKILLS[role] ? [{ key: SKILLS[role], label: fmt(SKILLS[role], 0).name, source: 'good', skill: true }] : []),
    ...keys.map(key => ({ key, label: fmt(key, 0).name, source: good ? 'good' : 'wolf' })),
  ];
  return [...IDENTITY_BASE_METRICS.slice(0, 3), ...extras.map(m => ({ ...m, pct: m.key.endsWith('_pct') })), ...IDENTITY_BASE_METRICS.slice(3)];
}
export function identitySummary(data, role) {
  if (data?.fullErr || data?.full?.games_error) return {};
  return withSummaryRates((data?.full?.roles || []).find(row => identityName(row.role) === identityName(role)) || {});
}
export function identityValue(data, role, metric) {
  return identityMetricResult(data, role, metric).value;
}
const CAMP_KEYS = { n: 'round_total', avg: 'round_point_avg', win: 'win_pct', mvp: 'mvp_num', svp: 'svp_num', bgx: 'bgx_num' };
export function identityMetricResult(data, role, metric) {
  const definition = identityMetrics(role).find(item => item.key === metric);
  if (!role || !definition) return {};
  const valid = value => metricNumber(value) != null;
  const own = identitySummary(data, role)[metric];
  if (valid(own)) return { value: own, source: role };
  const group = isGoodCamp(role) ? 'good' : 'wolf';
  const head = data?.head || data?.full;
  const values = kvMap(withPanelRates(head?.[group]));
  const value = values[CAMP_KEYS[metric] || metric];
  if (!valid(value)) return {};
  return { value, source: definition.skill ? role : (group === 'good' ? '好人整体' : '狼人整体'), fallback: !definition.skill };
}
export const IDENTITY_DATA_NOTE = '各项指标优先使用该身份的数据，缺失时使用当前赛区、赛季的对应阵营数据，并标注“好人整体”或“狼人整体”。技能比率使用已有身份指标；两者都没有时显示“—”，不从百分比反推次数。';
