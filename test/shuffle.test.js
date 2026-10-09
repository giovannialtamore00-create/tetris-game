'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { SOUTH, WEST, NORTH, EAST, TIMED_OUT } = require('../src/core/constants');
const game = require('../src/core/game');
const { SPECIAL_PIECES, drawSpecialPiece } = require('../src/core/pieces');
const { hasLegalMove } = require('../src/core/board');
const {
  buildState,
  fullBoardRows,
  move,
  tick,
  shuffle,
  startTurn,
  ofType,
  scores,
} = require('./helpers');

const O_ON_PYRAMID = { handIndex: 0, rotation: 0, x: 5, y: 6 };
const O_HAND = ['O', 'O', 'O', 'O'];

// A full board with a single-cell hole at (8,4) that only South borders: only
// the 1x1 fits it.
function boardWithSouthHole() {
  const rows = fullBoardRows();
  rows[8] = rows[8].slice(0, 4) + '.' + rows[8].slice(5);
  return rows;
}

// A bag RNG state whose next special-piece pick is `piece`.
function rngStateGiving(piece) {
  for (let s = 0; ; s++) {
    if (drawSpecialPiece({ rng: { s }, queue: [] }) === piece) return s;
  }
}

describe('shuffle offer', () => {
  it('persists across AFK passes and is cleared by a legal move', () => {
    const state = buildState({
      hands: { [SOUTH]: O_HAND },
      players: { [SOUTH]: { shuffleAvailable: true } },
    });
    const afterRound = tick(state, 40_000).state;
    assert.equal(afterRound.players[SOUTH].shuffleAvailable, true);
    assert.equal(afterRound.activeSeat, SOUTH);

    const { state: afterMove } = move(afterRound, SOUTH, O_ON_PYRAMID, 41_000);
    assert.equal(afterMove.players[SOUTH].shuffleAvailable, false);
  });

  it('can be used once per offer', () => {
    const state = buildState({ players: { [SOUTH]: { shuffleAvailable: true } } });
    const { state: after, events } = shuffle(state, SOUTH, 1_000);
    assert.equal(after.players[SOUTH].shuffleAvailable, false);
    assert.equal(after.players[SOUTH].hand.length, 4);
    assert.equal(ofType(events, 'shuffled').length, 1);
    assert.deepEqual(game.shuffle(after, SOUTH, 1_500), { ok: false, error: 'noShuffleAvailable' });
  });

  it('can be used during another player\'s turn without affecting it', () => {
    const state = buildState({ players: { [WEST]: { shuffleAvailable: true } } });
    const { state: after } = shuffle(state, WEST, 1_000);
    assert.equal(after.activeSeat, SOUTH);
    assert.equal(after.turnStartedAt, 0);
    assert.equal(after.players[WEST].shuffleAvailable, false);
  });

  it('cannot be used by a player who is not alive', () => {
    const state = buildState({
      statuses: { [WEST]: TIMED_OUT },
      players: { [WEST]: { shuffleAvailable: true } },
    });
    assert.deepEqual(game.shuffle(state, WEST, 1_000), { ok: false, error: 'notAlive' });
  });

  it('deals 3 bag pieces and 1 special piece in the last slot', () => {
    const state = buildState({ players: { [SOUTH]: { shuffleAvailable: true } } });
    state.players[SOUTH].bag.queue = ['I', 'T', 'Z'];
    const { state: after } = shuffle(state, SOUTH, 1_000);
    const hand = after.players[SOUTH].hand;
    assert.deepEqual(hand.slice(0, 3), ['I', 'T', 'Z']);
    assert.ok(SPECIAL_PIECES.includes(hand[3]), `expected a special piece, got ${hand[3]}`);
  });

  it('force-passes a player who shuffles into a stuck hand on their own turn', () => {
    const state = buildState({
      rows: boardWithSouthHole(),
      hands: { [SOUTH]: ['M', 'O', 'O', 'O'] },
      players: { [SOUTH]: { shuffleAvailable: true, remainingMs: 40_000 } },
    });
    // Three Os from the bag and a 1x2 as the special piece: none fits a 1-cell hole.
    state.players[SOUTH].bag.queue = ['O', 'O', 'O'];
    state.players[SOUTH].bag.rng.s = rngStateGiving('D');

    const { state: after, events } = shuffle(state, SOUTH, 3_000);
    const passes = ofType(events, 'passed');
    assert.deepEqual(passes[0], { type: 'passed', seat: SOUTH, reason: 'noLegalMoves', at: 3_000 });
    // 3 s charged for the time used, then the forced-pass bonus.
    assert.equal(after.players[SOUTH].remainingMs, 42_000);
    // The next forced pass grants a fresh offer.
    assert.equal(after.players[SOUTH].shuffleAvailable, true);
  });
});

describe('stuck table', () => {
  const stuck = () => startTurn(buildState({ rows: fullBoardRows(), live: false }), SOUTH, 0);

  it('an all-pass round still awards passive points and decays caps', () => {
    const { state, events } = stuck();
    assert.deepEqual(ofType(events, 'passed').map((e) => [e.seat, e.reason]), [
      [SOUTH, 'noLegalMoves'],
      [WEST, 'noLegalMoves'],
      [NORTH, 'noLegalMoves'],
      [EAST, 'noLegalMoves'],
    ]);
    assert.deepEqual(scores(state), [1, 1, 1, 1]);
    assert.deepEqual(state.players.map((p) => p.capMs), [59_000, 59_000, 59_000, 59_000]);
    assert.deepEqual(state.players.map((p) => p.shuffleAvailable), [true, true, true, true]);
    assert.equal(state.phase, 'shuffleWindow');
    assert.equal(state.shuffleWindowEndsAt, 10_000);
  });

  it('the shuffle window pauses personal clocks', () => {
    const { state } = stuck();
    assert.equal(game.nextDeadline(state), 10_000);
    const { state: after, events } = tick(state, 10_000);
    assert.equal(ofType(events, 'shuffleWindowClosed').length, 1);
    assert.deepEqual(after.players.map((p) => p.remainingMs), [60_000, 60_000, 60_000, 60_000]);
  });

  it('the shuffle window closes early once every stuck player has shuffled', () => {
    let { state } = stuck();
    for (const seat of [SOUTH, WEST, NORTH]) {
      state = shuffle(state, seat, 3_000).state;
      assert.equal(state.phase, 'shuffleWindow');
    }
    const { state: after, events } = shuffle(state, EAST, 3_000);
    assert.deepEqual(ofType(events, 'shuffleWindowClosed'), [{ type: 'shuffleWindowClosed', at: 3_000 }]);
    // Still stuck on a full board: a new round of forced passes, fresh offers, a new window.
    assert.equal(ofType(events, 'passed').length, 4);
    assert.deepEqual(after.players.map((p) => p.shuffleAvailable), [true, true, true, true]);
    assert.equal(after.shuffleWindowEndsAt, 13_000);
  });

  it('consecutive all-stuck rounds are paced by the window, never looped instantly', () => {
    const { state } = stuck();
    const { state: after, events } = tick(state, 35_000);
    assert.deepEqual(ofType(events, 'roundEnded').map((e) => e.at), [10_000, 20_000, 30_000]);
    assert.deepEqual(scores(after), [4, 4, 4, 4]);
    assert.equal(after.round, 5);
    assert.equal(after.shuffleWindowEndsAt, 40_000);
  });
});

describe('shuffle when boxed in (rainbow mode)', () => {
  // A full board with a 2-cell hole in North's area: South borders no empty cell.
  function boxedIn(seed) {
    const rows = fullBoardRows();
    rows[2] = rows[2].slice(0, 4) + '..' + rows[2].slice(6);
    return buildState({
      rows,
      seed,
      hands: { [SOUTH]: O_HAND },
      players: { [SOUTH]: { shuffleAvailable: true } },
      config: { rainbowMode: true },
    });
  }

  it('grants two rainbow pieces, one a 1x1 or 1x2, and a legal move', () => {
    const smalls = new Set();
    for (let seed = 1; seed <= 20; seed++) {
      const state = boxedIn(seed);
      assert.equal(hasLegalMove(state.owner, SOUTH, state.players[SOUTH].hand, state.players[SOUTH].rainbow), false);
      const result = game.shuffle(state, SOUTH, 0);
      assert.equal(result.ok, true, result.error);
      const p = result.state.players[SOUTH];
      assert.equal(p.rainbow[0], true);
      assert.equal(p.rainbow[3], true);
      assert.ok(['M', 'D'].includes(p.hand[3]), `got ${p.hand[3]}`);
      assert.equal(hasLegalMove(result.state.owner, SOUTH, p.hand, p.rainbow), true);
      smalls.add(p.hand[3]);
    }
    assert.deepEqual([...smalls].sort(), ['D', 'M']);
  });

  it('deals normally when a legal move exists', () => {
    const state = buildState({
      hands: { [SOUTH]: O_HAND },
      players: { [SOUTH]: { shuffleAvailable: true } },
      config: { rainbowMode: true },
    });
    const p = game.shuffle(state, SOUTH, 0).state.players[SOUTH];
    assert.deepEqual(p.rainbow, [false, false, false, false]);
    assert.equal(p.hand[3], 'M');
  });
});
