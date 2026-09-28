'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { SOUTH, WEST, NORTH, EAST, TIMED_OUT } = require('../src/core/constants');
const game = require('../src/core/game');
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

// A full board with a 1x4 horizontal gap at (8,3)-(8,6) that only South
// borders: South can fill it with an I, and with nothing else.
function boardWithSouthGap() {
  const rows = fullBoardRows();
  rows[8] = rows[8].slice(0, 3) + '....' + rows[8].slice(7);
  return rows;
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

  it('force-passes a player who shuffles into a stuck hand on their own turn', () => {
    const state = buildState({
      rows: boardWithSouthGap(),
      hands: { [SOUTH]: ['I', 'O', 'O', 'O'] },
      players: { [SOUTH]: { shuffleAvailable: true, remainingMs: 40_000 } },
    });
    state.players[SOUTH].bag.queue = ['O', 'O', 'O', 'O'];

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
