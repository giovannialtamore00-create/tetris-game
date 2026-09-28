'use strict';

const { createRng, nextInt, shuffleInPlace } = require('./rng');
const { PIECE_SET } = require('./pieceSet');

const PIECES = Object.keys(PIECE_SET);
const SPECIAL_PIECES = PIECES.filter((piece) => PIECE_SET[piece].special);
const BAG_PIECES = PIECES.filter((piece) => !PIECE_SET[piece].special);

function normalize(cells) {
  const minR = Math.min(...cells.map(([r]) => r));
  const minC = Math.min(...cells.map(([, c]) => c));
  return cells
    .map(([r, c]) => [r - minR, c - minC])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

function rotateClockwise(cells) {
  return normalize(cells.map(([r, c]) => [c, -r]));
}

// ROTATIONS[piece][rotation] -> normalized [row, col] offsets. Every piece has
// exactly 4 rotations (some identical), so rotation indices 0-3 are always valid.
const ROTATIONS = {};
for (const piece of PIECES) {
  const rotations = [normalize(PIECE_SET[piece].cells)];
  for (let k = 1; k < 4; k++) rotations.push(rotateClockwise(rotations[k - 1]));
  ROTATIONS[piece] = rotations;
}

// Bag: every non-special piece once, in random order, reshuffled when
// exhausted. Special pieces are never dealt from the bag.
function createBag(seed) {
  return { rng: createRng(seed), queue: [] };
}

function drawPiece(bag) {
  if (bag.queue.length === 0) bag.queue = shuffleInPlace([...BAG_PIECES], bag.rng);
  return bag.queue.shift();
}

// A random special piece for shuffles and line-clear rewards. It is picked
// outside the bag: the queue is untouched, so the bag cycle is unaffected.
function drawSpecialPiece(bag) {
  return SPECIAL_PIECES[nextInt(bag.rng, SPECIAL_PIECES.length)];
}

module.exports = { PIECES, SPECIAL_PIECES, BAG_PIECES, ROTATIONS, createBag, drawPiece, drawSpecialPiece };
