const shared = require('./shared')
const { lexical, numeric, round2 } = shared

function groupCapacities(teamCount) {
  const base = Math.floor(Math.max(0, Number(teamCount) || 0) / 4)
  const remainder = Math.max(0, Number(teamCount) || 0) % 4
  return ['A', 'B', 'C', 'D'].map((_, index) => base + (index < remainder ? 1 : 0))
}

function seedTeams(items) {
  const teams = (items || []).map((item) => ({ ...item }))
  teams.sort((a, b) => {
    const pointDifference = Number(b.totalPoint) - Number(a.totalPoint)
    if (Math.abs(pointDifference) > 0.001) return pointDifference
    return b.mvp - a.mvp || b.svp - a.svp || a.bgx - b.bgx || a.sectId - b.sectId
  })
  teams.forEach((team, index) => { team.rank = index + 1 })
  return teams
}

function drawNextAssignment(teams, assignments, random) {
  const groups = ['A', 'B', 'C', 'D']
  const current = assignments || []
  if (current.length >= (teams || []).length) return null
  const capacities = groupCapacities(teams.length)
  const available = groups.filter((group, index) => current.filter((item) => item.group === group).length < capacities[index])
  if (!available.length) return null
  const value = Number((random || Math.random)())
  const index = Math.min(available.length - 1, Math.max(0, Math.floor((Number.isFinite(value) ? value : 0) * available.length)))
  return { sectId: teams[current.length].sectId, group: available[index] }
}

function rankWithTies(items) {
  const sorted = [...items].sort((a, b) => {
    if (a.total == null && b.total == null) return 0
    if (a.total == null) return 1
    if (b.total == null) return -1
    return b.total - a.total || String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN')
  })
  let previous = null
  sorted.forEach((item, index) => {
    item.rank = item.total == null ? null : (previous == null || Math.abs(item.total - previous) > 0.001 ? index + 1 : sorted[index - 1].rank)
    if (item.total != null) previous = item.total
  })
  return sorted
}

function calculateScenario(data, projections, removedIndex) {
  if (!data || !data.simulationReady) return []
  return rankWithTies(data.teams.map((team, teamIndex) => {
    let total = Number(team.constantAdjustment || 0)
    let complete = true
    data.games.forEach((game, gameIndex) => {
      if (gameIndex === Number(removedIndex)) return
      const value = game.complete ? game.scores[teamIndex] : projections && projections[game.index] && projections[game.index][team.sectId]
      if (value == null || !Number.isFinite(Number(value))) complete = false
      else total += Number(value)
    })
    return { sectId: team.sectId, name: team.sectName, total: complete ? round2(total) : null }
  }))
}

function baseSect(name) {
  return String(name || '').trim().replace(/[（(][^（()）]*[）)]\s*$/u, '').trim()
}

function combinationsOfFour(count) {
  const masks = []
  for (let mask = 0; mask < (1 << count); mask += 1) {
    let value = mask
    let bits = 0
    while (value > 0) { value &= value - 1; bits += 1 }
    if (bits === 4) masks.push(mask)
  }
  return masks
}

const FOUR_OF_TWELVE = combinationsOfFour(12)

function scoreFit(values) {
  return values.reduce((fit, value) => ({
    invalid: fit.invalid + (value > 0.001 ? 1 : 0),
    positive: fit.positive + (value > 0.001 ? value : 0),
    zeros: fit.zeros + (Math.abs(value) <= 0.001 ? 1 : 0),
    negative: fit.negative + (value < -0.001 ? -value : 0),
    square: fit.square + value * value,
  }), { invalid: 0, positive: 0, zeros: 0, negative: 0, square: 0 })
}

function compareFit(a, b) {
  if (a.invalid !== b.invalid) return a.invalid < b.invalid ? -1 : 1
  if (a.zeros !== b.zeros) return a.zeros > b.zeros ? -1 : 1
  if (Math.abs(a.positive - b.positive) > 0.001) return a.positive < b.positive ? -1 : 1
  if (Math.abs(a.negative - b.negative) > 0.001) return a.negative < b.negative ? -1 : 1
  if (Math.abs(a.square - b.square) > 0.001) return a.square < b.square ? -1 : 1
  return 0
}

function fitAdjustments(residual, type) {
  if (String(type) !== '4' || residual.length !== 12) {
    return { bonus: residual.map(() => 0), outside: residual.slice(), fit: scoreFit(residual) }
  }
  let hasBest = false
  let bestInvalid = 0
  let bestPositive = 0
  let bestZeros = 0
  let bestNegative = 0
  let bestSquare = 0
  let bestFiveMask = 0
  let bestThreeMask = 0
  for (const fiveMask of FOUR_OF_TWELVE) {
    for (const threeMask of FOUR_OF_TWELVE) {
      if (fiveMask & threeMask) continue
      let invalid = 0
      let positive = 0
      let zeros = 0
      let negative = 0
      let square = 0
      for (let index = 0; index < residual.length; index += 1) {
        const bonus = fiveMask & (1 << index) ? 5 : (threeMask & (1 << index) ? 3 : 0)
        const value = residual[index] - bonus
        if (value > 0.001) { invalid += 1; positive += value }
        else if (value < -0.001) negative -= value
        else zeros += 1
        square += value * value
      }
      let comparison = 0
      if (hasBest) {
        if (invalid !== bestInvalid) comparison = invalid < bestInvalid ? -1 : 1
        else if (zeros !== bestZeros) comparison = zeros > bestZeros ? -1 : 1
        else if (Math.abs(positive - bestPositive) > 0.001) comparison = positive < bestPositive ? -1 : 1
        else if (Math.abs(negative - bestNegative) > 0.001) comparison = negative < bestNegative ? -1 : 1
        else if (Math.abs(square - bestSquare) > 0.001) comparison = square < bestSquare ? -1 : 1
      }
      if (!hasBest || comparison < 0) {
        hasBest = true
        bestInvalid = invalid
        bestPositive = positive
        bestZeros = zeros
        bestNegative = negative
        bestSquare = square
        bestFiveMask = fiveMask
        bestThreeMask = threeMask
      }
    }
  }
  const bonus = residual.map((_, index) => bestFiveMask & (1 << index) ? 5 : (bestThreeMask & (1 << index) ? 3 : 0))
  return {
    bonus,
    outside: residual.map((value, index) => value - bonus[index]),
    fit: {
      invalid: bestInvalid,
      positive: bestPositive,
      zeros: bestZeros,
      negative: bestNegative,
      square: bestSquare,
    },
  }
}

function buildDrawData(rankRows, playerRows, fetched, season, type, zone) {
  const expected = String(type) === '4' ? 15 : 16
  const teams = rankRows.map((team) => ({ ...team, officialTotal: team.totalPoint, initialBonus: 0, outsideAdjustment: 0, constantAdjustment: 0 }))
  const teamById = new Map(teams.map((team, index) => [team.sectId, index]))
  const teamByBase = new Map()
  const duplicateBases = new Set()
  teams.forEach((team, index) => {
    const base = baseSect(team.sectName)
    if (teamByBase.has(base)) duplicateBases.add(base)
    else teamByBase.set(base, index)
  })
  const games = new Map()
  const seen = new Set()
  let failures = 0
  let conflicts = 0
  fetched.forEach((result, playerIndex) => {
    if (result.error) { failures += 1; return }
    ;(result.value || []).forEach((game) => {
      if (Math.trunc(numeric(game.season_id)) !== Math.trunc(numeric(season)) || Math.trunc(numeric(game.season_type_id)) !== Math.trunc(numeric(type))) return
      const gameId = Math.trunc(numeric(game.game_id))
      if (!gameId) return
      let teamIndex = teamById.get(Math.trunc(numeric(game.sect_id)))
      const base = baseSect(game.sect_name)
      if (teamIndex == null && !duplicateBases.has(base)) teamIndex = teamByBase.get(base)
      if (teamIndex == null) return
      const rawPlayerId = Math.trunc(numeric(game.player_id))
      const playerId = rawPlayerId > 0 ? rawPlayerId : playerRows[playerIndex].playerId
      const seenKey = gameId + '|' + playerId
      if (seen.has(seenKey)) return
      seen.add(seenKey)
      if (!games.has(gameId)) games.set(gameId, { gameId, playDate: game.play_date || '', round: Math.trunc(numeric(game.round)), scores: new Map() })
      const point = numeric(game.total_point)
      if (games.get(gameId).scores.has(teamIndex)) {
        if (Math.abs(games.get(gameId).scores.get(teamIndex) - point) > 0.001) conflicts += 1
        return
      }
      games.get(gameId).scores.set(teamIndex, point)
    })
  })
  const ordered = [...games.values()].sort((a, b) => a.playDate.localeCompare(b.playDate) || a.round - b.round || a.gameId - b.gameId)
    .map((game, index) => ({
      index: index + 1,
      gameId: game.gameId,
      playDate: game.playDate,
      round: game.round,
      complete: true,
      scores: teams.map((_, teamIndex) => game.scores.has(teamIndex) ? round2(game.scores.get(teamIndex)) : null),
    }))
  const warnings = []
  if (failures) warnings.push(failures + ' 名选手的逐场数据读取失败，部分局分可能缺失。')
  if (conflicts) warnings.push('发现同一门派同一局的重复分数，已保留首条官方记录。')
  let simulationReady = ordered.length <= expected
  if (ordered.length > expected) warnings.push('读取到的比赛超过赛制局数，暂时无法准确模拟。')
  const completeCount = ordered.length
  while (ordered.length < expected) ordered.push({ index: ordered.length + 1, gameId: 0, playDate: '', round: 0, complete: false, scores: teams.map(() => null) })
  const missing = ordered.slice(0, Math.min(completeCount, expected)).reduce((count, game) => count + game.scores.filter((score) => score == null).length, 0)
  if (missing > 0) {
    simulationReady = false
    warnings.push('官方逐场数据缺少 ' + missing + ' 个门派局分，暂时无法准确模拟。')
  }
  const sums = teams.map((_, teamIndex) => ordered.slice(0, completeCount).reduce((sum, game) => sum + Number(game.scores[teamIndex] || 0), 0))
  let historicalRemovedGame = 0
  if (simulationReady && completeCount === expected) {
    let best = null
    let unique = true
    ordered.slice(0, expected).forEach((removed, removedIndex) => {
      const residual = teams.map((team, teamIndex) => team.officialTotal - sums[teamIndex] + removed.scores[teamIndex])
      const current = fitAdjustments(residual, type)
      const comparison = best ? compareFit(current.fit, best.fit) : -1
      if (!best || comparison < 0) { best = { ...current, removedIndex }; unique = true } else if (comparison === 0) unique = false
    })
    if (!best || !unique) {
      simulationReady = false
      warnings.push('无法从官方总分唯一确认已抽掉的比赛，暂时无法准确模拟。')
    } else {
      historicalRemovedGame = ordered[best.removedIndex].gameId
      teams.forEach((team, index) => {
        team.initialBonus = best.bonus[index]
        team.outsideAdjustment = round2(best.outside[index])
        team.constantAdjustment = round2(best.bonus[index] + best.outside[index])
      })
    }
  } else if (simulationReady) {
    const residual = teams.map((team, index) => team.officialTotal - sums[index])
    const fit = fitAdjustments(residual, type)
    teams.forEach((team, index) => {
      team.initialBonus = fit.bonus[index]
      team.outsideAdjustment = round2(fit.outside[index])
      team.constantAdjustment = round2(residual[index])
    })
  }
  if (simulationReady && teams.some((team) => team.outsideAdjustment > 0.001)) {
    warnings.push('部分官方总分无法由对局积分、带入积分和赛外违规扣分解释，请核对原始数据。')
  }
  return {
    season, seasonType: String(type), zone, expectedGames: expected, countedGames: expected - 1, completedGames: completeCount,
    complete: completeCount === expected, simulationReady, officialDrawApplied: Boolean(historicalRemovedGame),
    historicalRemovedGame, teams, games: ordered, warnings,
  }
}

module.exports = {
  baseSect,
  buildDrawData,
  calculateScenario,
  drawNextAssignment,
  groupCapacities,
  rankWithTies,
  seedTeams,
}
