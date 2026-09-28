'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { PIECES, ROTATIONS, createBag, drawPiece } = require('../src/core/pieces');

describe('pieces', () => {
  it('has the 7 tetrominoes, each with 4 rotations of 4 cells', () => {
    assert.deepEqual([...PIECES].sort(), ['I', 'J', 'L', 'O', 'S', 'T', 'Z']);
    for (const piece of PIECES) {
      assert.equal(ROTATIONS[piece].length, 4);
      for (const cells of ROTATIONS[piece]) assert.equal(cells.length, 4);
    }
  });

  it('rotates clockwise: I rotation 1 is vertical, O never changes', () => {
    assert.deepEqual(ROTATIONS.I[1], [[0, 0], [1, 0], [2, 0], [3, 0]]);
    for (const cells of ROTATIONS.O) assert.deepEqual(cells, ROTATIONS.O[0]);
  });

  it('7-bag deals every piece exactly once per 7 draws', () => {
    const bag = createBag(42);
    for (let round = 0; round < 3; round++) {
      const drawn = Array.from({ length: 7 }, () => drawPiece(bag));
      assert.deepEqual([...drawn].sort(), [...PIECES].sort());
    }
  });

  it('bags are deterministic for a seed', () => {
    const a = createBag(7);
    const b = createBag(7);
    const draw = (bag) => Array.from({ length: 14 }, () => drawPiece(bag));
    assert.deepEqual(draw(a), draw(b));
  });
});
