export function compareDataStatus(state, label = '深层数据') {
  const records = (state.basket || []).map(person => state.rows?.[person.id] || {});
  const pending = records.filter(data => !data.full && !data.fullErr).length;
  const failed = records.filter(data => data.fullErr || data.full?.games_error).length;
  const incomplete = records.filter(data => data.full?.games_trunc).length;
  const status = pending ? `${label}加载中，已完成 ${records.length - pending}/${records.length}`
    : failed ? `${label}读取完成，${failed} 人读取失败`
      : incomplete ? `${label}读取完成` : `${label}已就绪 ${records.length}/${records.length}`;
  const note = (pending && failed ? ` · ${failed} 人读取失败` : '') + (incomplete ? ` · ${incomplete} 人记录不完整` : '');
  const retry = failed || incomplete || records.some(data => data.headErr);
  return `<span class="lineup-load-status${pending ? ' loading' : failed || incomplete ? ' error' : ''}" role="status" aria-live="polite">${status}${note}</span>${retry ? '<button type="button" class="qf" onclick="retryLineupData()">重试缺失数据</button>' : ''}`;
}
