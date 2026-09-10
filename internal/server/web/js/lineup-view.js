import { esc, fmt, campColor, isGoodCamp } from './format.js';
import { IDENTITY_DATA_NOTE, identityMetricResult, identityMetrics } from './identity-metrics.js';
import { LINEUP_EDITIONS, hasCompleteSeats, newLineup, remainingRoles } from './lineup.js';
import { compareDataStatus } from './compare-data-status.js';

export function renderLineup(state, scopeBar) {
  const lineup = state.lineup || newLineup(), players = state.basket || [];
  const seatsComplete = hasCompleteSeats(lineup, players.map(person => person.id));
  const displayPlayers = lineup.seatOrder && seatsComplete
    ? [...players].sort((a, b) => lineup.seats[a.id] - lineup.seats[b.id]) : players;
  const remaining = remainingRoles(lineup);
  const button = (action, text, disabled = false) => `<button type="button" class="qf" onclick="${action}"${disabled ? ' disabled' : ''}>${text}</button>`;
  const cards = displayPlayers.map(person => {
    const id = esc(person.id), name = esc(person.name), role = lineup.roles[person.id] || '', seat = lineup.seats[person.id];
    const wolf = role && !isGoodCamp(role), longRole = Array.from(role).length >= 4;
    const data = state.rows?.[person.id] || {}, avatar = data.full?.player?.avatar || data.head?.player?.avatar || person.avatar;
    const seatOptions = Array.from({ length: 12 }, (_, i) => i + 1).map(n => `<option value="${n}"${seat === n ? ' selected' : ''}>${n}号${players.some(p => p.id !== person.id && lineup.seats[p.id] === n) ? '（调整）' : ''}</option>`).join('');
    const roleOptions = remaining.map(item => `<option value="${item.role}"${role === item.role ? ' selected' : ''}${item.remaining === 0 && item.count > 1 && role !== item.role ? ' disabled' : ''}>${item.role}${item.remaining === 0 && role !== item.role ? (item.count === 1 ? '（调整）' : '（已满）') : ''}</option>`).join('');
    const related = identityMetrics(role);
    const metrics = related.slice(0, 3).concat(related.filter(item => item.source));
    const facts = !role ? '' : metrics.map(metric => {
      const result = identityMetricResult(data, role, metric.key);
      const value = result.value == null ? '—' : metric.pct ? fmt('win_pct', result.value).val : result.value;
      // 回退到阵营整体数据时标注来源，与身份对比保持一致。
      const source = result.fallback ? result.source : '';
      return `<div class="lineup-stat"><dt>${esc(metric.label)}</dt><dd>${esc(value)}</dd>${source ? `<small class="identity-source">${esc(source)}</small>` : ''}</div>`;
    }).join('');
    const status = !role ? '' : data.fullErr || data.full?.games_error ? '身份数据读取失败，可重试；已有阵营数据仍可参考。' : data.loadingFull ? '身份数据读取中，暂用已有阵营数据。' : data.full?.games_trunc ? '身份记录未完整读取，当前结果可能不完整。' : '';
    return `<article class="lineup-card${wolf ? ' lineup-wolf' : ''}" data-lineup-player="${id}" style="--identity-color:${role ? campColor(role) : 'var(--sub)'}">
      <div class="lineup-hero">
        <div class="lineup-photo"><span aria-hidden="true">${esc(Array.from(person.name || '?').slice(0, 2).join(''))}</span>${avatar ? `<img src="${esc(avatar)}" alt="${name}的照片" onerror="this.hidden=true">` : ''}</div>
        <div class="lineup-person">
          <header><button type="button" class="cmp-nm" data-id="${id}" onclick="openPlayer(this.dataset.id)">${name}</button></header>
          <div class="lineup-assigned" aria-live="polite">
            <div class="lineup-seat-result${seat ? ' assigned' : ''}"><span>号码</span><div class="lineup-result-value"><strong>${seat || '—'}</strong>${seat ? '<em>号</em>' : ''}</div></div>
            <div class="lineup-role-result${role ? ' assigned' : ''}${longRole ? ' long-role' : ''}"><span>身份</span><div class="lineup-result-value"><strong>${esc(role || '待分配')}</strong></div></div>
          </div>
          <div class="lineup-card-actions"><label class="lineup-picker lineup-seat${seat ? ' assigned' : ''}">${seat ? '改号码' : '选号码'}<select data-lineup-control aria-label="${name}的号码" data-id="${id}" onchange="setLineupSeat(this.dataset.id,this.value)"><option value="0">待选</option>${seatOptions}</select></label><label class="lineup-picker lineup-identity${role ? ' assigned' : ''}${!lineup.edition ? ' disabled' : ''}">${role ? '改身份' : '选身份'}<select data-lineup-control aria-label="${name}的身份" data-id="${id}" onchange="setLineupRole(this.dataset.id,this.value)"${!lineup.edition ? ' disabled' : ''}><option value="">待选身份</option>${roleOptions}</select></label></div>
        </div>
      </div>
      ${role ? `<dl class="lineup-facts">${facts}</dl>` : '<p class="lineup-empty">选择身份后查看相关表现</p>'}${status ? `<p class="lineup-status">${status}</p>` : ''}
    </article>`;
  }).join('');
  return `<section class="cmp lineup"><div class="cmp-head"><h3>12 人号码与身份</h3><span class="lineup-progress">号码 ${Object.keys(lineup.seats).length}/12 · 身份 ${Object.keys(lineup.roles).length}/12</span>${button('closeLineup()', '返回选手对比')}</div>
    <div class="lineup-config"><label class="lineup-edition-label">版型<select id="lineup-edition" class="qsel" data-lineup-control onchange="setLineupEdition(this.value)"><option value="">先选择版型</option>${LINEUP_EDITIONS.map(edition => `<option value="${edition.id}"${edition.id === lineup.edition ? ' selected' : ''}>${edition.name}</option>`).join('')}</select></label>${scopeBar}
      <div class="lineup-tools">${compareDataStatus(state, '身份数据')}${button('assignLineupSeatsInOrder()', '按顺序发号码')}${button('toggleLineupSeatOrder()', lineup.seatOrder ? '恢复名单顺序' : '按号码排列座次', !seatsComplete)}${button("clearLineupAssignments('seats')", '清除全部号码')}${button("clearLineupAssignments('roles')", '清除全部身份')}</div></div>
    <div class="lineup-notes"><p class="lineup-live" role="status" aria-live="polite">${esc(lineup.message || '直接在每张资料卡上选择号码和身份。')}</p>
    <details class="lineup-data-note"><summary>身份数据优先，缺失时用阵营数据 · 口径说明</summary><p>${esc(IDENTITY_DATA_NOTE)}选择版型只决定可分配的身份，不筛选历史战绩。</p></details></div>
    <div class="lineup-grid">${cards}</div></section>`;
}
