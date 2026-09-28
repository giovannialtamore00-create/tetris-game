'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { SOUTH, WEST, NORTH, EAST, BLOCKED } = require('../src/core/constants');
const {
  createStartingBoard,
  pieceCells,
  isLegalPlacement,
  countBlocks,
} = require('../src/core/board');
const { parseBoard, at } = require('./helpers');

const LONE_SOUTH_ROOT = [
  '#.........#',
  '...........',
  '...........',
  '...........',
  '...........',
  '...........',
  '...........',
  '...........',
  '...........',
  '...........',
  '#....S....#',
];

describe('starting board', () => {
  const { owner, hp } = createStartingBoard();

  it('blocks the four corners', () => {
    for (const [r, c] of [[0, 0], [0, 10], [10, 0], [10, 10]]) assert.equal(owner[at(r, c)], BLOCKED);
  });

  it('gives every seat a 9-block pyramid', () => {
    for (const seat of [SOUTH, WEST, NORTH, EAST]) assert.equal(countBlocks(owner, seat), 9);
  });

  it('places the South pyramid as 5 x 3 HP, 3 x 2 HP, 1 x 1 HP', () => {
    for (let c = 3; c <= 7; c++) assert.deepEqual([owner[at(10, c)], hp[at(10, c)]], [SOUTH, 3]);
    for (let c = 4; c <= 6; c++) assert.deepEqual([owner[at(9, c)], hp[at(9, c)]], [SOUTH, 2]);
    assert.deepEqual([owner[at(8, 5)], hp[at(8, 5)]], [SOUTH, 1]);
  });

  it('rotates the pyramid onto the other edges', () => {
    for (let r = 3; r <= 7; r++) {
      assert.deepEqual([owner[at(r, 0)], hp[at(r, 0)]], [WEST, 3]);
      assert.deepEqual([owner[at(r, 10)], hp[at(r, 10)]], [EAST, 3]);
    }
    for (let c = 3; c <= 7; c++) assert.deepEqual([owner[at(0, c)], hp[at(0, c)]], [NORTH, 3]);
    assert.deepEqual([owner[at(5, 2)], owner[at(2, 5)], owner[at(5, 8)]], [WEST, NORTH, EAST]);
  });
});

describe('placement legality', () => {
  const { owner } = createStartingBoard();

  it('accepts an empty placement touching an own block', () => {
    assert.equal(isLegalPlacement(owner, SOUTH, pieceCells('O', 0, 5, 6)), true);
  });

  it('rejects a piece that runs off the board', () => {
    assert.equal(pieceCells('I', 0, 8, 7), null);
    assert.equal(isLegalPlacement(owner, SOUTH, pieceCells('I', 0, 8, 7)), false);
  });

  it('rejects overlapping an occupied cell', () => {
    assert.equal(isLegalPlacement(owner, SOUTH, pieceCells('O', 0, 5, 7)), false);
  });

  it('rejects a placement not touching any own block', () => {
    assert.equal(isLegalPlacement(owner, SOUTH, pieceCells('O', 0, 5, 4)), false);
  });

  it('rejects a placement touching only another player', () => {
    // Touches West's pyramid at (5,2) but no South block.
    assert.equal(isLegalPlacement(owner, SOUTH, pieceCells('O', 0, 3, 4)), false);
    assert.equal(isLegalPlacement(owner, WEST, pieceCells('O', 0, 3, 4)), true);
  });

  it('does not make placing on your own edge automatically legal', () => {
    const board = parseBoard(LONE_SOUTH_ROOT);
    assert.equal(isLegalPlacement(board.owner, SOUTH, pieceCells('O', 0, 1, 9)), false);
    assert.equal(isLegalPlacement(board.owner, SOUTH, pieceCells('O', 0, 3, 9)), true);
  });

  it('rejects covering a corner even when touching an own block', () => {
    const board = parseBoard(LONE_SOUTH_ROOT);
    board.owner[at(9, 2)] = SOUTH;
    // Covers (9,0), (9,1), (10,0) = corner, (10,1); (9,1) touches South at (9,2).
    assert.equal(isLegalPlacement(board.owner, SOUTH, pieceCells('O', 0, 0, 9)), false);
  });
});
