import { fmt } from './format.js';

export const PANEL_RATES = Object.freeze([
  { key: 'mvp_pct', count: 'mvp_num', summary: 'mvp', label: 'MVP率', direction: 1 },
  { key: 'svp_pct', count: 'svp_num', summary: 'svp', label: '尽力率', direction: 0 },
  { key: 'bgx_pct', count: 'bgx_num', summary: 'bgx', label: '背锅率', direction: -1 },
  { key: 'jingzhang_pct', count: 'jingzhang_num', label: '警长率', direction: 0 },
]);
export const SUMMARY_RATES = PANEL_RATES.filter(rate => rate.summary);
export const rateOf = key => PANEL_RATES.find(rate => rate.key === key);
export function metricNumber(value) {
  if (value == null || typeof value === 'boolean' || (typeof value === 'string' && !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

// Only per-game counts with a denominator from the same panel can form a rate.
export function panelRate(count, rounds) {
  const numerator = metricNumber(count), denominator = metricNumber(rounds);
  if (!Number.isInteger(numerator) || !Number.isInteger(denominator)
    || denominator <= 0 || numerator < 0 || numerator > denominator) return null;
  return numerator * 100 / denominator;
}

export function withPanelRates(items = [], hidden = []) {
  const source = (items || []).filter(item => item && item.key && !hidden.includes(item.key));
  const map = Object.fromEntries(source.map(item => [item.key, item.val]));
  return source.flatMap(item => {
    const rate = PANEL_RATES.find(candidate => candidate.count === item.key);
    if (!rate || !Object.hasOwn(map, 'round_total') || Object.hasOwn(map, rate.key)) return [item];
    return [item, { key: rate.key, val: panelRate(item.val, map.round_total) }];
  });
}

export function withSummaryRates(row) {
  const source = row || {};
  const rates = SUMMARY_RATES
    .filter(rate => !Object.hasOwn(source, rate.key))
    .map(rate => [rate.key, panelRate(source[rate.summary], source.n)]);
  return { ...source, ...Object.fromEntries(rates) };
}

export function rateDescription(key, summary = false) {
  const rate = rateOf(key);
  if (!rate) return '';
  const summarySource = { mvp: 'MVP次数', svp: '尽力次数', bgx: '背锅次数' }[rate.summary];
  const source = summary && summarySource ? summarySource : fmt(rate.count, 0).name;
  return `${source} ÷ 当前分组场次 × 100%；场次为零、缺失或次数异常时不计算。`;
}

export const isRatioMetric = key => key.endsWith('_pct') || key === 'win' || key === 'molang';
