'use strict';

const { createRng, shuffleInPlace } = require('./rng');

// Base shapes as [row, col] offsets.
const SHAPES = {
  I: [[0, 0], [0, 1], [0, 2], [0, 3]],
  O: [[0, 0], [0, 1], [1, 0], [1, 1]],
  T: [[0, 0], [0, 1], [0, 2], [1, 1]],
  S: [[0, 1], [0, 2], [1, 0], [1, 1]],
  Z: [[0, 0], [0, 1], [1, 1], [1, 2]],
  J: [[0, 0], [1, 0], [1, 1], [1, 2]],
  L: [[0, 2], [1, 0], [1, 1], [1, 2]],
};

const PIECES = Object.keys(SHAPES);

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
  const rotations = [normalize(SHAPES[piece])];
  for (let k = 1; k < 4; k++) rotations.push(rotateClockwise(rotations[k - 1]));
  ROTATIONS[piece] = rotations;
}

// 7-bag: all seven pieces in random order, reshuffled when exhausted.
function createBag(seed) {
  return { rng: createRng(seed), queue: [] };
}

function drawPiece(bag) {
  if (bag.queue.length === 0) bag.queue = shuffleInPlace([...PIECES], bag.rng);
  return bag.queue.shift();
}

module.exports = { PIECES, ROTATIONS, createBag, drawPiece };
