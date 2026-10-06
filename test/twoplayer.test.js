'use strict';

// Two-player games (§26): South vs North, the other two sides empty.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { SOUTH, WEST, NORTH, EAST, ABSENT, ALIVE } = require('../src/core/constants');
const { countBlocks } = require('../src/core/board');
const game = require('../src/core/game');
const { buildState, expectOk, tick, move, ofType } = require('./helpers');

const TWO = { playerCount: 2 };

describe('two-player games', () => {
  it('seats South and North only, with pyramids on their sides', () => {
    const { state } = expectOk(game.createGame({ seed: 3, config: TWO }));
    assert.deepEqual(state.players.map((p) => p.status), [ALIVE, ABSENT, ALIVE, ABSENT]);
    assert.deepEqual([SOUTH, WEST, NORTH, EAST].map((k) => countBlocks(state.owner, k)), [9, 0, 9, 0]);
    assert.deepEqual(state.players[WEST].hand, []);
  });

  it('lets South or North start, never an empty side', () => {
    const first = new Set();
    for (let seed = 0; seed < 40; seed++) first.add(game.createGame({ seed, config: TWO }).state.activeSeat);
    assert.deepEqual([...first].sort(), [SOUTH, NORTH]);
  });

  it('alternates turns between the two players, and a round is two turns', () => {
    const state = buildState({ config: TWO });
    const { state: after, events } = tick(state, 40_000);
    assert.deepEqual(ofType(events, 'passed').map((e) => e.seat), [SOUTH, NORTH, SOUTH, NORTH]);
    assert.equal(ofType(events, 'roundEnded').length, 2);
    // Passive round points only go to the two players.
    assert.deepEqual(after.players.map((p) => p.score), [2, 0, 2, 0]);
  });

  it('works in real-time mode', () => {
    const state = buildState({ config: { ...TWO, mode: 'realtime' }, hands: { [NORTH]: ['O', 'O', 'O', 'O'] } });
    const { state: after } = move(state, NORTH, { handIndex: 0, rotation: 0, x: 4, y: 3 }, 1_000);
    assert.equal(after.owner[3 * 11 + 4], NORTH);
    assert.equal(game.applyMove(after, WEST, { handIndex: 0, rotation: 0, x: 0, y: 4 }, 2_000).error, 'notAlive');
  });

  it('ranks only the two players', () => {
    const { state } = tick({ ...buildState({ config: TWO }), endsAt: 5_000 }, 5_000);
    assert.equal(state.over, true);
    assert.deepEqual(state.result.standings.map((r) => r.seat).sort(), [SOUTH, NORTH]);
  });

  it('does not let an empty side pause the game', () => {
    assert.equal(game.pause(buildState({ config: TWO }), WEST, 1_000).error, 'notInGame');
  });
});
