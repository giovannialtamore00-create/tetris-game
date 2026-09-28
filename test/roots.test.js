'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { SOUTH, NORTH, EMPTY } = require('../src/core/constants');
const { buildState, move, tick, at, ofType } = require('./helpers');

// South's starting pieces are (10,5) and (10,6); (10,7) is a block South placed
// later on its own edge, anchored only through the starting piece at (10,6).
// South plays a horizontal I at (5,6)-(5,9), completing column 6: every block
// in the column takes a hit and all but North's 3 HP starting piece at (0,6)
// are destroyed, including South's starting piece at (10,6).
const COLUMN_SIX = [
  '#.....n...#',
  '......N....',
  'w.....N...e',
  '......N....',
  '......N....',
  '...........',
  '......S....',
  '......S....',
  '......S....',
  '......S....',
  '#....ssS..#',
];
const COLUMN_SIX_HP = [
  '......3....',
  '...........',
  '...........',
  '...........',
  '...........',
  '...........',
  '...........',
  '...........',
  '...........',
  '...........',
  '...........',
];
const HORIZONTAL_I = { handIndex: 0, rotation: 0, x: 6, y: 5 };

function playColumnSix() {
  const state = buildState({
    rows: COLUMN_SIX,
    hpRows: COLUMN_SIX_HP,
    hands: { [SOUTH]: ['I', 'O', 'O', 'O'] },
  });
  return move(state, SOUTH, HORIZONTAL_I, 1_000);
}

describe('roots', () => {
  it('a block placed later on the player\'s own edge, cut off from the starting pieces, detonates', () => {
    const { state, events } = playColumnSix();
    assert.equal(state.owner[at(10, 7)], EMPTY);
    const detonated = ofType(events, 'detonated').map((e) => e.cells);
    assert.deepEqual(
      detonated.find((cells) => cells.includes(at(10, 7))),
      [at(10, 7)],
    );
    // South's other starting piece survives and is still a root.
    assert.equal(state.owner[at(10, 5)], SOUTH);
    assert.equal(state.root[at(10, 5)], true);
    // North's starting piece at the top of the column survives with 2 HP.
    assert.deepEqual([state.owner[at(0, 6)], state.hp[at(0, 6)], state.root[at(0, 6)]], [NORTH, 2, true]);
  });

  it('a destroyed starting piece is gone: a block placed in its cell later is not a root', () => {
    const { state: afterClear } = playColumnSix();
    assert.equal(afterClear.root[at(10, 6)], false);

    // West, North and East are AFK-passed; South then fills (9,6)-(10,7) with an O.
    const { state: southAgain } = tick(afterClear, 31_000);
    assert.equal(southAgain.activeSeat, SOUTH);
    const { state } = move(southAgain, SOUTH, { handIndex: 1, rotation: 0, x: 6, y: 9 }, 32_000);
    assert.equal(state.owner[at(10, 6)], SOUTH);
    assert.equal(state.root[at(10, 6)], false);
  });
});
