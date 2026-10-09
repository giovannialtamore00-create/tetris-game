'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { SOUTH, WEST, EMPTY } = require('../src/core/constants');
const { legalPlacements, pieceCells, isLegalPlacement } = require('../src/core/board');
const { gapKeys, chooseEasyMove, wantsShuffle, botThinkMs } = require('../src/core/bot');
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

  it('picks among equally good moves by the random number it is given', () => {
    const state = buildState({ hands: { [SOUTH]: ['T', 'L', 'S', 'Z'] } });
    assert.notDeepEqual(chooseEasyMove(state, SOUTH, () => 0), chooseEasyMove(state, SOUTH, () => 0.9999));
  });

  // Rows 0-7 open, a 1×1 gap at row 9 column 1, the rest South's.
  const GAP_BOARD = [
    '#.........#', '...........', '...........', '...........', '...........', '...........',
    '...........', '...........', 'SSSSSSSSSSS', 'S.SSSSSSSSS', '#sssssssss#',
  ];

  it('fills a gap first', () => {
    const state = buildState({ rows: GAP_BOARD, hands: { [SOUTH]: ['M'] } });
    for (const r of [0, 0.5, 0.9999]) {
      const m = chooseEasyMove(state, SOUTH, () => r);
      assert.deepEqual(pieceCells('M', m.rotation, m.x, m.y), [at(9, 1)]);
    }
  });

  it('does not leave a new gap when another move exists', () => {
    // Rows 1-2 keep columns from filling up. Only row 7 is open to South: an I that does not touch either end leaves a gap.
    const rows = ['#nnnnnnnnn#', 'NN.......NN', 'N.NNNNNNN.N', ...Array(4).fill('NNNNNNNNNNN'), '...........', 'SSSSSSSSSSS', 'SSSSSSSSSSS', '#sssssssss#'];
    const state = buildState({ rows, hands: { [SOUTH]: ['I'] } });
    const before = gapKeys(state.owner);
    const createsGap = (m) => {
      const after = state.owner.slice();
      for (const i of pieceCells('I', m.rotation, m.x, m.y)) after[i] = SOUTH;
      return [...gapKeys(after)].some((k) => !before.has(k));
    };
    assert.ok(legalPlacements(state.owner, SOUTH, ['I']).some(createsGap));
    for (const r of [0, 0.3, 0.6, 0.9999]) assert.equal(createsGap(chooseEasyMove(state, SOUTH, () => r)), false);
  });

  it('ignores gaps left by a move that clears a line', () => {
    // An I across row 7 clears it but leaves (6,10) alone; an I in row 9 leaves
    // one of its 5 open cells alone without clearing anything.
    const rows = [
      '#nnnnnnnnn#', 'NN.......NN', 'N.NNNNNNN.N', ...Array(3).fill('NNNNNNNNNNN'), 'NNNNNNNNNN.', 'NNNNNNN....',
      'SSSSSSSSSSS', '.....SSSSSS', '#sssssssss#',
    ];
    const state = buildState({ rows, hands: { [SOUTH]: ['I'] } });
    for (const r of [0, 0.5, 0.9999]) {
      const m = chooseEasyMove(state, SOUTH, () => r);
      assert.deepEqual(pieceCells('I', m.rotation, m.x, m.y).sort((a, b) => a - b), [at(7, 7), at(7, 8), at(7, 9), at(7, 10)]);
    }
  });

  it('leaves a gap only when every move does', () => {
    // Only 5 open cells in row 7: any I placed there leaves one cell.
    const rows = ['#nnnnnnnnn#', 'NN.......NN', 'N.NNNNNNN.N', ...Array(4).fill('NNNNNNNNNNN'), '.....NNNNNN', 'SSSSSSSSSSS', 'SSSSSSSSSSS', '#sssssssss#'];
    const state = buildState({ rows, hands: { [SOUTH]: ['I'] } });
    assert.ok(chooseEasyMove(state, SOUTH));
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

  it('thinks for 3 to 4 s', () => {
    assert.equal(botThinkMs(() => 0), 3_000);
    assert.equal(botThinkMs(() => 0.9999), 3_999);
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
