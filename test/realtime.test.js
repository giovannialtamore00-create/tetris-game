'use strict';

// Real-time mode (§21): no turns, no personal clocks, a 2.3 s cooldown after
// each placement unless it cleared a line.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { SOUTH, WEST, NORTH, EAST, ELIMINATED } = require('../src/core/constants');
const { SPECIAL_PIECES, BAG_PIECES, drawSpecialPiece } = require('../src/core/pieces');
const { legalPlacements } = require('../src/core/board');
const game = require('../src/core/game');

// A bag RNG state whose next special-piece pick is `piece`.
function rngStateGiving(piece) {
  for (let s = 0; ; s++) {
    if (drawSpecialPiece({ rng: { s }, queue: [] }) === piece) return s;
  }
}
const { buildState, fullBoardRows, move, tick, shuffle, expectOk, ofType, scores, at } = require('./helpers');

const REALTIME = { mode: 'realtime' };
const O_HAND = ['O', 'O', 'O', 'O'];
// On the starting board, an O on top of each seat's pyramid.
const O_SOUTH = { handIndex: 0, rotation: 0, x: 5, y: 6 };
const O_SOUTH_2 = { handIndex: 1, rotation: 0, x: 3, y: 7 };
const O_WEST = { handIndex: 0, rotation: 0, x: 3, y: 5 };

const realtime = (fields = {}) =>
  buildState({ config: REALTIME, hands: { [SOUTH]: O_HAND, [WEST]: O_HAND }, ...fields });

// Row 5 is full except (5,5); South completes it with a vertical I.
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
const ROW_FIVE_HP = ['', '', '', '', '', '3.........3', '', '', '', '', '.....3.....'].map((r) => r.padEnd(11, '.'));

describe('real-time mode', () => {
  it('starts with no turns: everyone can place at once', () => {
    const { state, events } = expectOk(game.createGame({ seed: 4, now: 1_000, config: REALTIME }));
    assert.equal(state.phase, 'realtime');
    assert.equal(state.activeSeat, null);
    assert.ok(state.players.every((p) => p.cooldownUntil === 1_000));
    assert.equal(ofType(events, 'turnStarted').length + ofType(events, 'interlude').length, 0);
    assert.equal(game.nextDeadline(state), 601_000); // only the game clock
  });

  it('lets different players place one after another without waiting for turns', () => {
    const { state: a } = move(realtime(), SOUTH, O_SOUTH, 500);
    const { state: b } = move(a, WEST, O_WEST, 600);
    assert.equal(b.owner[at(6, 5)], SOUTH);
    assert.equal(b.owner[at(5, 3)], WEST);
  });

  it('puts a player on a 2.3 s cooldown after a placement', () => {
    const { state, events } = move(realtime(), SOUTH, O_SOUTH, 1_000);
    assert.equal(state.players[SOUTH].cooldownUntil, 3_300);
    assert.deepEqual(ofType(events, 'cooldown'), [{ type: 'cooldown', seat: SOUTH, until: 3_300, at: 1_000 }]);
    assert.deepEqual(game.applyMove(state, SOUTH, O_SOUTH_2, 3_299), { ok: false, error: 'coolingDown' });
    move(state, SOUTH, O_SOUTH_2, 3_300);
  });

  it('skips the cooldown after a line clear, and refills from the bag instead of a special piece', () => {
    const state = realtime({ rows: ROW_FIVE, hpRows: ROW_FIVE_HP, hands: { [SOUTH]: ['I', 'O', 'O', 'O'] } });
    state.players[SOUTH].bag.queue = ['T'];
    const { state: after, events } = move(state, SOUTH, { handIndex: 0, rotation: 1, x: 5, y: 2 }, 2_000);
    assert.equal(ofType(events, 'linesCompleted').length, 1);
    assert.equal(after.players[SOUTH].cooldownUntil, 2_000);
    assert.equal(after.players[SOUTH].hand[0], 'T');
    assert.equal(ofType(events, 'rewardPiece').length, 0);
    // Scoring works exactly as in turn-based mode: 4 West + 2 own + 4 East + 3 detonated.
    assert.equal(scores(after)[SOUTH], 13);
  });

  it('has no personal clocks: no time is charged or awarded', () => {
    const { state, events } = move(realtime(), SOUTH, O_SOUTH, 9_000);
    assert.equal(state.players[SOUTH].remainingMs, 60_000);
    assert.equal(ofType(events, 'lineClearBonus').length, 0);
    const { events: later } = tick(state, 120_000);
    assert.equal(ofType(later, 'passed').length + ofType(later, 'timedOut').length, 0);
  });

  it('has no rounds, so no passive points', () => {
    let state = realtime();
    const seen = [];
    for (let k = 0; k < 6; k++) {
      const seat = k % 2 === 0 ? SOUTH : WEST;
      const t = 3_000 * Math.floor(k / 2);
      const [first] = legalPlacements(state.owner, seat, state.players[seat].hand);
      const result = move(state, seat, first, t);
      seen.push(...result.events);
      state = result.state;
    }
    assert.equal(ofType(seen, 'roundEnded').length, 0);
    assert.equal(state.round, 1);
  });

  it('offers a shuffle as soon as a player has no legal move, usable at once', () => {
    // A full board with three single-cell holes: (8,4) and (8,6) border only
    // South, (4,4) borders only West and North. No line is full.
    const rows = fullBoardRows();
    rows[8] = `${rows[8].slice(0, 4)}.${rows[8][5]}.${rows[8].slice(7)}`;
    rows[4] = `${rows[4].slice(0, 4)}.${rows[4].slice(5)}`;
    const state = realtime({ rows, hands: { [SOUTH]: ['M', 'O', 'O', 'O'] } });
    state.players[SOUTH].bag.queue = ['O'];
    const { state: after, events } = move(state, SOUTH, { handIndex: 0, rotation: 0, x: 4, y: 8 }, 1_000);
    assert.equal(ofType(events, 'linesCompleted').length, 0);
    // Only 1-cell holes are left and the others hold no 1x1: they get an offer at
    // once. South's 1x1 filled a hole exactly, so South was refilled with a rainbow
    // 1x1 (the hidden perfect-fit reward, §25) and still has a move.
    assert.deepEqual(after.players[SOUTH].hand[0], 'M');
    assert.equal(after.players[SOUTH].rainbow[0], true);
    assert.deepEqual(ofType(events, 'shuffleOffered').map((e) => e.seat), [WEST, NORTH, EAST]);
    // A shuffle guarantees one special piece. With a 1x2 as the special piece
    // West is still stuck, so a fresh offer comes straight away.
    after.players[WEST].bag.rng.s = rngStateGiving('D');
    const { state: shuffled, events: shuffledEvents } = shuffle(after, WEST, 1_100);
    assert.ok(SPECIAL_PIECES.includes(shuffled.players[WEST].hand[3]));
    assert.ok(shuffled.players[WEST].hand.slice(0, 3).every((p) => BAG_PIECES.includes(p)));
    assert.deepEqual(ofType(shuffledEvents, 'shuffleOffered').map((e) => e.seat), [WEST]);
    assert.equal(shuffled.players[WEST].shuffleAvailable, true);
  });

  it('allows shuffling during a cooldown', () => {
    const state = realtime({ players: { [SOUTH]: { shuffleAvailable: true } } });
    const { state: cooling } = move(state, SOUTH, O_SOUTH, 1_000);
    // Placing uses up the offer; give it back to check shuffling mid-cooldown.
    cooling.players[SOUTH].shuffleAvailable = true;
    const { state: after } = shuffle(cooling, SOUTH, 2_000);
    assert.equal(after.players[SOUTH].shuffleAvailable, false);
    assert.equal(after.players[SOUTH].cooldownUntil, 3_300);
  });

  it('rejects moves from players who are out', () => {
    const rows = [...ROW_FIVE];
    rows[0] = '#.........#'; // North has no blocks left
    const state = realtime({ rows, statuses: { [NORTH]: ELIMINATED } });
    assert.equal(game.applyMove(state, NORTH, O_SOUTH, 1_000).error, 'notAlive');
  });

  it('ends when the 10-minute game clock runs out', () => {
    const { state } = tick(realtime(), 600_000);
    assert.equal(state.over, true);
    assert.equal(state.result.reason, 'timeUp');
  });

  it('ends at once when only one player is left alive', () => {
    const state = realtime({
      rows: ROW_FIVE,
      hpRows: ['', '', '', '', '', '11111.11113', '', '', '', '', '.....3.....'].map((r) => r.padEnd(11, '.')),
      hands: { [SOUTH]: ['I', 'O', 'O', 'O'] },
      statuses: { [NORTH]: 'timedOut', [EAST]: 'timedOut' },
    });
    const { state: after } = move(state, SOUTH, { handIndex: 0, rotation: 1, x: 5, y: 2 }, 1_000);
    assert.equal(after.players[WEST].status, ELIMINATED);
    assert.equal(after.over, true);
    assert.equal(after.result.reason, 'lastPlayerStanding');
  });
});
