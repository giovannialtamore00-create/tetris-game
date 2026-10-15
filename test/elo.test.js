'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { START_RATING, expectedScore, updateRatings } = require('../src/core/elo');

const r = (id, rating, rank) => ({ id, rating, rank });

describe('elo', () => {
  it('expects 50% between equal players and favours the higher rating', () => {
    assert.equal(expectedScore(1000, 1000), 0.5);
    assert.ok(expectedScore(1200, 1000) > 0.75);
    assert.ok(Math.abs(expectedScore(1200, 1000) + expectedScore(1000, 1200) - 1) < 1e-12);
  });

  it('1v1 between equals moves K/2 each way', () => {
    const [a, b] = updateRatings([r('a', START_RATING, 1), r('b', START_RATING, 2)]);
    assert.deepEqual([a.change, b.change], [16, -16]);
  });

  it('a draw between equals changes nothing; a draw moves points toward the lower rating', () => {
    assert.deepEqual(updateRatings([r('a', 1000, 1), r('b', 1000, 1)]).map((x) => x.change), [0, 0]);
    const [hi, lo] = updateRatings([r('a', 1200, 1), r('b', 1000, 1)]);
    assert.ok(hi.change < 0 && lo.change > 0);
  });

  it('beating a stronger player pays more than beating a weaker one', () => {
    const up = updateRatings([r('a', 1000, 1), r('b', 1200, 2)])[0].change;
    const down = updateRatings([r('a', 1200, 1), r('b', 1000, 2)])[0].change;
    assert.ok(up > down);
  });

  it('4 players: changes follow rank and roughly cancel out', () => {
    const out = updateRatings([r('a', 1000, 1), r('b', 1000, 2), r('c', 1000, 3), r('d', 1000, 4)]);
    const c = out.map((x) => x.change);
    assert.deepEqual(c, [...c].sort((x, y) => y - x));
    assert.ok(c[0] > 0 && c[3] < 0);
    assert.ok(Math.abs(c.reduce((s, x) => s + x, 0)) <= 2);
  });

  it('a single player or nobody changes nothing', () => {
    assert.deepEqual(updateRatings([r('a', 1000, 1)]), [{ id: 'a', rating: 1000, change: 0 }]);
    assert.deepEqual(updateRatings([]), []);
  });
});
