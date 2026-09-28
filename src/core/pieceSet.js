'use strict';

// The full piece list and the piece pools, in one place so they can be tuned.
// Shapes are [row, col] offsets in rotation 0; the other rotations are
// derived by rotating clockwise.
const PIECE_SET = {
  I: [[0, 0], [0, 1], [0, 2], [0, 3]],
  O: [[0, 0], [0, 1], [1, 0], [1, 1]],
  T: [[0, 0], [0, 1], [0, 2], [1, 1]],
  S: [[0, 1], [0, 2], [1, 0], [1, 1]],
  Z: [[0, 0], [0, 1], [1, 1], [1, 2]],
  J: [[0, 0], [1, 0], [1, 1], [1, 2]],
  L: [[0, 2], [1, 0], [1, 1], [1, 2]],
  I3: [[0, 0], [0, 1], [0, 2]], // 1x3
  D: [[0, 0], [0, 1]], // 1x2 domino
  L3: [[0, 0], [1, 0], [1, 1]], // 3-cell small L
  M: [[0, 0]], // 1x1 single block
};

const TETROMINOES = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];

// Each game uses one pool (§3, §25):
// - `bag`: dealt exactly once per bag cycle, for starting hands and refills;
// - `special`: never in the bag, only handed out by a shuffle or (turn-based)
//   as a line-clear reward.
const POOLS = {
  classic: { bag: TETROMINOES, special: ['M', 'D', 'L3'] },
  rainbow: { bag: [...TETROMINOES, 'I3', 'D', 'L3'], special: ['M'] },
};

module.exports = { PIECE_SET, POOLS };
