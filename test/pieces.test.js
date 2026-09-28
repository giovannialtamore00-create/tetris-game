'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  PIECES,
  SPECIAL_PIECES,
  ROTATIONS,
  createBag,
  drawPiece,
  drawSpecialPiece,
} = require('../src/core/pieces');

describe('pieces', () => {
  it('has the 7 tetrominoes plus the 1x1, the 1x2 and the 3-cell small L', () => {
    assert.deepEqual([...PIECES].sort(), ['D', 'I', 'J', 'L', 'L3', 'M', 'O', 'S', 'T', 'Z']);
    const sizes = Object.fromEntries(PIECES.map((p) => [p, ROTATIONS[p][0].length]));
    for (const p of ['I', 'O', 'T', 'S', 'Z', 'J', 'L']) assert.equal(sizes[p], 4);
    assert.deepEqual([sizes.M, sizes.D, sizes.L3], [1, 2, 3]);
  });

  it('marks the three small pieces as special', () => {
    assert.deepEqual([...SPECIAL_PIECES].sort(), ['D', 'L3', 'M']);
  });

  it('gives every piece 4 rotations with the same number of cells', () => {
    for (const piece of PIECES) {
      assert.equal(ROTATIONS[piece].length, 4);
      for (const cells of ROTATIONS[piece]) assert.equal(cells.length, ROTATIONS[piece][0].length);
    }
  });

  it('rotates clockwise: I and the 1x2 turn vertical, O and the 1x1 never change', () => {
    assert.deepEqual(ROTATIONS.I[1], [[0, 0], [1, 0], [2, 0], [3, 0]]);
    assert.deepEqual(ROTATIONS.D[1], [[0, 0], [1, 0]]);
    for (const cells of ROTATIONS.O) assert.deepEqual(cells, ROTATIONS.O[0]);
    for (const cells of ROTATIONS.M) assert.deepEqual(cells, [[0, 0]]);
  });

  it('rotates the small L through its four orientations', () => {
    assert.deepEqual(ROTATIONS.L3.map((cells) => cells.map(([r, c]) => `${r}${c}`).join(' ')), [
      '00 10 11',
      '00 01 10',
      '00 01 11',
      '01 10 11',
    ]);
  });

  it('the bag deals every piece exactly once per 10 draws', () => {
    const bag = createBag(42);
    for (let round = 0; round < 3; round++) {
      const drawn = Array.from({ length: PIECES.length }, () => drawPiece(bag));
      assert.deepEqual([...drawn].sort(), [...PIECES].sort());
    }
  });

  it('bags are deterministic for a seed', () => {
    const a = createBag(7);
    const b = createBag(7);
    const draw = (bag) => Array.from({ length: 20 }, () => drawPiece(bag));
    assert.deepEqual(draw(a), draw(b));
  });

  it('picks special pieces outside the bag, leaving the bag cycle intact', () => {
    const bag = createBag(3);
    drawPiece(bag);
    const queueBefore = [...bag.queue];
    const specials = Array.from({ length: 30 }, () => drawSpecialPiece(bag));
    assert.deepEqual(bag.queue, queueBefore);
    assert.ok(specials.every((p) => SPECIAL_PIECES.includes(p)));
    assert.deepEqual([...new Set(specials)].sort(), ['D', 'L3', 'M']);
  });
});
