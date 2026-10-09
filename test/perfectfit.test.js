'use strict';

// Hidden reward (§25): a piece that plugs a hole exactly (no empty neighbour
// once placed; board edge and corners count as closed) refills its slot with a
// rainbow 1x1 instead of a bag draw, in both modes.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { SOUTH } = require('../src/core/constants');
const { isPerfectFit, pieceCells } = require('../src/core/board');
const { buildState, move, at, ofType } = require('./helpers');

const top = ['#..n......#', '...........', '...........', '...........', '...........', 'w.........e', '...........'];
// A one-cell hole at (9,5), closed on all four sides by South.
const INNER_HOLE = [...top, '...........', '....SSS....', '....S.S....', '#...sss...#'];
// A one-cell hole at (10,5) on South's edge: the board edge closes its bottom side.
const EDGE_HOLE = [...top, '...........', '...........', '....SSS....', '#...s.s...#'];
// A one-cell hole at (10,1) next to the corner: the corner closes its left side.
const CORNER_HOLE = [...top, '...........', '...........', '.SS........', '#.s.......#'];

const ONE = (x, y) => ({ handIndex: 0, rotation: 0, x, y });
const state = (rows, config = {}) => {
  const s = buildState({ rows, config, hands: { [SOUTH]: ['M', 'O', 'O', 'O'] } });
  s.players[SOUTH].bag.queue = ['T'];
  return s;
};

describe('hidden reward: perfect fit', () => {
  it('detects holes closed by blocks, the board edge and corners', () => {
    const cellsAt = (x, y) => pieceCells('M', 0, x, y);
    assert.equal(isPerfectFit(state(INNER_HOLE).owner, cellsAt(5, 9)), true);
    assert.equal(isPerfectFit(state(EDGE_HOLE).owner, cellsAt(5, 10)), true);
    assert.equal(isPerfectFit(state(CORNER_HOLE).owner, cellsAt(1, 10)), true);
    assert.equal(isPerfectFit(state(INNER_HOLE).owner, cellsAt(5, 7)), false);
  });

  it('gives a rainbow 1x1 in real-time, keeping the normal cooldown', () => {
    const { state: after, events } = move(state(INNER_HOLE, { mode: 'realtime' }), SOUTH, ONE(5, 9), 1_000);
    assert.equal(after.owner[at(9, 5)], SOUTH);
    assert.equal(after.players[SOUTH].hand[0], 'M');
    assert.equal(after.players[SOUTH].rainbow[0], true);
    assert.deepEqual(ofType(events, 'rewardPiece'), [
      { type: 'rewardPiece', seat: SOUTH, piece: 'M', handIndex: 0, rainbow: true, reason: 'perfectFit' },
    ]);
    assert.equal(after.players[SOUTH].cooldownUntil, 3_300);
  });

  it('gives a rainbow 1x1 in turn-based mode', () => {
    const { state: after, events } = move(state(EDGE_HOLE), SOUTH, ONE(5, 10), 0);
    assert.equal(after.players[SOUTH].hand[0], 'M');
    assert.equal(after.players[SOUTH].rainbow[0], true);
    assert.equal(ofType(events, 'rewardPiece')[0].reason, 'perfectFit');
  });

  it('gives nothing extra when the piece leaves an empty side', () => {
    const { state: after, events } = move(state(INNER_HOLE, { mode: 'realtime' }), SOUTH, ONE(5, 7), 1_000);
    assert.equal(after.players[SOUTH].hand[0], 'T');
    assert.equal(after.players[SOUTH].rainbow[0], false);
    assert.equal(ofType(events, 'rewardPiece').length, 0);
  });
});
