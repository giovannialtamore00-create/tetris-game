'use strict';

// The 2 s pause before every turn (§8).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { SOUTH, WEST } = require('../src/core/constants');
const game = require('../src/core/game');
const { buildState, move, tick, shuffle, ofType } = require('./helpers');

const O_ON_PYRAMID = { handIndex: 0, rotation: 0, x: 5, y: 6 };
const withPause = (fields = {}) =>
  buildState({ hands: { [SOUTH]: ['O', 'O', 'O', 'O'] }, config: { turnDelayMs: 2_000 }, ...fields });

describe('pause between turns', () => {
  it('starts the next turn 2 s after a move', () => {
    const { state, events } = move(withPause(), SOUTH, O_ON_PYRAMID, 3_000);
    assert.equal(state.phase, 'interlude');
    assert.equal(state.activeSeat, WEST);
    assert.equal(state.turnStartedAt, null);
    assert.deepEqual(ofType(events, 'interlude'), [{ type: 'interlude', nextSeat: WEST, at: 3_000, endsAt: 5_000 }]);
    assert.equal(game.nextDeadline(state), 5_000);

    const { state: live } = tick(state, 5_000);
    assert.equal(live.phase, 'turn');
    assert.equal(live.activeSeat, WEST);
    assert.equal(live.turnStartedAt, 5_000);
  });

  it('runs no personal clock during the pause', () => {
    const { state } = move(withPause(), SOUTH, O_ON_PYRAMID, 3_000);
    const before = state.players.map((p) => p.remainingMs);
    const { state: live } = tick(state, 5_000);
    assert.deepEqual(live.players.map((p) => p.remainingMs), before);
  });

  it('starts the AFK timer only when the turn itself starts', () => {
    const { state } = move(withPause(), SOUTH, O_ON_PYRAMID, 3_000);
    // Turn starts at 5 s, so the AFK pass falls at 15 s, not 13 s.
    const { events: early } = tick(state, 14_999);
    assert.equal(ofType(early, 'passed').length, 0);
    const { events } = tick(state, 15_000);
    assert.deepEqual(ofType(events, 'passed').map((e) => [e.seat, e.reason, e.at]), [[WEST, 'afk', 15_000]]);
  });

  it('pauses after an AFK pass too', () => {
    const { state } = tick(withPause(), 10_000);
    assert.equal(state.phase, 'interlude');
    assert.equal(state.activeSeat, WEST);
    assert.equal(state.interludeEndsAt, 12_000);
  });

  it('rejects moves during the pause, even from the player about to move', () => {
    const { state } = move(withPause(), SOUTH, O_ON_PYRAMID, 3_000);
    assert.deepEqual(game.applyMove(state, WEST, O_ON_PYRAMID, 4_000), { ok: false, error: 'notYourTurn' });
  });

  it('still allows shuffling during the pause', () => {
    const { state } = move(withPause({ players: { [WEST]: { shuffleAvailable: true } } }), SOUTH, O_ON_PYRAMID, 3_000);
    const { state: after } = shuffle(state, WEST, 4_000);
    assert.equal(after.players[WEST].shuffleAvailable, false);
    assert.equal(after.phase, 'interlude');
  });

  it('keeps the game clock running during the pause', () => {
    const state = { ...move(withPause(), SOUTH, O_ON_PYRAMID, 3_000).state, endsAt: 4_000 };
    const { state: after } = tick(state, 4_000);
    assert.equal(after.over, true);
    assert.equal(after.result.reason, 'timeUp');
  });
});
