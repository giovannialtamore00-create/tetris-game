'use strict';

const START_RATING = 1000;
const K = 32;

// Chance that a player rated `a` beats one rated `b` (standard Elo curve).
function expectedScore(a, b) {
  return 1 / (1 + Math.pow(10, (b - a) / 400));
}

// Multi-player Elo: every pair of players is a small 1v1 (lower rank number wins,
// equal ranks draw), and each player's change is the average over their opponents
// times K, so a 4-player game moves ratings about as much as a 1v1.
// results: [{ id, rating, rank }] (rank as given by rankPlayers).
// Returns [{ id, rating, change }] in the same order; ratings stay whole numbers.
function updateRatings(results, k = K) {
  const n = results.length;
  if (n < 2) return results.map((r) => ({ id: r.id, rating: r.rating, change: 0 }));
  return results.map((me) => {
    let sum = 0;
    for (const other of results) {
      if (other === me) continue;
      const actual = me.rank < other.rank ? 1 : me.rank === other.rank ? 0.5 : 0;
      sum += actual - expectedScore(me.rating, other.rating);
    }
    const change = Math.round((k * sum) / (n - 1));
    return { id: me.id, rating: me.rating + change, change };
  });
}

module.exports = { START_RATING, K, expectedScore, updateRatings };
