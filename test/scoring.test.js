'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  SOUTH,
  WEST,
  NORTH,
  EAST,
  EMPTY,
  ALIVE,
  ELIMINATED,
  TIMED_OUT,
} = require('../src/core/constants');
const game = require('../src/core/game');
const { SPECIAL_PIECES } = require('../src/core/pieces');
const { buildState, move, at, ofType, scores } = require('./helpers');

// Row 5 is full except (5,5). South plays a vertical I into column 5 at rows
// 2-5, completing row 5. Every block in row 5 takes one hit:
//   West  (5,0) 3 HP -> 2 (survives), (5,1)-(5,4) destroyed: 4 x 1 point
//   South (5,5) just placed, destroyed while South owns it: 1 x 2 points
//   East  (5,6)-(5,9) destroyed: 4 x 1 point, (5,10) 3 HP -> 2 (survives)
// South's other new blocks (2,5)-(4,5) lose their link and are orphaned.
const ROW_FIVE = [
  '#..n......#',
  '...........',
  '...........',
  '...........',
  '...........',
  'wWWWW.EEEEe',
  '.....S.....',
  '.....S.....',
  '.....S.....',
  '.....S.....',
  '#....s....#',
];
const ROW_FIVE_HP = [
  '...........',
  '...........',
  '...........',
  '...........',
  '...........',
  '31111.11113',
  '...........',
  '...........',
  '...........',
  '...........',
  '.....3.....',
];
const VERTICAL_I = { handIndex: 0, rotation: 1, x: 5, y: 2 };
const HAND = ['I', 'O', 'O', 'O'];

function playRowFive(overrides = {}) {
  const state = buildState({ rows: ROW_FIVE, hpRows: ROW_FIVE_HP, hands: { [SOUTH]: HAND }, ...overrides });
  return move(state, SOUTH, VERTICAL_I, 2000);
}

describe('scoring', () => {
  it('scores a line clear, own-block destruction and detonation together', () => {
    const { state } = playRowFive();
    // 4 West + 2 own + 4 East + 3 detonated.
    assert.deepEqual(scores(state), [13, 0, 0, 0]);
  });

  it('pays 2 points for the mover\'s own block destroyed by a line hit', () => {
    const { events } = playRowFive();
    const [destroyed] = ofType(events, 'destroyed');
    const own = destroyed.cells.find((d) => d.cell === at(5, 5));
    assert.deepEqual(own, { cell: at(5, 5), owner: SOUTH, points: 2 });
    assert.equal(destroyed.cells.filter((d) => d.owner !== SOUTH).every((d) => d.points === 1), true);
  });

  it('pays no self-detonation bonus when your own cut-off branch detonates', () => {
    const { state, events } = playRowFive();
    const [detonated] = ofType(events, 'detonated');
    assert.deepEqual(detonated.cells, [at(2, 5), at(3, 5), at(4, 5)]);
    assert.equal(detonated.points, 3);
    for (const r of [2, 3, 4]) assert.equal(state.owner[at(r, 5)], EMPTY);
  });

  it('scores nothing for a hit that only lowers HP, and the block keeps its owner', () => {
    const { state, events } = playRowFive();
    assert.deepEqual([state.owner[at(5, 0)], state.hp[at(5, 0)]], [WEST, 2]);
    assert.deepEqual([state.owner[at(5, 10)], state.hp[at(5, 10)]], [EAST, 2]);
    const [destroyed] = ofType(events, 'destroyed');
    assert.equal(destroyed.cells.some((d) => d.cell === at(5, 0) || d.cell === at(5, 10)), false);
  });

  it('pays the adopting player for a converted cluster', () => {
    const rows = [...ROW_FIVE];
    rows[0] = '#...n.....#';
    rows[1] = '....N......';
    rows[2] = '....N......';
    const { state, events } = playRowFive({ rows });
    const [converted] = ofType(events, 'converted');
    assert.equal(converted.to, NORTH);
    assert.equal(converted.points, 3);
    assert.deepEqual(scores(state), [10, 0, 3, 0]);
  });

  it('pays nothing to a timed-out player who adopts a cluster', () => {
    const rows = [...ROW_FIVE];
    rows[0] = '#...n.....#';
    rows[1] = '....N......';
    rows[2] = '....N......';
    const { state, events } = playRowFive({ rows, statuses: { [NORTH]: TIMED_OUT } });
    const [converted] = ofType(events, 'converted');
    assert.equal(converted.points, 0);
    assert.equal(state.owner[at(3, 5)], NORTH);
    assert.deepEqual(scores(state), [10, 0, 0, 0]);
  });

  it('pays 1 point for destroying dulled blocks, eliminates a player left with none, and ends the game', () => {
    const hpRows = [...ROW_FIVE_HP];
    hpRows[5] = '11111.11113';
    const { state, events } = playRowFive({
      hpRows,
      statuses: { [NORTH]: TIMED_OUT, [EAST]: TIMED_OUT },
    });
    // 5 West + 2 own + 4 dulled East + 3 detonated.
    assert.deepEqual(scores(state), [14, 0, 0, 0]);
    assert.equal(state.players[WEST].status, ELIMINATED);
    assert.deepEqual(ofType(events, 'eliminated').map((e) => e.seat), [WEST]);
    assert.equal(state.over, true);
    assert.equal(state.result.reason, 'lastPlayerStanding');
    assert.deepEqual(state.result.winners, [SOUTH]);
  });

  it('hands the turn to the next living seat and refills the mover\'s hand', () => {
    const { state } = playRowFive();
    assert.equal(state.activeSeat, WEST);
    assert.equal(state.turnStartedAt, 2000);
    assert.equal(state.players[SOUTH].hand.length, 4);
    assert.deepEqual(state.players[SOUTH].hand.slice(1), ['O', 'O', 'O']);
    assert.equal(state.players[SOUTH].status, ALIVE);
  });

  it('rewards a line clear by refilling the played slot with a special piece', () => {
    const { state, events } = playRowFive();
    const reward = state.players[SOUTH].hand[0];
    assert.ok(SPECIAL_PIECES.includes(reward), `expected a special piece, got ${reward}`);
    assert.deepEqual(ofType(events, 'rewardPiece'), [{ type: 'rewardPiece', seat: SOUTH, piece: reward, handIndex: 0 }]);
  });

  it('refills from the bag when the move completes no line', () => {
    const state = buildState({ rows: ROW_FIVE, hpRows: ROW_FIVE_HP, hands: { [SOUTH]: HAND } });
    state.players[SOUTH].bag.queue = ['T'];
    // An O beside South's column: legal, completes nothing.
    const { state: after, events } = move(state, SOUTH, { handIndex: 1, rotation: 0, x: 6, y: 7 }, 1000);
    assert.equal(after.players[SOUTH].hand[1], 'T');
    assert.equal(ofType(events, 'rewardPiece').length, 0);
  });
});

describe('move validation', () => {
  const state = buildState({ rows: ROW_FIVE, hpRows: ROW_FIVE_HP, hands: { [SOUTH]: HAND } });

  it('rejects a move from a player whose turn it is not', () => {
    assert.deepEqual(game.applyMove(state, WEST, VERTICAL_I, 1000), { ok: false, error: 'notYourTurn' });
  });

  it('rejects malformed moves', () => {
    assert.equal(game.applyMove(state, SOUTH, { ...VERTICAL_I, handIndex: 4 }, 1000).error, 'invalidHandIndex');
    assert.equal(game.applyMove(state, SOUTH, { ...VERTICAL_I, rotation: 5 }, 1000).error, 'invalidRotation');
    assert.equal(game.applyMove(state, SOUTH, { ...VERTICAL_I, x: 1.5 }, 1000).error, 'invalidPosition');
  });

  it('rejects an illegal placement without changing the state', () => {
    const before = structuredClone(state);
    const result = game.applyMove(state, SOUTH, { ...VERTICAL_I, x: 8 }, 1000);
    assert.deepEqual(result, { ok: false, error: 'illegalPlacement' });
    assert.deepEqual(state, before);
  });

  it('rejects any move once the game is over', () => {
    const over = { ...structuredClone(state), over: true, phase: 'over' };
    assert.equal(game.applyMove(over, SOUTH, VERTICAL_I, 1000).error, 'gameOver');
  });
});
