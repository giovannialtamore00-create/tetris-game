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
  isOccupied,
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

// Pyramids for the seats in play (all four, or South and North in a 2-player game, §26).
function createStartingBoard(seats = [0, 1, 2, 3]) {
  const board = createEmptyBoard();
  for (const seat of seats) {
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
// cell orthogonally adjacent to a block the seat owns. §25: a rainbow piece
// may instead touch any block at all (any player's, grey or rainbow).
function isLegalPlacement(owner, seat, cells, rainbow = false) {
  if (!cells) return false;
  if (!cells.every((i) => owner[i] === EMPTY)) return false;
  const touches = rainbow ? (o) => isOccupied(o) : (o) => o === seat;
  return cells.some((i) => NEIGHBOURS[i].some((n) => touches(owner[n])));
}

// Every distinct legal placement of the hand's pieces, as moves
// { handIndex, rotation, x, y }. Placements covering the same cells with the
// same kind of piece (e.g. the O's identical rotations) are listed once.
// `rainbow[k]` says whether hand piece k is a rainbow piece.
function legalPlacements(owner, seat, hand, rainbow = []) {
  const moves = [];
  const seen = new Set();
  hand.forEach((piece, handIndex) => {
    const isRainbow = Boolean(rainbow[handIndex]);
    for (let rotation = 0; rotation < 4; rotation++) {
      for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
          const cells = pieceCells(piece, rotation, x, y);
          if (!isLegalPlacement(owner, seat, cells, isRainbow)) continue;
          const key = `${piece}:${isRainbow}:${[...cells].sort((a, b) => a - b).join(',')}`;
          if (seen.has(key)) continue;
          seen.add(key);
          moves.push({ handIndex, rotation, x, y });
        }
      }
    }
  });
  return moves;
}

function hasLegalMove(owner, seat, hand, rainbow = []) {
  const tried = new Set();
  for (let k = 0; k < hand.length; k++) {
    const piece = hand[k];
    const isRainbow = Boolean(rainbow[k]);
    const key = `${piece}:${isRainbow}`;
    if (tried.has(key)) continue;
    tried.add(key);
    for (let rotation = 0; rotation < 4; rotation++) {
      for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
          if (isLegalPlacement(owner, seat, pieceCells(piece, rotation, x, y), isRainbow)) return true;
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
