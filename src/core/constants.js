'use strict';

const SIZE = 11;
const CELL_COUNT = SIZE * SIZE;

// Cell owner values. Non-negative values are seat numbers.
const EMPTY = -1;
const BLOCKED = -2;
const GREY = -3;
const RAINBOW = -4; // §25: a placed rainbow block, owned by nobody

// Seats in clockwise turn order.
const SOUTH = 0;
const WEST = 1;
const NORTH = 2;
const EAST = 3;
const SEAT_COUNT = 4;

const ALIVE = 'alive';
const ELIMINATED = 'eliminated';
const TIMED_OUT = 'timedOut';

const TURNS = 'turns';
const REALTIME = 'realtime';

const DEFAULT_CONFIG = Object.freeze({
  mode: TURNS, // 'turns' (turn-based) or 'realtime' (§21)
  cooldownMs: 3_000, // real-time mode: wait after a placement without a line clear
  rainbowMode: false, // §25: rainbow mode on or off
  rainbowChance: 0.05, // §25: in rainbow mode, chance that any dealt piece is a rainbow piece
  handSize: 4,
  placedHp: 1,
  clockStartMs: 60_000,
  moveBonusMs: 2_000,
  lineClearBonusMs: 2_000, // per line the move completes
  forcedPassBonusMs: 5_000,
  capDecayMs: 1_000,
  afkMs: 10_000,
  turnDelayMs: 2_000, // pause before every turn; no personal clock runs (§8)
  shuffleWindowMs: 10_000,
  gameLengthMs: 600_000,
});

const idx = (r, c) => r * SIZE + c;
const rowOf = (i) => Math.floor(i / SIZE);
const colOf = (i) => i % SIZE;
const inBounds = (r, c) => r >= 0 && r < SIZE && c >= 0 && c < SIZE;
const isOccupied = (owner) => owner >= 0 || owner === GREY || owner === RAINBOW;

module.exports = {
  SIZE,
  CELL_COUNT,
  EMPTY,
  BLOCKED,
  GREY,
  RAINBOW,
  SOUTH,
  WEST,
  NORTH,
  EAST,
  SEAT_COUNT,
  ALIVE,
  ELIMINATED,
  TIMED_OUT,
  TURNS,
  REALTIME,
  DEFAULT_CONFIG,
  idx,
  rowOf,
  colOf,
  inBounds,
  isOccupied,
};
