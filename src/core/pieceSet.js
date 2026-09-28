'use strict';

// The full piece list, in one place so it can be tuned. Shapes are [row, col]
// offsets in rotation 0; the other rotations are derived by rotating clockwise.
//
// - Every shape is dealt exactly once per bag cycle (§3).
// - Shapes marked `special` also form the pool that shuffle and line-clear
//   reward pieces are picked from.
const PIECE_SET = {
  I: { cells: [[0, 0], [0, 1], [0, 2], [0, 3]], special: false },
  O: { cells: [[0, 0], [0, 1], [1, 0], [1, 1]], special: false },
  T: { cells: [[0, 0], [0, 1], [0, 2], [1, 1]], special: false },
  S: { cells: [[0, 1], [0, 2], [1, 0], [1, 1]], special: false },
  Z: { cells: [[0, 0], [0, 1], [1, 1], [1, 2]], special: false },
  J: { cells: [[0, 0], [1, 0], [1, 1], [1, 2]], special: false },
  L: { cells: [[0, 2], [1, 0], [1, 1], [1, 2]], special: false },
  M: { cells: [[0, 0]], special: true }, // 1x1 single block
  D: { cells: [[0, 0], [0, 1]], special: true }, // 1x2 domino
  L3: { cells: [[0, 0], [1, 0], [1, 1]], special: true }, // 3-cell small L
};

module.exports = { PIECE_SET };
