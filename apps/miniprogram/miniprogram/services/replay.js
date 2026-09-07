const shared = require('./shared')
const CAUSE_LABELS = {
  knife: '狼刀',
  poison: '女巫毒',
  guard_witch: '同守同救',
  exile: '放逐',
  self_destruct: '自爆',
  hunter_shot: '猎人开枪',
  duel: '骑士决斗',
  demon_hunter: '猎魔人',
  detective: '侦探指定',
  dog_bite: '警犬撕咬',
  gargoyle: '石像鬼猎杀',
  dream: '摄梦致死',
  wolfking_take: '狼王带走',
  wolfbeauty_link: '狼美人连人',
}
const SKILL_LABELS = {
  '女巫解': '救',
  '女巫毒': '毒',
  '狼刀': '刀',
  '摄梦人': '摄梦',
  '梦魇': '恐惧',
  '狼美人': '魅惑',
  '猎魔人': '狩猎',
  '石像鬼': '查验',
  '警犬验': '查验',
  '警犬咬': '撕咬',
  '警犬撕咬': '撕咬',
  '骑士骑': '决斗',
  '侦探翻': '翻牌',
}
const ROLE_LABELS = {
  '预言家': '验',
  '摄梦人': '摄',
  '猎人': '带',
  '守卫': '守',
}
const ROLE_WORDS = ['预言家', '摄梦人', '守墓人', '猎魔人', '白狼王', '狼美人', '狼王', '女巫', '猎人', '白痴', '警犬', '守卫', '骑士', '侦探', '熊', '狼']

function number(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function isGood(role) {
  return shared.isGoodCamp(role)
}

function campClass(role) {
  if (role === '平民') return 'civ'
  return isGood(role) ? 'god' : 'wolf'
}

function form2Of(game) {
  let form2 = game && game.form2
  if (typeof form2 === 'string') {
    try {
      form2 = JSON.parse(form2)
    } catch (_) {
      return {}
    }
  }
  return form2 && typeof form2 === 'object' ? form2 : {}
}

function normalizeVote(raw, seat) {
  let value = String(raw == null ? '' : raw).trim()
  if (!value || value === '0') return null
  const vote = { seat, target: 0, weight: 1, abstain: false, badge: false }
  if (value.startsWith('*')) {
    vote.weight = 1.5
    vote.badge = true
    value = value.slice(1)
  }
  if (value === '-1') vote.abstain = true
  else if (number(value) > 0) vote.target = number(value)
  else return null
  return vote
}

function normalizeRows(form2) {
  return (Array.isArray(form2.rows) ? form2.rows : []).map((source) => {
    const seat = number(source && source.seat)
    const skills = (Array.isArray(source && source.skills) ? source.skills : []).map((skill) => ({
      day: number(skill && skill.day),
      name: String((skill && skill.name) || ''),
      targets: (Array.isArray(skill && skill.target_seats) ? skill.target_seats : [])
        .map(number).filter((target) => target > 0),
    })).filter((skill) => skill.day > 0 && skill.name && skill.targets.length)
    const votes = {}
    for (let day = 1; day <= 8; day += 1) {
      const vote = normalizeVote(source && source['vote_day' + day], seat)
      if (vote) votes[day] = vote
    }
    let explodeDay = 0
    for (let day = 1; day <= 8; day += 1) {
      if (source && source['zibao' + day]) {
        explodeDay = day
        break
      }
    }
    return {
      source: source || {},
      validForAnalysis: Boolean(source && source.rpt_name)
        && (!Object.prototype.hasOwnProperty.call(source, 'skills') || Array.isArray(source.skills)),
      seat,
      playerId: String((source && source.player_id) || ''),
      playerName: String((source && source.player_name) || '未知选手'),
      sectName: String((source && source.sect_name) || '门派未知'),
      role: String((source && source.rpt_name) || '身份未知'),
      skills,
      votes,
      voteJinhui: source && source.vote_jinhui,
      dayBadge: number(source && source.day_of_jinhui),
      dayBluff: number(source && source.day_of_hantiao),
      bluffRole: String((source && source.hantiao_rpt_name) || ''),
      explodeDay,
    }
  }).filter((row) => row.seat > 0)
}

function isDaySkill(name) {
  return String(name || '').includes('猎人')
    || String(name || '').includes('侦探')
    || String(name || '').includes('骑士')
}

function consensus(targets) {
  if (!targets.length) return 0
  return targets.every((target) => target === targets[0]) ? targets[0] : 0
}

function replayDays(game, rows) {
  if (number(game && game.day) > 0) return number(game.day)
  return Math.max(0, ...rows.flatMap((row) => [
    ...Object.keys(row.votes).map(number), ...row.skills.map((skill) => skill.day),
  ]))
}

function analyze(game, rows) {
  const bySeat = new Map(rows.map((row) => [row.seat, row]))
  if (rows.length !== 12 || bySeat.size !== 12 || rows.some((row) => !row.validForAnalysis)) return null
  for (let seat = 1; seat <= 12; seat += 1) if (!bySeat.has(seat)) return null

  const days = replayDays(game, rows)
  const analysis = { roster: { wolf: [], gods: [], civ: [] }, votes: {}, exile: {}, deaths: [], alive: [] }
  rows.forEach((row) => {
    if (!isGood(row.role)) analysis.roster.wolf.push(row.seat)
    else if (row.role === '平民') analysis.roster.civ.push(row.seat)
    else analysis.roster.gods.push(row.seat)
  })
  const dead = new Map()
  const kill = (seat, day, phase, cause) => {
    if (!seat || dead.has(seat)) return
    const death = { seat, day, phase, cause, doubt: false }
    dead.set(seat, death)
    analysis.deaths.push(death)
  }
  let previousDream = 0

  for (let day = 1; day <= days; day += 1) {
    const votes = rows.map((row) => row.votes[day]).filter(Boolean)
    if (votes.length) analysis.votes[day] = votes

    const knifeTargets = []
    const saves = new Set()
    const guards = new Set()
    const poisons = []
    const specials = []
    let dream = 0
    let dreamSeat = 0
    let nightmareBlocks = false
    rows.forEach((row) => row.skills.forEach((skill) => {
      if (skill.day !== day || isDaySkill(skill.name)) return
      if (skill.name === '狼刀') knifeTargets.push(...skill.targets)
      else if (skill.name === '女巫解') skill.targets.forEach((target) => saves.add(target))
      else if (skill.name === '女巫毒') poisons.push(...skill.targets)
      else if (skill.name === '守卫') skill.targets.forEach((target) => guards.add(target))
      else if (skill.name === '摄梦人') {
        dream = skill.targets[0]
        dreamSeat = row.seat
      } else if (skill.name === '梦魇') {
        const target = bySeat.get(skill.targets[0])
        if (target && !isGood(target.role)) nightmareBlocks = true
      } else if (skill.name !== '预言家') {
        specials.push({ row, skill })
      }
    }))

    const knife = nightmareBlocks ? 0 : consensus(knifeTargets)
    const immune = (seat) => seat === dream
    if (knife && !immune(knife)) {
      if (saves.has(knife) && guards.has(knife)) kill(knife, day, 'night', 'guard_witch')
      else if (!saves.has(knife) && !guards.has(knife)) kill(knife, day, 'night', 'knife')
    }
    poisons.forEach((target) => {
      if (!immune(target)) kill(target, day, 'night', 'poison')
    })
    specials.forEach(({ row, skill }) => {
      const target = skill.targets[0]
      if (row.role === '猎魔人') {
        const targetRow = bySeat.get(target)
        kill(targetRow && !isGood(targetRow.role) ? target : row.seat, day, 'night', 'demon_hunter')
      } else if (row.role === '石像鬼') {
        const smallWolvesDead = rows.filter((item) => item.role === '狼').every((item) => dead.has(item.seat))
        if (smallWolvesDead && !immune(target)) kill(target, day, 'night', 'gargoyle')
      }
    })
    rows.forEach((row) => row.skills.forEach((skill) => {
      if (skill.day === day && skill.name.includes('撕咬')) kill(skill.targets[0], day, 'night', 'dog_bite')
    }))
    if (dream && dream === previousDream) kill(dream, day, 'night', 'dream')
    if (dreamSeat && dead.has(dreamSeat) && dream) kill(dream, day, 'night', 'dream')
    previousDream = dream

    let detectiveTarget = 0
    let knightKilledWolf = false
    let knightSelf = 0
    const hunterTargets = []
    rows.forEach((row) => row.skills.forEach((skill) => {
      if (skill.day !== day || !isDaySkill(skill.name)) return
      if (skill.name.includes('侦探')) detectiveTarget = skill.targets[0]
      else if (skill.name.includes('骑士')) {
        const target = bySeat.get(skill.targets[0])
        if (target && !isGood(target.role)) {
          kill(target.seat, day, 'day', 'duel')
          knightKilledWolf = true
        } else knightSelf = row.seat
      } else if (skill.name.includes('猎人')) hunterTargets.push(...skill.targets)
    }))
    if (knightSelf) kill(knightSelf, day, 'day', 'duel')
    let exploded = false
    rows.forEach((row) => {
      if (row.explodeDay === day) {
        kill(row.seat, day, 'day', 'self_destruct')
        exploded = true
      }
    })

    if (detectiveTarget) kill(detectiveTarget, day, 'day', 'detective')
    else if (!knightKilledWolf && !exploded) {
      const tallyMap = new Map()
      votes.forEach((vote) => {
        if (!vote.abstain && vote.target) tallyMap.set(vote.target, (tallyMap.get(vote.target) || 0) + vote.weight)
      })
      const tally = [...tallyMap].map(([seat, count]) => ({ seat, votes: count }))
        .sort((left, right) => right.votes - left.votes || left.seat - right.seat)
      const peaceful = !tally.length || (tally.length > 1 && tally[0].votes === tally[1].votes)
      const exile = { seat: peaceful ? 0 : tally[0].seat, peaceful, tally }
      analysis.exile[day] = exile
      const exiled = bySeat.get(exile.seat)
      if (exiled && exiled.role !== '白痴') kill(exile.seat, day, 'day', 'exile')
    }
    hunterTargets.forEach((target) => kill(target, day, 'day', 'hunter_shot'))
  }

  const linkedDeath = (role, cause, matchesSkill, canTake) => {
    rows.filter((row) => row.role === role).forEach((row) => {
      const death = dead.get(row.seat)
      if (!death || !canTake(death.cause)) return
      let skill = null
      row.skills.forEach((item) => {
        if (matchesSkill(item) && item.day <= death.day && (!skill || item.day >= skill.day)) skill = item
      })
      if (skill) kill(skill.targets[0], death.day, death.phase, cause)
    })
  }
  linkedDeath('狼美人', 'wolfbeauty_link', (skill) => skill.name === '狼美人', () => true)
  linkedDeath('狼王', 'wolfking_take', (skill) => skill.name !== '狼刀', (cause) => !['self_destruct', 'poison'].includes(cause))
  linkedDeath('白狼王', 'wolfking_take', (skill) => skill.name !== '狼刀', (cause) => !['self_destruct', 'poison', 'exile'].includes(cause))

  analysis.deaths.sort((left, right) => {
    const dayDiff = left.day - right.day
    if (dayDiff) return dayDiff
    return (left.phase === 'night' ? 0 : 1) - (right.phase === 'night' ? 0 : 1)
  })
  analysis.deaths.forEach((death) => {
    death.doubt = Object.keys(bySeat.get(death.seat).votes).map(number)
      .some((day) => day > death.day || (day === death.day && death.phase === 'night'))
  })
  analysis.alive = rows.filter((row) => !dead.has(row.seat)).map((row) => row.seat).sort((a, b) => a - b)
  return analysis
}

function skillLabel(skill, row) {
  if (row.role === '怪盗狼王' && skill.targets.length === 1 && skill.targets[0] === row.seat) return '顶盾'
  if (SKILL_LABELS[skill.name]) return SKILL_LABELS[skill.name]
  if (ROLE_LABELS[row.role]) return ROLE_LABELS[row.role]
  let label = skill.name.trim()
  const prefix = [row.role, ...ROLE_WORDS].find((role) => role && label.startsWith(role))
  if (prefix) label = label.slice(prefix.length)
  return label || skill.name
}

function seatText(seat, bySeat) {
  const row = bySeat.get(number(seat))
  return row ? row.seat + '号 ' + row.playerName + '·' + row.role : String(seat) + '号'
}

function voteView(vote, bySeat) {
  const target = bySeat.get(vote.target)
  return {
    from: seatText(vote.seat, bySeat) + (vote.badge ? ' ★' : ''),
    target: vote.abstain ? '弃票' : seatText(vote.target, bySeat),
    hitClass: vote.abstain ? 'abstain' : (target && !isGood(target.role) ? 'hit' : 'miss'),
  }
}

function groupVotes(votes, bySeat) {
  const groups = new Map()
  ;(votes || []).forEach((vote) => {
    const key = vote.abstain ? 'abstain' : String(vote.target)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(vote)
  })
  return [...groups].sort(([left], [right]) => {
    if (left === 'abstain') return 1
    if (right === 'abstain') return -1
    return number(left) - number(right)
  }).map(([key, rows]) => {
    const target = key === 'abstain' ? null : bySeat.get(number(key))
    return {
      from: rows.map((vote) => seatText(vote.seat, bySeat) + (vote.badge ? ' ★' : '')).join('、'),
      target: key === 'abstain' ? '弃票' : seatText(key, bySeat),
      hitClass: key === 'abstain' ? 'abstain' : (target && !isGood(target.role) ? 'hit' : 'miss'),
    }
  })
}

function replayView(payload, playerId, playerGame) {
  const source = payload && payload.data && !Array.isArray(payload.data) ? payload.data : (payload || {})
  const form2 = form2Of(source)
  const rows = normalizeRows(form2)
  const bySeat = new Map(rows.map((row) => [row.seat, row]))
  const analysis = analyze(source, rows)
  const deathBySeat = new Map((analysis && analysis.deaths || []).map((death) => [death.seat, death]))
  const days = replayDays(source, rows)

  const seatRows = rows.map((row) => {
    const votes = Object.keys(row.votes).map(number).sort((a, b) => a - b)
      .map((day) => ({ day: 'D' + day, ...voteView(row.votes[day], bySeat) }))
    const badgeVote = normalizeVote(row.voteJinhui, row.seat)
    if (badgeVote) votes.push({ day: '警徽', ...voteView(badgeVote, bySeat) })
    const skills = row.skills.map((skill) => ({
      day: 'D' + skill.day,
      action: skillLabel(skill, row),
      target: skillLabel(skill, row) === '顶盾' ? '' : skill.targets.map((seat) => seatText(seat, bySeat)).join('、'),
    }))
    const marks = []
    if (number(source.mvp_seat) === row.seat) marks.push('MVP')
    if (number(source.svp_seat) === row.seat) marks.push('尽力')
    if (number(source.bgx_seat) === row.seat || (playerGame && playerGame.bgx && row.playerId === String(playerId))) marks.push('背锅')
    if (row.explodeDay) marks.push('D' + row.explodeDay + ' 自爆')
    if (row.dayBluff) marks.push('D' + row.dayBluff + ' 悍跳' + row.bluffRole)
    const death = deathBySeat.get(row.seat)
    return {
      seat: row.seat,
      playerId: row.playerId,
      playerName: row.playerName,
      sectName: row.sectName,
      role: row.role,
      campClass: campClass(row.role),
      isMe: row.playerId === String(playerId),
      votes,
      skills,
      marks,
      outText: death ? ('第' + death.day + (death.phase === 'night' ? '夜' : '天') + '出局') : '',
    }
  })

  const dayRows = []
  for (let day = 1; day <= days; day += 1) {
    const knifeGroups = new Map()
    const skills = []
    rows.forEach((row) => row.skills.forEach((skill) => {
      if (skill.day !== day) return
      const action = skillLabel(skill, row)
      if (!isGood(row.role) && (action === '刀' || skill.name.includes('刀'))) {
        const key = skill.targets.join(',')
        if (!knifeGroups.has(key)) knifeGroups.set(key, skill.targets)
        return
      }
      skills.push({
        actor: row.role + ' · ' + row.seat + '号' + row.playerName,
        action,
        target: action === '顶盾' ? '' : skill.targets.map((seat) => seatText(seat, bySeat)).join('、'),
        campClass: campClass(row.role),
      })
    }))
    knifeGroups.forEach((targets) => skills.unshift({
      actor: '狼刀',
      action: '',
      target: targets.map((seat) => seatText(seat, bySeat)).join('、'),
      campClass: 'wolf',
    }))
    const badgeVotes = day === 1 ? rows.map((row) => {
      const vote = normalizeVote(row.voteJinhui, row.seat)
      return vote ? voteView(vote, bySeat) : null
    }).filter(Boolean) : []
    const badgeWinner = day === 1 ? rows.find((row) => row.dayBadge === 1) : null
    const events = []
    rows.forEach((row) => {
      if (row.explodeDay === day) events.push(row.seat + '号' + row.playerName + ' 自爆')
      if (row.dayBluff === day) events.push(row.seat + '号' + row.playerName + ' 悍跳' + row.bluffRole)
      if (day > 1 && row.dayBadge === day) events.push(row.seat + '号' + row.playerName + ' 警徽转移')
    })
    const exile = analysis && analysis.exile[day]
    dayRows.push({
      day,
      skills,
      badgeVotes,
      badgeWinner: badgeWinner ? seatText(badgeWinner.seat, bySeat) : '',
      votes: groupVotes(analysis && analysis.votes[day], bySeat),
      exileText: exile
        ? (exile.peaceful ? '平安白天，无人放逐' : '放逐 ' + seatText(exile.seat, bySeat))
        : '',
      tallyText: exile && exile.tally.length
        ? exile.tally.map((item) => item.seat + '号 ' + item.votes + '票').join('，')
        : '',
      events,
    })
  }

  const rosterGroup = (label, seats, groupClass) => ({
    label,
    groupClass,
    players: (seats || []).map((seat) => ({ text: seatText(seat, bySeat), campClass: campClass((bySeat.get(seat) || {}).role) })),
  })
  const edition = source.edition && typeof source.edition === 'object' ? source.edition.name : source.edition
  return {
    gameId: String(source.id || source.game_id || ''),
    date: source.play_date || '日期未知',
    edition: edition || '版型未知',
    scope: 'S' + (source.season_id == null ? '—' : source.season_id)
      + ' · 第 ' + (source.round == null ? '—' : source.round) + ' 轮'
      + (source.season_type_label ? ' · ' + source.season_type_label : ''),
    result: number(source.victory_camp) === 1 ? '好人胜' : (number(source.victory_camp) === 2 ? '狼人胜' : '结果未知'),
    resultClass: number(source.victory_camp) === 1 ? 'good' : (number(source.victory_camp) === 2 ? 'wolf' : 'unknown'),
    referee: source.referee_name || '—',
    mvp: number(source.mvp_seat) ? seatText(source.mvp_seat, bySeat) : '—',
    svp: number(source.svp_seat) ? seatText(source.svp_seat, bySeat) : '—',
    roster: analysis ? [
      rosterGroup('狼队', analysis.roster.wolf, 'wolf'),
      rosterGroup('神职', analysis.roster.gods, 'god'),
      rosterGroup('平民', analysis.roster.civ, 'civ'),
    ] : [],
    timeline: (analysis && analysis.deaths || []).map((death) => ({
      time: '第' + death.day + (death.phase === 'night' ? '夜' : '天'),
      player: seatText(death.seat, bySeat),
      cause: CAUSE_LABELS[death.cause] || '出局',
      doubt: death.doubt,
    })),
    seatRows,
    dayRows,
    points: (Array.isArray(form2.points) ? form2.points : []).map((point) => ({
      player: seatText(point.seat, bySeat),
      name: point.name || '违规扣分',
      point: point.point,
    })),
  }
}

module.exports = {
  analyze,
  campClass,
  form2Of,
  isGood,
  replayView,
  skillLabel,
}
