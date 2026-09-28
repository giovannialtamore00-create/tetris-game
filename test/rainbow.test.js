'use strict';

// Rainbow mode (§25): its own piece pool, and rainbow pieces that can be
// placed anywhere touching any block and become ownerless rainbow blocks.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { SOUTH, WEST, EAST, RAINBOW, EMPTY } = require('../src/core/constants');
const { POOLS } = require('../src/core/pieces');
const { resolveRainbow } = require('../src/core/resolve');
const { chooseEasyMove } = require('../src/core/bot');
const game = require('../src/core/game');
const { buildState, parseBoard, move, shuffle, at, ofType, scores } = require('./helpers');

const RAINBOW_MODE = { rainbowMode: true };

const allRainbowFlags = (state) => state.players.flatMap((p) => p.rainbow);

describe('rainbow mode: dealing', () => {
  it('deals no rainbow pieces when rainbow mode is off, whatever the chance', () => {
    const { state } = game.createGame({ seed: 5, config: { rainbowMode: false, rainbowChance: 1 } });
    assert.ok(allRainbowFlags(state).every((r) => r === false));
    assert.ok(state.players.every((p) => p.hand.every((piece) => POOLS.classic.bag.includes(piece))));
  });

  it('uses the rainbow-mode pool: 1x3, 1x2 and small L in the bag', () => {
    const seen = new Set();
    for (let seed = 0; seed < 40; seed++) {
      for (const p of game.createGame({ seed, config: RAINBOW_MODE }).state.players) {
        for (const piece of p.hand) seen.add(piece);
      }
    }
    assert.ok(['I3', 'D', 'L3'].every((piece) => seen.has(piece)));
    assert.ok(!seen.has('M'), 'the 1x1 is special and never in the bag');
  });

  it('makes each dealt piece rainbow with the configured chance (5% by default)', () => {
    let rainbow = 0;
    let total = 0;
    for (let seed = 0; seed < 300; seed++) {
      const flags = allRainbowFlags(game.createGame({ seed, config: RAINBOW_MODE }).state);
      rainbow += flags.filter(Boolean).length;
      total += flags.length;
    }
    const rate = rainbow / total;
    assert.ok(rate > 0.035 && rate < 0.065, `rainbow rate ${rate}`);
    assert.ok(allRainbowFlags(game.createGame({ seed: 1, config: { ...RAINBOW_MODE, rainbowChance: 1 } }).state).every(Boolean));
  });

  it('gives a shuffled hand a 1x1 as its special piece, and rolls rainbow for it too', () => {
    const state = buildState({
      config: { ...RAINBOW_MODE, rainbowChance: 1 },
      players: { [SOUTH]: { shuffleAvailable: true } },
    });
    const { state: after, events } = shuffle(state, SOUTH, 1_000);
    assert.equal(after.players[SOUTH].hand[3], 'M');
    assert.deepEqual(after.players[SOUTH].rainbow, [true, true, true, true]);
    assert.deepEqual(ofType(events, 'shuffled')[0].rainbow, [true, true, true, true]);
  });
});

// West has a short branch along row 5; South sits at the bottom.
const WEST_BRANCH = [
  '#....n....#',
  '...........',
  '...........',
  '...........',
  '...........',
  'wWW........',
  '...........',
  '...........',
  '...........',
  '...........',
  '#....s....#',
];
const M_AT = (r, c) => ({ handIndex: 0, rotation: 0, x: c, y: r });

describe('rainbow mode: placing', () => {
  const state = () =>
    buildState({ rows: WEST_BRANCH, config: RAINBOW_MODE, hands: { [SOUTH]: ['M', 'M', 'O', 'O'] }, rainbow: { [SOUTH]: [true] } });

  it('can go anywhere that touches any block, even another player\'s', () => {
    const { state: after, events } = move(state(), SOUTH, M_AT(5, 3), 1_000);
    assert.equal(after.owner[at(5, 3)], RAINBOW);
    assert.deepEqual(ofType(events, 'placed')[0].rainbow, true);
  });

  it('must still touch at least one block', () => {
    assert.equal(game.applyMove(state(), SOUTH, M_AT(7, 7), 1_000).error, 'illegalPlacement');
  });

  it('leaves normal pieces bound by the usual rule', () => {
    assert.equal(game.applyMove(state(), SOUTH, { ...M_AT(5, 3), handIndex: 1 }, 1_000).error, 'illegalPlacement');
  });

  it('is never adopted, even touching a single player, and scores nothing by itself', () => {
    const { state: after, events } = move(state(), SOUTH, M_AT(5, 3), 1_000);
    assert.equal(ofType(events, 'converted').length, 0);
    assert.equal(after.owner[at(5, 3)], RAINBOW);
    assert.deepEqual(scores(after), [0, 0, 0, 0]);
  });

  it('does not count as your own block for later placements', () => {
    const s = buildState({
      rows: WEST_BRANCH.map((r, i) => (i === 5 ? 'wWWR.......' : r)),
      config: RAINBOW_MODE,
      hands: { [SOUTH]: ['M', 'O', 'O', 'O'] },
    });
    assert.equal(game.applyMove(s, SOUTH, M_AT(5, 4), 1_000).error, 'illegalPlacement');
  });
});

describe('rainbow mode: scoring and detonation', () => {
  // Row 5 is full except (5,5); South completes it with a rainbow I.
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

  it('breaking a rainbow block pays +1, never the +2 own-block bonus; cut-off rainbow blocks detonate for +1', () => {
    const state = buildState({
      rows: ROW_FIVE,
      hpRows: ROW_FIVE_HP,
      config: RAINBOW_MODE,
      hands: { [SOUTH]: ['I', 'O', 'O', 'O'] },
      rainbow: { [SOUTH]: [true] },
    });
    const { state: after, events } = move(state, SOUTH, { handIndex: 0, rotation: 1, x: 5, y: 2 }, 1_000);
    const [destroyed] = ofType(events, 'destroyed');
    assert.deepEqual(destroyed.cells.find((d) => d.cell === at(5, 5)), { cell: at(5, 5), owner: RAINBOW, points: 1 });
    // The rest of the rainbow I touches nothing now: it detonates.
    const rainbowBlast = ofType(events, 'detonated').find((e) => e.rainbow);
    assert.deepEqual(rainbowBlast.cells, [at(2, 5), at(3, 5), at(4, 5)]);
    for (const r of [2, 3, 4]) assert.equal(after.owner[at(r, 5)], EMPTY);
    // 4 West + 1 rainbow + 4 East + 3 detonated rainbow = 12 (13 with a normal I).
    assert.equal(scores(after)[SOUTH], 12);
    assert.equal(after.owner[at(5, 0)], WEST);
    assert.equal(after.owner[at(5, 10)], EAST);
  });

  it('keeps a rainbow group alive while it touches any non-rainbow block, grey included', () => {
    const board = parseBoard([
      '#.........#',
      '...........',
      '....G......',
      '....RR.....',
      '...........',
      '.......RR..',
      '...........',
      '...........',
      '...........',
      '...........',
      '#.........#',
    ]);
    const blasts = resolveRainbow(board.owner, board.hp);
    assert.deepEqual(blasts, [[at(5, 7), at(5, 8)]]);
    assert.equal(board.owner[at(3, 4)], RAINBOW);
    assert.equal(board.owner[at(5, 7)], EMPTY);
  });
});

describe('rainbow mode: bots', () => {
  it('lets an easy bot play a rainbow piece', () => {
    const state = buildState({
      rows: WEST_BRANCH,
      config: RAINBOW_MODE,
      hands: { [SOUTH]: ['M', 'M', 'M', 'M'] },
      rainbow: { [SOUTH]: [true, true, true, true] },
    });
    const choice = chooseEasyMove(state, SOUTH, () => 0.5);
    const { state: after } = move(state, SOUTH, choice, 1_000);
    assert.ok(after.owner.includes(RAINBOW));
  });
});
