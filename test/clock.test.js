'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { SOUTH, WEST, NORTH, EAST, GREY, TIMED_OUT, ALIVE } = require('../src/core/constants');
const game = require('../src/core/game');
const { buildState, move, tick, at, ofType, scores } = require('./helpers');

// Default starting board; South has a legal O at x=5, y=6 on top of its pyramid.
const O_ON_PYRAMID = { handIndex: 0, rotation: 0, x: 5, y: 6 };
const O_HAND = ['O', 'O', 'O', 'O'];
const southTurn = (players = {}, extra = {}) =>
  buildState({ hands: { [SOUTH]: O_HAND }, players: { [SOUTH]: players }, ...extra });

describe('personal clock', () => {
  it('charges the time taken, then adds 1 s', () => {
    const { state } = move(southTurn({ remainingMs: 40_000 }), SOUTH, O_ON_PYRAMID, 3_000);
    assert.equal(state.players[SOUTH].remainingMs, 38_000);
  });

  it('never lets a bonus push the clock above its cap', () => {
    const { state } = move(southTurn(), SOUTH, O_ON_PYRAMID, 500);
    assert.equal(state.players[SOUTH].remainingMs, 60_000);
  });

  it('keeps time already above a lowered cap', () => {
    const { state } = move(southTurn({ capMs: 59_000 }), SOUTH, O_ON_PYRAMID, 0);
    assert.equal(state.players[SOUTH].remainingMs, 60_000);
  });

  it('times a player out when their clock runs out, leaving their blocks as dulled', () => {
    const before = southTurn({ remainingMs: 4_000 });
    const { state, events } = tick(before, 4_000);
    assert.equal(state.players[SOUTH].status, TIMED_OUT);
    assert.deepEqual(state.owner, before.owner);
    assert.deepEqual(ofType(events, 'timedOut'), [{ type: 'timedOut', seat: SOUTH, at: 4_000 }]);
    assert.equal(state.activeSeat, WEST);
    assert.equal(state.turnStartedAt, 4_000);
  });

  it('does not change a grey cluster when a player touching it times out', () => {
    const rows = [
      '#....N....#',
      '...........',
      '...........',
      '...........',
      '...........',
      '..........E',
      '...........',
      '...........',
      'WWWWWG.....',
      '.....S.....',
      '#....S....#',
    ];
    const before = buildState({ rows, players: { [SOUTH]: { remainingMs: 4_000 } } });
    const { state } = tick(before, 4_000);
    assert.equal(state.players[SOUTH].status, TIMED_OUT);
    assert.equal(state.owner[at(8, 5)], GREY);
    assert.deepEqual(state.owner, before.owner);
  });
});

describe('AFK timer', () => {
  it('passes a player after 10 s, charging 10 s with no bonus', () => {
    const { state, events } = tick(southTurn(), 10_000);
    assert.deepEqual(ofType(events, 'passed'), [{ type: 'passed', seat: SOUTH, reason: 'afk', at: 10_000 }]);
    assert.equal(state.players[SOUTH].remainingMs, 50_000);
    assert.equal(state.players[SOUTH].status, ALIVE);
    assert.equal(state.activeSeat, WEST);
  });

  it('gives the personal clock precedence when both expire at the same moment', () => {
    const { state, events } = tick(southTurn({ remainingMs: 10_000 }), 10_000);
    assert.equal(state.players[SOUTH].status, TIMED_OUT);
    assert.equal(ofType(events, 'passed').length, 0);
  });

  it('applies deadlines in the order they fell due when a tick arrives late', () => {
    // The AFK deadline (10 s) came before the clock deadline (15 s).
    const { state, events } = tick(southTurn({ remainingMs: 15_000 }), 16_000);
    assert.deepEqual(ofType(events, 'passed').map((e) => [e.seat, e.at]), [[SOUTH, 10_000]]);
    assert.equal(state.players[SOUTH].status, ALIVE);
    assert.equal(state.players[SOUTH].remainingMs, 5_000);
    assert.equal(state.activeSeat, WEST);
    assert.equal(state.turnStartedAt, 10_000);
  });

  it('rejects an action after a deadline until tick() has run', () => {
    const state = southTurn();
    assert.equal(game.nextDeadline(state), 10_000);
    assert.deepEqual(game.applyMove(state, SOUTH, O_ON_PYRAMID, 10_000), { ok: false, error: 'tickRequired' });
  });
});

describe('rounds', () => {
  it('awards +1 point to every living player and lowers every cap by 1 s', () => {
    const { state, events } = tick(southTurn(), 40_000);
    assert.equal(ofType(events, 'passed').length, 4);
    assert.deepEqual(ofType(events, 'roundEnded'), [{ type: 'roundEnded', round: 1, at: 40_000 }]);
    assert.deepEqual(scores(state), [1, 1, 1, 1]);
    assert.deepEqual(state.players.map((p) => p.capMs), [59_000, 59_000, 59_000, 59_000]);
    assert.deepEqual(state.players.map((p) => p.remainingMs), [50_000, 50_000, 50_000, 50_000]);
    assert.equal(state.round, 2);
    assert.equal(state.activeSeat, SOUTH);
    assert.equal(state.turnStartedAt, 40_000);
  });

  it('never lowers a cap below 0', () => {
    const capped = { capMs: 500 };
    const state = buildState({ players: { 0: capped, 1: capped, 2: capped, 3: capped } });
    const result = tick(state, 40_000);
    assert.deepEqual(result.state.players.map((p) => p.capMs), [0, 0, 0, 0]);
  });

  it('only counts living players when deciding a round is over', () => {
    const state = buildState({ statuses: { [NORTH]: TIMED_OUT } });
    const { events } = tick(state, 30_000);
    assert.deepEqual(ofType(events, 'passed').map((e) => e.seat), [SOUTH, WEST, EAST]);
    assert.equal(ofType(events, 'roundEnded').length, 1);
  });
});

describe('game clock', () => {
  it('ends the game when it runs out, with no passive point for the unfinished round', () => {
    const state = { ...southTurn(), endsAt: 5_000 };
    const { state: after, events } = tick(state, 5_000);
    assert.equal(after.over, true);
    assert.equal(after.result.reason, 'timeUp');
    assert.equal(ofType(events, 'roundEnded').length, 0);
    assert.deepEqual(scores(after), [0, 0, 0, 0]);
    assert.equal(game.nextDeadline(after), null);
  });

  it('takes precedence over a personal clock expiring at the same moment', () => {
    const state = { ...southTurn({ remainingMs: 4_000 }), endsAt: 4_000 };
    const { state: after } = tick(state, 4_000);
    assert.equal(after.result.reason, 'timeUp');
    assert.equal(after.players[SOUTH].status, ALIVE);
  });

  it('ends the game when only one player is left alive', () => {
    const state = buildState({
      statuses: { [NORTH]: TIMED_OUT, [EAST]: TIMED_OUT },
      players: { [SOUTH]: { remainingMs: 4_000 } },
    });
    const { state: after } = tick(state, 4_000);
    assert.equal(after.over, true);
    assert.equal(after.result.reason, 'lastPlayerStanding');
    assert.deepEqual(after.result.winners, [WEST]);
  });
});
