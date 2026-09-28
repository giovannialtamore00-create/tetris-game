'use strict';

const { createRng, nextInt, nextUint32, shuffleInPlace } = require('./rng');
const { PIECE_SET, POOLS } = require('./pieceSet');

const PIECES = Object.keys(PIECE_SET);
// The classic pool's lists; a rainbow-mode game uses POOLS.rainbow (§25).
const SPECIAL_PIECES = POOLS.classic.special;
const BAG_PIECES = POOLS.classic.bag;

// The pool a game uses: rainbow mode has its own (§25).
const poolName = (config) => (config && config.rainbowMode ? 'rainbow' : 'classic');
const poolFor = (config) => POOLS[poolName(config)];

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
  const rotations = [normalize(PIECE_SET[piece])];
  for (let k = 1; k < 4; k++) rotations.push(rotateClockwise(rotations[k - 1]));
  ROTATIONS[piece] = rotations;
}

// Bag: every piece of the pool's bag list once, in random order, reshuffled
// when exhausted. Special pieces are never dealt from the bag.
function createBag(seed, pool = 'classic') {
  return { rng: createRng(seed), queue: [], pool };
}

function drawPiece(bag) {
  if (bag.queue.length === 0) bag.queue = shuffleInPlace([...POOLS[bag.pool || 'classic'].bag], bag.rng);
  return bag.queue.shift();
}

// A random special piece for shuffles and line-clear rewards. It is picked
// outside the bag: the queue is untouched, so the bag cycle is unaffected.
function drawSpecialPiece(bag) {
  const special = POOLS[bag.pool || 'classic'].special;
  return special[nextInt(bag.rng, special.length)];
}

// §25: whether a dealt piece is a rainbow piece. Rolled with the player's own
// generator, so it stays hidden and deterministic like the rest of the bag.
// With no chance (rainbow mode off) nothing is rolled, so the bag's random
// sequence is exactly as without rainbow pieces.
function rollRainbow(bag, chance) {
  if (!(chance > 0)) return false;
  return nextUint32(bag.rng) / 2 ** 32 < chance;
}

module.exports = {
  PIECES,
  POOLS,
  SPECIAL_PIECES,
  BAG_PIECES,
  ROTATIONS,
  poolName,
  poolFor,
  createBag,
  drawPiece,
  drawSpecialPiece,
  rollRainbow,
};
