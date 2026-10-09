'use strict';

// Easy bot: plays a random legal placement, preferring ones that fill gaps and
// avoiding ones that leave new gaps, and uses a shuffle offer as soon as it has
// one. Runs on the server for online rooms and in the browser for local games
// against bots. `random` returns a number in [0, 1).

const { ALIVE, EMPTY } = require('./constants');
const { NEIGHBOURS, legalPlacements, pieceCells } = require('./board');
const { completedLines } = require('./lines');

// A gap is a pocket of 1 to 3 connected empty cells (1×1, 1×2, small L or
// 1×3): only the rare small pieces fit it, so it slows the game down.
const GAP_MAX = 3;

// The gaps on a board, each as a sorted key of its cells, e.g. "12,13".
function gapKeys(owner) {
  const seen = new Set();
  const gaps = new Set();
  for (let i = 0; i < owner.length; i++) {
    if (owner[i] !== EMPTY || seen.has(i)) continue;
    const region = [i];
    seen.add(i);
    for (let j = 0; j < region.length; j++) {
      for (const n of NEIGHBOURS[region[j]]) {
        if (owner[n] === EMPTY && !seen.has(n)) {
          seen.add(n);
          region.push(n);
        }
      }
    }
    if (region.length <= GAP_MAX) gaps.add(region.sort((a, b) => a - b).join(','));
  }
  return gaps;
}

// Lower is better: 0 = fills a gap without leaving a new one, 1 = leaves no
// new gap, 2 + n = leaves n new gaps. A move that clears a line never counts
// as leaving a gap.
function moveScore(owner, gapsBefore, gapCells, seat, piece, move) {
  const cells = pieceCells(piece, move.rotation, move.x, move.y);
  const after = owner.slice();
  for (const i of cells) after[i] = seat;
  let created = 0;
  if (completedLines(after, cells).length === 0) {
    for (const key of gapKeys(after)) if (!gapsBefore.has(key)) created++;
  }
  if (created > 0) return 2 + created;
  return cells.some((i) => gapCells.has(i)) ? 0 : 1;
}

// The move an easy bot would make now, or null if it has none: a random one
// among the best-scoring legal moves.
function chooseEasyMove(state, seat, random = Math.random) {
  const p = state.players[seat];
  const moves = legalPlacements(state.owner, seat, p.hand, p.rainbow);
  if (moves.length === 0) return null;
  const gapsBefore = gapKeys(state.owner);
  const gapCells = new Set([...gapsBefore].flatMap((k) => k.split(',').map(Number)));
  const scores = moves.map((m) => moveScore(state.owner, gapsBefore, gapCells, seat, p.hand[m.handIndex], m));
  const best = Math.min(...scores);
  const top = moves.filter((m, k) => scores[k] === best);
  return top[Math.floor(random() * top.length)];
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

module.exports = { gapKeys, chooseEasyMove, wantsShuffle, botThinkMs };
