'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { SEAT_COUNT, ALIVE } = require('../src/core/constants');
const game = require('../src/core/game');
const { expectOk, ofType } = require('./helpers');

describe('createGame', () => {
  const { state, events } = expectOk(game.createGame({ seed: 123, now: 1_000 }));

  it('starts four living players with 4-piece hands and full clocks', () => {
    assert.equal(state.players.length, SEAT_COUNT);
    for (const p of state.players) {
      assert.equal(p.status, ALIVE);
      assert.equal(p.hand.length, 4);
      assert.equal(p.remainingMs, 60_000);
      assert.equal(p.capMs, 60_000);
      assert.equal(p.score, 0);
    }
  });

  it('starts the 10-minute game clock and a live first turn', () => {
    assert.equal(state.endsAt, 601_000);
    assert.equal(state.phase, 'turn');
    assert.equal(state.turnStartedAt, 1_000);
    assert.deepEqual(ofType(events, 'turnStarted'), [
      { type: 'turnStarted', seat: state.activeSeat, round: 1, at: 1_000 },
    ]);
  });

  it('is deterministic for a seed', () => {
    assert.deepEqual(game.createGame({ seed: 123, now: 1_000 }).state, state);
  });

  it('picks the first player from the seed', () => {
    const firstSeats = new Set();
    for (let seed = 0; seed < 40; seed++) firstSeats.add(game.createGame({ seed }).state.activeSeat);
    assert.deepEqual([...firstSeats].sort(), [0, 1, 2, 3]);
  });
});
