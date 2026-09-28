'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { SOUTH, WEST, NORTH, EAST, GREY, EMPTY, ALIVE, TIMED_OUT } = require('../src/core/constants');
const { resolveClusters, clusterPoints } = require('../src/core/resolve');
const { checkInvariants } = require('../src/core/invariants');
const { parseBoard, at } = require('./helpers');

// Resolves a board that has just lost some blocks (the state right after a
// move's line hits), then checks the §6 invariants on the result.
function resolve(rows, { hpRows, statuses = {} } = {}) {
  const board = parseBoard(rows, hpRows);
  const players = [0, 1, 2, 3].map((seat) => ({ seat, status: statuses[seat] || ALIVE }));
  const decisions = resolveClusters(board.owner, board.hp);
  assert.deepEqual(checkInvariants({ ...board, players }), []);
  const statusOf = (seat) => players[seat].status;
  return { ...board, decisions, statusOf };
}

const cells = (...coords) => coords.map(([r, c]) => at(r, c)).sort((a, b) => a - b);

describe('cluster resolution: outcomes', () => {
  it('detonates an orphan cluster touching 0 colours and pays the mover 1 per block', () => {
    const { owner, decisions, statusOf } = resolve([
      '#.........#',
      '...........',
      '...........',
      '...........',
      '...........',
      '.....SS....',
      '...........',
      '...........',
      '...........',
      '.....S.....',
      '#....S....#',
    ]);
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].outcome, 'detonate');
    assert.deepEqual(decisions[0].cells, cells([5, 5], [5, 6]));
    assert.deepEqual([owner[at(5, 5)], owner[at(5, 6)]], [EMPTY, EMPTY]);
    // Even though the cluster was the mover's own: no self bonus.
    assert.deepEqual(clusterPoints(decisions[0], SOUTH, statusOf), { seat: SOUTH, points: 2 });
  });

  it('converts an orphan cluster touching exactly 1 colour, keeping its HP', () => {
    const { owner, hp, decisions, statusOf } = resolve(
      [
        '#.........#',
        '...........',
        '...........',
        '...........',
        '...........',
        'WWWWWSS....',
        '...........',
        '...........',
        '...........',
        '.....S.....',
        '#....S....#',
      ],
      { hpRows: ['', '', '', '', '', '.....23....', '', '', '', '', ''].map((r) => r.padEnd(11, '.')) },
    );
    assert.equal(decisions[0].outcome, 'convert');
    assert.equal(decisions[0].to, WEST);
    assert.deepEqual([owner[at(5, 5)], owner[at(5, 6)]], [WEST, WEST]);
    assert.deepEqual([hp[at(5, 5)], hp[at(5, 6)]], [2, 3]);
    assert.deepEqual(clusterPoints(decisions[0], NORTH, statusOf), { seat: WEST, points: 2 });
  });

  it('turns an orphan cluster touching 2+ colours grey', () => {
    const { owner, decisions, statusOf } = resolve([
      '#.........#',
      '...........',
      '...........',
      '...........',
      '...........',
      'WWWWWSSEEEE',
      '...........',
      '...........',
      '...........',
      '.....S.....',
      '#....S....#',
    ]);
    assert.equal(decisions[0].outcome, 'grey');
    assert.deepEqual(decisions[0].touching, [WEST, EAST]);
    assert.deepEqual([owner[at(5, 5)], owner[at(5, 6)]], [GREY, GREY]);
    assert.equal(clusterPoints(decisions[0], SOUTH, statusOf), null);
  });

  it('converts to a timed-out player as dulled blocks, paying no points', () => {
    const { owner, decisions, statusOf } = resolve(
      [
        '#.........#',
        '...........',
        '...........',
        '...........',
        '...........',
        'WWWWWSS....',
        '...........',
        '...........',
        '...........',
        '.....S.....',
        '#....S....#',
      ],
      { statuses: { [WEST]: TIMED_OUT } },
    );
    assert.equal(decisions[0].outcome, 'convert');
    assert.equal(owner[at(5, 6)], WEST);
    assert.equal(clusterPoints(decisions[0], SOUTH, statusOf), null);
  });
});

describe('cluster resolution: merging with grey', () => {
  // Grey (3,5) touches North at (2,5) and West at (3,4). South's orphan at
  // (4,5)-(5,5) touches no anchored colour, only the grey block.
  const WITH_GREY = [
    '#....N....#',
    '.....N.....',
    '.....N.....',
    'WWWWWG.....',
    '.....S.....',
    '.....S.....',
    '...........',
    '...........',
    '...........',
    '...........',
    '#....S....#',
  ];
  const ORPHAN_HP = ['', '', '', '', '.....2.....', '.....3.....', '', '', '', '', ''].map((r) =>
    r.padEnd(11, '.'),
  );

  it('fresh orphan merges with adjacent grey cluster before counting colours', () => {
    const { owner, hp, decisions } = resolve(WITH_GREY, { hpRows: ORPHAN_HP });
    assert.equal(decisions.length, 1);
    const [merged] = decisions;
    assert.equal(merged.outcome, 'grey');
    assert.deepEqual(merged.cells, cells([3, 5], [4, 5], [5, 5]));
    assert.deepEqual(merged.touching, [WEST, NORTH]);
    assert.deepEqual(merged.newlyGreyed, cells([4, 5], [5, 5]));
    assert.deepEqual([owner[at(4, 5)], owner[at(5, 5)]], [GREY, GREY]);
    assert.deepEqual([hp[at(4, 5)], hp[at(5, 5)]], [2, 3]);
  });

  it('same orphan without the grey neighbour detonates', () => {
    const rows = [...WITH_GREY];
    rows[3] = 'WWWWW......';
    const { owner, decisions, statusOf } = resolve(rows, { hpRows: ORPHAN_HP });
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].outcome, 'detonate');
    assert.deepEqual([owner[at(4, 5)], owner[at(5, 5)]], [EMPTY, EMPTY]);
    assert.deepEqual(clusterPoints(decisions[0], WEST, statusOf), { seat: WEST, points: 2 });
  });

  it('merged cluster counts touching colours from both parts', () => {
    // The orphan part alone touches only East at (5,6): on its own it would convert.
    const rows = [...WITH_GREY];
    rows[5] = '.....SEEEEE';
    const { owner, decisions } = resolve(rows);
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].outcome, 'grey');
    assert.deepEqual(decisions[0].touching, [WEST, NORTH, EAST]);
    assert.equal(owner[at(5, 5)], GREY);
  });
});

describe('cluster resolution: grey re-evaluation', () => {
  it('adopts a grey cluster when a remote cut removes one of its two colours', () => {
    // West's link at (3,2) was destroyed: (3,3)-(3,4) are orphaned, merge with
    // the grey block, and the merged cluster now touches only North.
    const { owner, decisions, statusOf } = resolve([
      '#....N....#',
      '.....N.....',
      '.....N.....',
      'WW.WWG.....',
      '...........',
      '...........',
      '...........',
      '...........',
      '...........',
      '...........',
      '#.........#',
    ]);
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].outcome, 'convert');
    assert.equal(decisions[0].to, NORTH);
    for (const [r, c] of [[3, 3], [3, 4], [3, 5]]) assert.equal(owner[at(r, c)], NORTH);
    assert.deepEqual(clusterPoints(decisions[0], SOUTH, statusOf), { seat: NORTH, points: 3 });
  });

  it('detonates a grey cluster whose colours have all been cut away, paying the current mover', () => {
    const { owner, decisions, statusOf } = resolve([
      '#....N....#',
      '...........',
      '.....N.....',
      'WW.WWG.....',
      '...........',
      '...........',
      '...........',
      '...........',
      '...........',
      '...........',
      '#.........#',
    ]);
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].outcome, 'detonate');
    assert.deepEqual(decisions[0].cells, cells([2, 5], [3, 3], [3, 4], [3, 5]));
    assert.equal(owner[at(3, 5)], EMPTY);
    assert.deepEqual(clusterPoints(decisions[0], EAST, statusOf), { seat: EAST, points: 4 });
  });

  it('keeps a grey cluster grey while it touches 2+ colours', () => {
    const { owner, decisions } = resolve([
      '#....N....#',
      '.....N.....',
      '.....N.....',
      'WWWWWG.....',
      '...........',
      '...........',
      '...........',
      '...........',
      '...........',
      '...........',
      '#.........#',
    ]);
    assert.equal(decisions[0].outcome, 'grey');
    assert.deepEqual(decisions[0].newlyGreyed, []);
    assert.equal(owner[at(3, 5)], GREY);
  });
});

describe('cluster resolution: dulled regions', () => {
  it('counts an anchored dulled region as a touching colour', () => {
    const { owner, decisions } = resolve(
      [
        '#....N....#',
        '.....N.....',
        '.....N.....',
        'WWWWWG.....',
        '...........',
        '...........',
        '...........',
        '...........',
        '...........',
        '...........',
        '#.........#',
      ],
      { statuses: { [WEST]: TIMED_OUT } },
    );
    assert.equal(decisions[0].outcome, 'grey');
    assert.equal(owner[at(3, 5)], GREY);
  });

  it('resolves a piece broken off a dulled region like any other orphan', () => {
    const { owner, decisions, statusOf } = resolve(
      [
        '#.........#',
        '...........',
        '...........',
        'WW.WW......',
        '...........',
        '...........',
        '...........',
        '...........',
        '...........',
        '...........',
        '#.........#',
      ],
      { statuses: { [WEST]: TIMED_OUT } },
    );
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].outcome, 'detonate');
    assert.deepEqual([owner[at(3, 0)], owner[at(3, 1)]], [WEST, WEST]);
    assert.deepEqual([owner[at(3, 3)], owner[at(3, 4)]], [EMPTY, EMPTY]);
    assert.deepEqual(clusterPoints(decisions[0], SOUTH, statusOf), { seat: SOUTH, points: 2 });
  });
});
