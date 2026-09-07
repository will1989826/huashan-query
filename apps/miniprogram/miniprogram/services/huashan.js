const playerData = require('./player-data')
const playerModel = require('./player-model')

async function searchPlayersByName(name) {
  const variants = playerModel.playerSearchVariants(name)
  const results = await Promise.all(variants.map(playerData.searchPlayers))
  return playerModel.rankPlayerSearchResults(playerModel.mergePlayerSearchResults(results), name)
}

module.exports = { ...playerData, ...playerModel, searchPlayersByName }
