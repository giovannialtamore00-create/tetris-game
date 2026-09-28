'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  PIECES,
  SPECIAL_PIECES,
  BAG_PIECES,
  POOLS,
  poolFor,
  ROTATIONS,
  createBag,
  drawPiece,
  drawSpecialPiece,
} = require('../src/core/pieces');

describe('pieces', () => {
  it('has the 7 tetrominoes plus the 1x3, the 1x2, the small L and the 1x1', () => {
    assert.deepEqual([...PIECES].sort(), ['D', 'I', 'I3', 'J', 'L', 'L3', 'M', 'O', 'S', 'T', 'Z']);
    const sizes = Object.fromEntries(PIECES.map((p) => [p, ROTATIONS[p][0].length]));
    for (const p of ['I', 'O', 'T', 'S', 'Z', 'J', 'L']) assert.equal(sizes[p], 4);
    assert.deepEqual([sizes.M, sizes.D, sizes.L3, sizes.I3], [1, 2, 3, 3]);
  });

  it('classic pool: the 1x1, 1x2 and small L are special', () => {
    assert.deepEqual([...SPECIAL_PIECES].sort(), ['D', 'L3', 'M']);
    assert.deepEqual(poolFor({}), POOLS.classic);
  });

  it('rainbow-mode pool: only the 1x1 is special', () => {
    assert.deepEqual(POOLS.rainbow.special, ['M']);
    assert.deepEqual(poolFor({ rainbowMode: true }), POOLS.rainbow);
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
    assert.deepEqual(ROTATIONS.I3[1], [[0, 0], [1, 0], [2, 0]]);
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

  it('classic bag: deals each tetromino exactly once per 7 draws and never a special piece', () => {
    assert.deepEqual([...BAG_PIECES].sort(), ['I', 'J', 'L', 'O', 'S', 'T', 'Z']);
    const bag = createBag(42);
    for (let round = 0; round < 3; round++) {
      const drawn = Array.from({ length: 7 }, () => drawPiece(bag));
      assert.deepEqual([...drawn].sort(), [...BAG_PIECES].sort());
    }
  });

  it('rainbow-mode bag: deals each of its 10 pieces exactly once per 10 draws and never the 1x1', () => {
    assert.deepEqual([...POOLS.rainbow.bag].sort(), ['D', 'I', 'I3', 'J', 'L', 'L3', 'O', 'S', 'T', 'Z']);
    const bag = createBag(42, 'rainbow');
    for (let round = 0; round < 3; round++) {
      const drawn = Array.from({ length: 10 }, () => drawPiece(bag));
      assert.deepEqual([...drawn].sort(), [...POOLS.rainbow.bag].sort());
    }
    assert.ok(Array.from({ length: 30 }, () => drawSpecialPiece(bag)).every((p) => p === 'M'));
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
