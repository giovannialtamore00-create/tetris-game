'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { SEAT_COUNT, ALIVE } = require('../src/core/constants');
const game = require('../src/core/game');
const { BAG_PIECES } = require('../src/core/pieces');
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

  it('deals starting hands from the bag only, with no special pieces', () => {
    for (let seed = 0; seed < 20; seed++) {
      for (const p of game.createGame({ seed }).state.players) {
        assert.ok(p.hand.every((piece) => BAG_PIECES.includes(piece)), `seed ${seed}: ${p.hand}`);
      }
    }
  });

  it('starts the 10-minute game clock and the first turn after the 2 s pause', () => {
    assert.equal(state.endsAt, 601_000);
    assert.equal(state.phase, 'interlude');
    assert.equal(state.turnStartedAt, null);
    assert.deepEqual(ofType(events, 'interlude'), [
      { type: 'interlude', nextSeat: state.activeSeat, at: 1_000, endsAt: 3_000 },
    ]);
    const { state: live, events: started } = expectOk(game.tick(state, 3_000));
    assert.equal(live.phase, 'turn');
    assert.equal(live.turnStartedAt, 3_000);
    assert.deepEqual(ofType(started, 'turnStarted'), [
      { type: 'turnStarted', seat: state.activeSeat, round: 1, at: 3_000 },
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
