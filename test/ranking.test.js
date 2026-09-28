'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { CELL_COUNT, EMPTY, ALIVE, ELIMINATED, TIMED_OUT } = require('../src/core/constants');
const { rankPlayers } = require('../src/core/ranking');

// players: [[score, status, blocks], ...] indexed by seat.
function rank(players) {
  const owner = new Array(CELL_COUNT).fill(EMPTY);
  let next = 0;
  const list = players.map(([score, status, blocks], seat) => {
    for (let k = 0; k < blocks; k++) owner[next++] = seat;
    return { seat, score, status };
  });
  return rankPlayers(list, owner);
}

describe('ranking', () => {
  it('ranks by points first, even above living players', () => {
    const result = rank([[5, ALIVE, 9], [8, ELIMINATED, 0], [3, ALIVE, 20], [1, TIMED_OUT, 4]]);
    assert.deepEqual(result.standings.map((r) => r.seat), [1, 0, 2, 3]);
    assert.deepEqual(result.winners, [1]);
    assert.equal(result.draw, false);
  });

  it('living beats not-living on equal score', () => {
    const result = rank([[5, TIMED_OUT, 30], [5, ALIVE, 1], [2, ALIVE, 9], [0, ALIVE, 9]]);
    assert.deepEqual(result.winners, [1]);
  });

  it('all-living tie broken by blocks on board', () => {
    const result = rank([[5, ALIVE, 7], [5, ALIVE, 9], [2, ALIVE, 9], [0, ALIVE, 9]]);
    assert.deepEqual(result.winners, [1]);
    assert.deepEqual(result.standings.slice(0, 2).map((r) => [r.seat, r.rank]), [[1, 1], [0, 2]]);
  });

  it('all-not-living tie broken by dulled blocks', () => {
    const result = rank([[5, TIMED_OUT, 3], [5, TIMED_OUT, 6], [2, ALIVE, 9], [0, ALIVE, 9]]);
    assert.deepEqual(result.winners, [1]);
  });

  it('eliminated (0 blocks) loses to timed-out with dulled blocks', () => {
    const result = rank([[5, ELIMINATED, 0], [5, TIMED_OUT, 2], [2, ALIVE, 9], [0, ALIVE, 9]]);
    assert.deepEqual(result.winners, [1]);
  });

  it('remaining tie is a draw', () => {
    const result = rank([[5, ALIVE, 9], [5, ALIVE, 9], [2, ALIVE, 9], [0, ALIVE, 9]]);
    assert.deepEqual(result.winners, [0, 1]);
    assert.equal(result.draw, true);
  });

  it('a three-way tie narrows step by step', () => {
    // Seat 3 drops out at step 1 (not alive); seat 0 at step 2 (fewer blocks).
    const result = rank([[7, ALIVE, 4], [7, ALIVE, 8], [7, ALIVE, 8], [7, TIMED_OUT, 20]]);
    assert.deepEqual(result.winners, [1, 2]);
    assert.equal(result.draw, true);
    assert.deepEqual(result.standings.map((r) => [r.seat, r.rank]), [[1, 1], [2, 1], [0, 3], [3, 4]]);
  });
});
