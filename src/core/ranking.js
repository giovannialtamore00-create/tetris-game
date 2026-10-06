'use strict';

const { ALIVE, ABSENT } = require('./constants');
const { countBlocks } = require('./board');

// §12: most points wins. Ties are broken by (1) living beats not living, then
// (2) most blocks owned on the board. A player who is not alive owns only dulled
// blocks (timed out) or none (eliminated), so step 2 is the same count for both
// groups. Players still level share a rank; several players at rank 1 is a draw.
function rankPlayers(players, owner) {
  const rows = players.filter((p) => p.status !== ABSENT).map((p) => ({
    seat: p.seat,
    score: p.score,
    status: p.status,
    alive: p.status === ALIVE,
    blocks: countBlocks(owner, p.seat),
  }));

  const compare = (a, b) =>
    b.score - a.score || Number(b.alive) - Number(a.alive) || b.blocks - a.blocks;

  const standings = [...rows].sort((a, b) => compare(a, b) || a.seat - b.seat);
  standings.forEach((row, k) => {
    row.rank = k > 0 && compare(standings[k - 1], row) === 0 ? standings[k - 1].rank : k + 1;
  });

  const winners = standings.filter((row) => row.rank === 1).map((row) => row.seat);
  return { standings, winners, draw: winners.length > 1 };
}

module.exports = { rankPlayers };
