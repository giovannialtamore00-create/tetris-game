'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { SOUTH, WEST, EMPTY } = require('../src/core/constants');
const { legalPlacements, pieceCells, isLegalPlacement } = require('../src/core/board');
const { chooseEasyMove, wantsShuffle, botThinkMs } = require('../src/core/bot');
const game = require('../src/core/game');
const { buildState, fullBoardRows, move, at, assertValid } = require('./helpers');

describe('legal placements', () => {
  it('lists only legal moves, each distinct placement once', () => {
    const state = buildState({ hands: { [SOUTH]: ['O', 'I', 'M', 'O'] } });
    const moves = legalPlacements(state.owner, SOUTH, state.players[SOUTH].hand);
    assert.ok(moves.length > 0);
    const keys = new Set();
    for (const m of moves) {
      const piece = state.players[SOUTH].hand[m.handIndex];
      const cells = pieceCells(piece, m.rotation, m.x, m.y);
      assert.ok(isLegalPlacement(state.owner, SOUTH, cells));
      const key = `${piece}:${[...cells].sort((a, b) => a - b)}`;
      assert.ok(!keys.has(key), `duplicate placement ${key}`);
      keys.add(key);
    }
    // The O's four identical rotations and the second O in the hand add nothing new.
    const oMoves = moves.filter((m) => m.handIndex === 0 || m.handIndex === 3);
    assert.ok(oMoves.every((m) => m.handIndex === 0 && m.rotation === 0));
  });

  it('is empty when the player is stuck', () => {
    const state = buildState({ rows: fullBoardRows() });
    assert.deepEqual(legalPlacements(state.owner, SOUTH, state.players[SOUTH].hand), []);
  });
});

describe('easy bot', () => {
  it('picks a legal move the game accepts', () => {
    const state = buildState({ hands: { [SOUTH]: ['T', 'L', 'S', 'Z'] } });
    const choice = chooseEasyMove(state, SOUTH, () => 0.37);
    assert.ok(choice);
    const { state: after } = move(state, SOUTH, choice, 1_000);
    assert.equal(after.activeSeat, WEST);
  });

  it('picks by the random number it is given', () => {
    const state = buildState({ hands: { [SOUTH]: ['T', 'L', 'S', 'Z'] } });
    const moves = legalPlacements(state.owner, SOUTH, state.players[SOUTH].hand);
    assert.deepEqual(chooseEasyMove(state, SOUTH, () => 0), moves[0]);
    assert.deepEqual(chooseEasyMove(state, SOUTH, () => 0.9999), moves[moves.length - 1]);
  });

  it('has no move when stuck', () => {
    const state = buildState({ rows: fullBoardRows() });
    assert.equal(chooseEasyMove(state, SOUTH), null);
  });

  it('wants to shuffle exactly when it has an offer and is alive', () => {
    const state = buildState({ players: { [SOUTH]: { shuffleAvailable: true } } });
    assert.equal(wantsShuffle(state, SOUTH), true);
    assert.equal(wantsShuffle(state, WEST), false);
    state.players[SOUTH].status = 'timedOut';
    assert.equal(wantsShuffle(state, SOUTH), false);
  });

  it('thinks for 1.5 to 2.5 s', () => {
    assert.equal(botThinkMs(() => 0), 1_500);
    assert.equal(botThinkMs(() => 0.9999), 2_499);
  });

  it('can play a whole game against itself without breaking any rule', () => {
    let { state } = game.createGame({ seed: 11, config: { turnDelayMs: 0 } });
    let t = 0;
    let moves = 0;
    let x = 0.5;
    const random = () => (x = (x * 9301 + 0.49297) % 1);
    while (!state.over && t < 600_000) {
      t += 100;
      state = game.tick(state, t).state;
      for (const p of state.players) {
        if (wantsShuffle(state, p.seat)) state = game.shuffle(state, p.seat, t).state;
      }
      if (state.phase === 'turn' && state.turnStartedAt !== null) {
        const choice = chooseEasyMove(state, state.activeSeat, random);
        if (choice) {
          const result = game.applyMove(state, state.activeSeat, choice, t);
          assert.equal(result.ok, true, result.error);
          state = result.state;
          assertValid(state);
          moves++;
        }
      }
    }
    assert.ok(moves > 20, `only ${moves} moves`);
    assert.equal(state.owner[at(0, 0)] !== EMPTY, true); // corners stay blocked
  });
});
