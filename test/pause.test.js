'use strict';

// Pausing and resuming (§22).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { SOUTH, WEST } = require('../src/core/constants');
const game = require('../src/core/game');
const { buildState, expectOk, move, tick, ofType } = require('./helpers');

const O_SOUTH = { handIndex: 0, rotation: 0, x: 5, y: 6 };
const O_HAND = ['O', 'O', 'O', 'O'];
const pause = (state, seat, now) => expectOk(game.pause(state, seat, now));
const resume = (state, seat, now) => expectOk(game.resume(state, seat, now));

describe('pause', () => {
  it('lets any player pause, and records who did', () => {
    const { state, events } = pause(buildState(), WEST, 3_000);
    assert.equal(state.pausedAt, 3_000);
    assert.equal(state.pausedBy, WEST);
    assert.deepEqual(events, [{ type: 'paused', seat: WEST, at: 3_000 }]);
    assert.equal(game.pause(state, SOUTH, 3_500).error, 'paused');
  });

  it('freezes every deadline while paused', () => {
    const { state } = pause(buildState(), WEST, 3_000);
    assert.equal(game.nextDeadline(state), null);
    const { events } = tick(state, 500_000); // long past the AFK timer and the game clock
    assert.deepEqual(events, []);
  });

  it('rejects moves and shuffles while paused', () => {
    const paused = pause(buildState({ hands: { [SOUTH]: O_HAND }, players: { [SOUTH]: { shuffleAvailable: true } } }), WEST, 1_000).state;
    assert.equal(game.applyMove(paused, SOUTH, O_SOUTH, 2_000).error, 'paused');
    assert.equal(game.shuffle(paused, SOUTH, 2_000).error, 'paused');
  });

  it('resumes exactly where it stopped: every pending time moves by the pause length', () => {
    // South's turn started at 0, so the AFK pass was due at 10 s. Paused from 3 s to 63 s.
    const paused = pause(buildState({ hands: { [SOUTH]: O_HAND } }), WEST, 3_000).state;
    const { state, events } = resume(paused, WEST, 63_000);
    assert.deepEqual(events, [{ type: 'resumed', seat: WEST, at: 63_000, pausedMs: 60_000 }]);
    assert.equal(state.pausedAt, null);
    assert.equal(state.turnStartedAt, 60_000);
    assert.equal(state.endsAt, 660_000);
    assert.equal(game.nextDeadline(state), 70_000); // AFK: still 7 s left, as when paused
    // South's clock is charged only for time actually played: 3 s before the pause, 1 s after.
    const { state: after } = move(state, SOUTH, O_SOUTH, 64_000);
    assert.equal(after.players[SOUTH].remainingMs, 58_000); // 60 s - 4 s played + 2 s bonus
  });

  it('shifts real-time cooldowns too', () => {
    const state = buildState({ config: { mode: 'realtime' }, hands: { [SOUTH]: O_HAND } });
    const cooling = move(state, SOUTH, O_SOUTH, 1_000).state; // cooldown until 3.3 s
    const paused = pause(cooling, WEST, 2_000).state;
    const resumed = resume(paused, WEST, 12_000).state;
    assert.equal(resumed.players[SOUTH].cooldownUntil, 13_300);
    assert.equal(game.applyMove(resumed, SOUTH, { ...O_SOUTH, handIndex: 1, x: 3, y: 7 }, 13_000).error, 'coolingDown');
  });

  it('cannot resume a game that is not paused', () => {
    assert.equal(game.resume(buildState(), SOUTH, 1_000).error, 'notPaused');
  });

  it('keeps the game clock stopped during the pause', () => {
    const state = { ...buildState(), endsAt: 5_000 };
    const paused = pause(state, SOUTH, 4_000).state;
    const resumed = resume(paused, SOUTH, 100_000).state;
    assert.equal(resumed.endsAt, 101_000);
    assert.equal(ofType(tick(resumed, 100_500).events, 'gameOver').length, 0);
  });
});
