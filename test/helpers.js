'use strict';

const assert = require('node:assert/strict');
const {
  SIZE,
  EMPTY,
  BLOCKED,
  GREY,
  SEAT_COUNT,
  ALIVE,
  idx,
} = require('../src/core/constants');
const { isCorner } = require('../src/core/board');
const game = require('../src/core/game');
const { checkInvariants } = require('../src/core/invariants');

// Board maps are 11 strings of 11 characters, row 0 (North) first:
//   '#' corner   '.' empty   'G' grey
//   'S' South (0)   'W' West (1)   'N' North (2)   'E' East (3)
// A lowercase seat letter ('s', 'w', 'n', 'e') is a surviving starting piece,
// i.e. a root; an uppercase letter is a block placed later.
// Optional HP maps use digits 1-3 ('.' or any other character = default 1).
const OWNER_CHARS = { '.': EMPTY, '#': BLOCKED, G: GREY, S: 0, W: 1, N: 2, E: 3, s: 0, w: 1, n: 2, e: 3 };

function parseBoard(rows, hpRows) {
  assert.equal(rows.length, SIZE, 'board map needs 11 rows');
  const owner = [];
  const hp = [];
  const root = [];
  for (let r = 0; r < SIZE; r++) {
    assert.equal(rows[r].length, SIZE, `row ${r} needs 11 characters`);
    for (let c = 0; c < SIZE; c++) {
      const ch = rows[r][c];
      const o = OWNER_CHARS[ch];
      assert.notEqual(o, undefined, `unknown board character '${ch}' at (${r},${c})`);
      assert.equal(o === BLOCKED, isCorner(r, c), `corner mismatch at (${r},${c})`);
      owner.push(o);
      root.push('swne'.includes(ch));
      const occupied = o >= 0 || o === GREY;
      const digit = hpRows ? Number(hpRows[r][c]) : NaN;
      hp.push(occupied ? (digit >= 1 && digit <= 3 ? digit : 1) : 0);
    }
  }
  return { owner, hp, root };
}

// A completely full, valid board: every cell belongs to the seat whose edge is
// nearest (ties go to the lower seat). Each seat's edge cells are starting
// pieces, which keeps every region anchored.
function fullBoardRows() {
  const chars = ['S', 'W', 'N', 'E'];
  const rows = [];
  for (let r = 0; r < SIZE; r++) {
    let row = '';
    for (let c = 0; c < SIZE; c++) {
      if (isCorner(r, c)) {
        row += '#';
        continue;
      }
      const dist = [SIZE - 1 - r, c, r, SIZE - 1 - c];
      const ch = chars[dist.indexOf(Math.min(...dist))];
      row += Math.min(...dist) === 0 ? ch.toLowerCase() : ch;
    }
    rows.push(row);
  }
  return rows;
}

// Builds a live-turn state for `active` at time `now`. Starts from a real game
// (pyramids, seeded hands and bags) and overrides whatever is given.
function buildState({
  rows,
  hpRows,
  active = 0,
  now = 0,
  seed = 1,
  hands = {},
  statuses = {},
  players = {},
  live = true,
} = {}) {
  const { state } = game.createGame({ seed, now });
  if (rows) Object.assign(state, parseBoard(rows, hpRows));
  for (const [seat, hand] of Object.entries(hands)) state.players[seat].hand = [...hand];
  for (const [seat, status] of Object.entries(statuses)) state.players[seat].status = status;
  for (const [seat, fields] of Object.entries(players)) Object.assign(state.players[seat], fields);
  state.phase = 'turn';
  state.activeSeat = active;
  state.turnStartedAt = live ? now : null;
  state.round = 1;
  state.turnsTakenThisRound = new Array(SEAT_COUNT).fill(false);
  state.forcedPassesThisRound = new Array(SEAT_COUNT).fill(false);
  assertValid(state);
  return state;
}

function assertValid(state) {
  assert.deepEqual(checkInvariants(state), []);
}

// Wrappers that assert success and the §6 invariants after every step.
function expectOk(result) {
  assert.equal(result.ok, true, `expected success, got error '${result.error}'`);
  assertValid(result.state);
  return result;
}

const move = (state, seat, mv, now) => expectOk(game.applyMove(state, seat, mv, now));
const tick = (state, now) => expectOk(game.tick(state, now));
const shuffle = (state, seat, now) => expectOk(game.shuffle(state, seat, now));
const startTurn = (state, seat, now) => expectOk(game.startTurn(state, seat, now));

const at = (r, c) => idx(r, c);
const ofType = (events, type) => events.filter((e) => e.type === type);
const scores = (state) => state.players.map((p) => p.score);

module.exports = {
  ALIVE,
  parseBoard,
  fullBoardRows,
  buildState,
  assertValid,
  expectOk,
  move,
  tick,
  shuffle,
  startTurn,
  at,
  ofType,
  scores,
};
