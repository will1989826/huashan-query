import { RULE_ARTICLES } from './rules-data.js';

// Use the same roster source as the in-app rulebook.
export const LINEUP_EDITIONS = RULE_ARTICLES.filter(article => article.id.startsWith('edition-')).map(article => {
  const facts = article.blocks.find(block => block.type === 'facts' && block.title === '阵容');
  const roles = facts.items.flatMap(([, text]) => text.split('、').map(item => {
    const [name, count] = item.trim().split(/\s*×\s*/);
    return { role: name === '狼人' ? '狼' : name, count: count ? Number(count) : 1 };
  }));
  return { id: article.id, name: article.title, roles };
});
export const lineupEdition = lineup => LINEUP_EDITIONS.find(edition => edition.id === lineup?.edition);
export const newLineup = () => ({ edition: '', seats: {}, roles: {}, seatOrder: false, message: '' });
export function changeLineupEdition(lineup, edition) {
  if (!LINEUP_EDITIONS.some(item => item.id === edition) || lineup.edition === edition) return lineup;
  return { ...lineup, edition, roles: {}, message: '已更换版型，身份已清除，号码保留。' };
}
export function assignSeat(lineup, ids, id, value) {
  id = String(id); ids = ids.map(String);
  const seat = Number(value);
  if (!ids.includes(id) || !Number.isInteger(seat) || seat < 0 || seat > 12) return lineup;
  const seats = { ...lineup.seats }, previous = seats[id];
  const other = ids.find(person => person !== id && seats[person] === seat);
  if (seat && other) { if (previous) seats[other] = previous; else delete seats[other]; }
  if (seat) seats[id] = seat; else delete seats[id];
  return { ...lineup, seats,
    message: seat ? (other ? '已调整号码，每人号码保持唯一。' : `已分配 ${seat} 号。`) : '已清除该选手的号码。' };
}
export function assignSeatsInOrder(lineup, ids) {
  const orderedIDs = ids.map(String).slice(0, 12);
  if (!orderedIDs.length) return lineup;
  return {
    ...lineup,
    seats: Object.fromEntries(orderedIDs.map((id, index) => [id, index + 1])),
    seatOrder: false,
    message: `已按名单顺序发放 ${orderedIDs.length} 个号码。`,
  };
}
export function hasCompleteSeats(lineup, ids) {
  const assigned = ids.map(String).map(id => lineup.seats[id]);
  return assigned.length === 12 && assigned.every(seat => Number.isInteger(seat) && seat >= 1 && seat <= 12)
    && new Set(assigned).size === 12;
}
export function setLineupSeatOrder(lineup, ids, ordered) {
  if (ordered && !hasCompleteSeats(lineup, ids)) return lineup;
  return {
    ...lineup,
    seatOrder: !!ordered,
    message: ordered ? '已按号码排列 12 人座次。' : '已恢复名单顺序。',
  };
}
export function assignRole(lineup, ids, id, role) {
  id = String(id); ids = ids.map(String);
  if (!ids.includes(id)) return lineup;
  const roles = { ...lineup.roles };
  if (!role) { delete roles[id]; return { ...lineup, roles, message: '已清除该选手的身份。' }; }
  const capacity = lineupEdition(lineup)?.roles.find(item => item.role === role)?.count;
  if (!capacity) return lineup;
  const holders = ids.filter(person => person !== id && roles[person] === role);
  if (holders.length >= capacity) {
    if (capacity !== 1) return { ...lineup, message: `${role}名额已用完，请先清除一人的该身份。` };
    const previous = roles[id];
    if (previous) roles[holders[0]] = previous; else delete roles[holders[0]];
  }
  roles[id] = role;
  return { ...lineup, roles, message: holders.length >= capacity ? '已调整身份，每种身份不超过版型名额。' : `已分配${role}。` };
}
export function clearLineup(lineup, kind) {
  if (kind === 'seats') return { ...lineup, seats: {}, seatOrder: false, message: '已清除全部号码，身份保留。' };
  if (kind === 'roles') return { ...lineup, roles: {}, message: '已清除全部身份，号码保留。' };
  return lineup;
}
export function remainingRoles(lineup) {
  return (lineupEdition(lineup)?.roles || []).map(item => ({ ...item,
    remaining: item.count - Object.values(lineup.roles).filter(role => role === item.role).length,
  }));
}
