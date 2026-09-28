'use strict';

const {
  SIZE,
  CELL_COUNT,
  EMPTY,
  BLOCKED,
  SOUTH,
  WEST,
  NORTH,
  EAST,
  SEAT_COUNT,
  idx,
  rowOf,
  colOf,
  inBounds,
} = require('./constants');
const { ROTATIONS } = require('./pieces');

const LAST = SIZE - 1;

const isCorner = (r, c) => (r === 0 || r === LAST) && (c === 0 || c === LAST);

// NEIGHBOURS[i] -> orthogonally adjacent cell indices.
const NEIGHBOURS = [];
for (let i = 0; i < CELL_COUNT; i++) {
  const r = rowOf(i);
  const c = colOf(i);
  NEIGHBOURS.push(
    [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]]
      .filter(([nr, nc]) => inBounds(nr, nc))
      .map(([nr, nc]) => idx(nr, nc)),
  );
}

// Maps a seat-relative position to a board cell. `depth` is the distance from
// the seat's edge (0 = on the edge); `lateral` runs 0..10 along the edge.
function seatCell(seat, depth, lateral) {
  switch (seat) {
    case SOUTH: return idx(LAST - depth, lateral);
    case WEST: return idx(lateral, depth);
    case NORTH: return idx(depth, LAST - lateral);
    case EAST: return idx(LAST - lateral, LAST - depth);
    default: throw new Error(`Unknown seat ${seat}`);
  }
}

// Root pyramid, seat-relative: [depth, firstLateral, lastLateral, hp].
const PYRAMID = [
  [0, 3, 7, 3],
  [1, 4, 6, 2],
  [2, 5, 5, 1],
];

// `root[i]` marks a surviving starting piece (§6). Only the starting pyramid
// sets it; destroying the piece clears it, and nothing ever sets it again.
function createEmptyBoard() {
  const owner = new Array(CELL_COUNT).fill(EMPTY);
  const hp = new Array(CELL_COUNT).fill(0);
  const root = new Array(CELL_COUNT).fill(false);
  for (let i = 0; i < CELL_COUNT; i++) {
    if (isCorner(rowOf(i), colOf(i))) owner[i] = BLOCKED;
  }
  return { owner, hp, root };
}

function createStartingBoard() {
  const board = createEmptyBoard();
  for (let seat = 0; seat < SEAT_COUNT; seat++) {
    for (const [depth, from, to, hp] of PYRAMID) {
      for (let lateral = from; lateral <= to; lateral++) {
        const i = seatCell(seat, depth, lateral);
        board.owner[i] = seat;
        board.hp[i] = hp;
        board.root[i] = true;
      }
    }
  }
  return board;
}

// Cells covered by a piece whose rotated bounding box has its top-left at
// (row y, column x), or null if any cell falls off the board.
function pieceCells(piece, rotation, x, y) {
  const offsets = ROTATIONS[piece] && ROTATIONS[piece][rotation];
  if (!offsets) return null;
  const cells = [];
  for (const [dr, dc] of offsets) {
    const r = y + dr;
    const c = x + dc;
    if (!inBounds(r, c)) return null;
    cells.push(idx(r, c));
  }
  return cells;
}

// §4: every cell empty (corners are BLOCKED, so never empty), and at least one
// cell orthogonally adjacent to a block the seat owns.
function isLegalPlacement(owner, seat, cells) {
  if (!cells) return false;
  if (!cells.every((i) => owner[i] === EMPTY)) return false;
  return cells.some((i) => NEIGHBOURS[i].some((n) => owner[n] === seat));
}

// Every distinct legal placement of the hand's pieces, as moves
// { handIndex, rotation, x, y }. Placements covering the same cells with the
// same piece (e.g. the O's identical rotations) are listed once.
function legalPlacements(owner, seat, hand) {
  const moves = [];
  const seen = new Set();
  hand.forEach((piece, handIndex) => {
    for (let rotation = 0; rotation < 4; rotation++) {
      for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
          const cells = pieceCells(piece, rotation, x, y);
          if (!isLegalPlacement(owner, seat, cells)) continue;
          const key = `${piece}:${[...cells].sort((a, b) => a - b).join(',')}`;
          if (seen.has(key)) continue;
          seen.add(key);
          moves.push({ handIndex, rotation, x, y });
        }
      }
    }
  });
  return moves;
}

function hasLegalMove(owner, seat, hand) {
  for (const piece of new Set(hand)) {
    for (let rotation = 0; rotation < 4; rotation++) {
      for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
          if (isLegalPlacement(owner, seat, pieceCells(piece, rotation, x, y))) return true;
        }
      }
    }
  }
  return false;
}

function countBlocks(owner, seat) {
  let n = 0;
  for (const o of owner) if (o === seat) n++;
  return n;
}

module.exports = {
  NEIGHBOURS,
  isCorner,
  seatCell,
  createEmptyBoard,
  createStartingBoard,
  pieceCells,
  isLegalPlacement,
  legalPlacements,
  hasLegalMove,
  countBlocks,
};
