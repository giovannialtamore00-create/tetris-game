'use strict';

// Easy bot: plays a uniformly random legal placement, and uses a shuffle
// offer as soon as it has one. Runs on the server for online rooms and in the
// browser for local games against bots. `random` returns a number in [0, 1).

const { ALIVE } = require('./constants');
const { legalPlacements } = require('./board');

// The move an easy bot would make now, or null if it has none.
function chooseEasyMove(state, seat, random = Math.random) {
  const p = state.players[seat];
  const moves = legalPlacements(state.owner, seat, p.hand, p.rainbow);
  if (moves.length === 0) return null;
  return moves[Math.floor(random() * moves.length)];
}

// Whether a bot in this seat should use its shuffle offer now.
function wantsShuffle(state, seat) {
  const p = state.players[seat];
  return !state.over && p.status === ALIVE && p.shuffleAvailable;
}

// A human-like pause before a bot moves: 3-4 s, well inside the AFK timer.
function botThinkMs(random = Math.random) {
  return 3_000 + Math.floor(random() * 1_000);
}

module.exports = { chooseEasyMove, wantsShuffle, botThinkMs };
