'use strict';

const {
  SEAT_COUNT,
  EMPTY,
  ALIVE,
  ELIMINATED,
  TIMED_OUT,
  DEFAULT_CONFIG,
} = require('./constants');
const { deriveSeed, createRng, nextInt } = require('./rng');
const { createBag, drawPiece, drawSpecialPiece } = require('./pieces');
const {
  createStartingBoard,
  pieceCells,
  isLegalPlacement,
  hasLegalMove,
  countBlocks,
} = require('./board');
const { completedLines, hitCounts } = require('./lines');
const { resolveClusters, clusterPoints } = require('./resolve');
const { rankPlayers } = require('./ranking');

// Every public function is pure: it takes a state and returns
// { ok: true, state, events } with a new state, or { ok: false, error } and
// leaves the input untouched. Internal helpers mutate a working copy.

const ok = (state, events) => ({ ok: true, state, events });
const fail = (error) => ({ ok: false, error });
const clone = (state) => structuredClone(state);

// ---------------------------------------------------------------------------
// Creation

function createGame({ seed = 1, now = 0, config = {} } = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const { owner, hp, root } = createStartingBoard();

  const players = [];
  for (let seat = 0; seat < SEAT_COUNT; seat++) {
    const bag = createBag(deriveSeed(seed, seat + 1));
    const hand = [];
    for (let k = 0; k < cfg.handSize; k++) hand.push(drawPiece(bag));
    players.push({
      seat,
      status: ALIVE,
      score: 0,
      hand,
      bag,
      remainingMs: cfg.clockStartMs,
      capMs: cfg.clockStartMs,
      shuffleAvailable: false,
    });
  }

  const s = {
    config: cfg,
    owner,
    hp,
    root,
    players,
    phase: 'turn', // 'turn' | 'shuffleWindow' | 'over'
    activeSeat: null,
    turnStartedAt: null, // set while a turn is live
    pendingSeat: null, // seat that starts the next round after a shuffle window
    round: 1,
    turnsTakenThisRound: new Array(SEAT_COUNT).fill(false),
    forcedPassesThisRound: new Array(SEAT_COUNT).fill(false),
    startedAt: now,
    endsAt: now + cfg.gameLengthMs,
    shuffleWindowEndsAt: null,
    over: false,
    result: null,
  };

  const events = [{ type: 'gameStarted', at: now, endsAt: s.endsAt }];
  const firstSeat = nextInt(createRng(deriveSeed(seed, 0)), SEAT_COUNT);
  beginTurn(s, firstSeat, now, events);
  return ok(s, events);
}

// ---------------------------------------------------------------------------
// Queries

const livingSeats = (s) => s.players.filter((p) => p.status === ALIVE).map((p) => p.seat);

function nextLivingSeat(s, from) {
  for (let k = 1; k <= SEAT_COUNT; k++) {
    const seat = (from + k) % SEAT_COUNT;
    if (s.players[seat].status === ALIVE) return seat;
  }
  return null;
}

// Pending deadlines in the order they must be applied: chronological, with
// ties broken game clock > personal clock > AFK > shuffle window (§9).
function pendingDeadlines(s) {
  if (s.over) return [];
  const list = [{ at: s.endsAt, kind: 'gameEnd', priority: 0 }];
  if (s.phase === 'turn' && s.turnStartedAt !== null) {
    const p = s.players[s.activeSeat];
    list.push({ at: s.turnStartedAt + p.remainingMs, kind: 'clock', priority: 1 });
    list.push({ at: s.turnStartedAt + s.config.afkMs, kind: 'afk', priority: 2 });
  }
  if (s.phase === 'shuffleWindow') {
    list.push({ at: s.shuffleWindowEndsAt, kind: 'shuffleWindow', priority: 3 });
  }
  return list.sort((a, b) => a.at - b.at || a.priority - b.priority);
}

function nextDeadline(state) {
  const [first] = pendingDeadlines(state);
  return first ? first.at : null;
}

// Actions are rejected once any deadline has passed: the room layer must call
// tick() first, so a late timer can never let a stale action through (§17).
function actionBlocker(state, now) {
  if (state.over) return 'gameOver';
  const deadline = nextDeadline(state);
  if (deadline !== null && now >= deadline) return 'tickRequired';
  return null;
}

// ---------------------------------------------------------------------------
// Turn flow (internal, mutating)

// §9: bonuses never push a clock above its cap, and never reduce it.
function addBonus(player, ms) {
  player.remainingMs = Math.max(player.remainingMs, Math.min(player.remainingMs + ms, player.capMs));
}

function beginTurn(s, seat, now, events) {
  s.phase = 'turn';
  s.activeSeat = seat;
  s.turnStartedAt = null;
  if (!hasLegalMove(s.owner, seat, s.players[seat].hand)) {
    forcedPass(s, seat, now, events);
    return;
  }
  s.turnStartedAt = now;
  events.push({ type: 'turnStarted', seat, round: s.round, at: now });
}

function forcedPass(s, seat, now, events) {
  const p = s.players[seat];
  addBonus(p, s.config.forcedPassBonusMs);
  p.shuffleAvailable = true;
  s.forcedPassesThisRound[seat] = true;
  s.turnsTakenThisRound[seat] = true;
  events.push({ type: 'passed', seat, reason: 'noLegalMoves', at: now });
  endTurn(s, now, events);
}

function endTurn(s, now, events) {
  const fromSeat = s.activeSeat;
  s.turnStartedAt = null;

  const living = livingSeats(s);
  if (living.length <= 1) {
    endGame(s, 'lastPlayerStanding', now, events);
    return;
  }

  // §10: the round ends once every living player has taken a turn.
  if (living.every((seat) => s.turnsTakenThisRound[seat])) {
    const everyoneStuck = living.every((seat) => s.forcedPassesThisRound[seat]);
    for (const seat of living) {
      const p = s.players[seat];
      p.score += 1;
      p.capMs = Math.max(0, p.capMs - s.config.capDecayMs);
    }
    events.push({ type: 'roundEnded', round: s.round, at: now });
    s.round += 1;
    s.turnsTakenThisRound.fill(false);
    s.forcedPassesThisRound.fill(false);

    if (everyoneStuck) {
      s.phase = 'shuffleWindow';
      s.activeSeat = null;
      s.pendingSeat = nextLivingSeat(s, fromSeat);
      s.shuffleWindowEndsAt = now + s.config.shuffleWindowMs;
      events.push({ type: 'shuffleWindowOpened', at: now, endsAt: s.shuffleWindowEndsAt });
      return;
    }
  }

  beginTurn(s, nextLivingSeat(s, fromSeat), now, events);
}

function closeShuffleWindow(s, now, events) {
  const seat = s.pendingSeat;
  s.pendingSeat = null;
  s.shuffleWindowEndsAt = null;
  events.push({ type: 'shuffleWindowClosed', at: now });
  beginTurn(s, seat, now, events);
}

function endGame(s, reason, now, events) {
  s.over = true;
  s.phase = 'over';
  s.activeSeat = null;
  s.turnStartedAt = null;
  s.pendingSeat = null;
  s.shuffleWindowEndsAt = null;
  s.result = { reason, ...rankPlayers(s.players, s.owner) };
  events.push({ type: 'gameOver', reason, at: now, result: s.result });
}

// ---------------------------------------------------------------------------
// Public actions

function startTurn(state, seat, now) {
  const s = clone(state);
  const events = [];
  beginTurn(s, seat, now, events);
  return ok(s, events);
}

// move = { handIndex, rotation, x, y }: x/y are the column/row of the top-left
// of the rotated piece's bounding box, in absolute board coordinates.
function applyMove(state, seat, move, now) {
  const blocker = actionBlocker(state, now);
  if (blocker) return fail(blocker);
  if (state.phase !== 'turn' || state.activeSeat !== seat || state.turnStartedAt === null) {
    return fail('notYourTurn');
  }

  const { handIndex, rotation, x, y } = move || {};
  const player = state.players[seat];
  if (!Number.isInteger(handIndex) || handIndex < 0 || handIndex >= player.hand.length) {
    return fail('invalidHandIndex');
  }
  if (!Number.isInteger(rotation) || rotation < 0 || rotation > 3) return fail('invalidRotation');
  if (!Number.isInteger(x) || !Number.isInteger(y)) return fail('invalidPosition');
  const piece = player.hand[handIndex];
  const cells = pieceCells(piece, rotation, x, y);
  if (!isLegalPlacement(state.owner, seat, cells)) return fail('illegalPlacement');

  const s = clone(state);
  const events = [];
  const cfg = s.config;
  const mover = s.players[seat];
  const statusOf = (k) => s.players[k].status;
  const scoreDelta = new Array(SEAT_COUNT).fill(0);
  const award = (k, points) => {
    s.players[k].score += points;
    scoreDelta[k] += points;
  };

  // §15 steps 2-3: charge time, place.
  mover.remainingMs -= now - s.turnStartedAt;
  for (const i of cells) {
    s.owner[i] = seat;
    s.hp[i] = cfg.placedHp;
  }
  events.push({ type: 'placed', seat, piece, rotation, x, y, cells });

  // Steps 4-5: line hits and destructions.
  const lines = completedLines(s.owner, cells);
  if (lines.length > 0) {
    const hits = [];
    const destroyed = [];
    for (const [i, count] of hitCounts(lines)) {
      const formerOwner = s.owner[i];
      s.hp[i] = Math.max(0, s.hp[i] - count);
      hits.push({ cell: i, hits: count, hp: s.hp[i] });
      if (s.hp[i] === 0) {
        s.owner[i] = EMPTY;
        s.root[i] = false; // a destroyed starting piece is gone for good
        const points = formerOwner === seat ? 2 : 1;
        award(seat, points);
        destroyed.push({ cell: i, owner: formerOwner, points });
      }
    }
    events.push({ type: 'linesCompleted', lines });
    events.push({ type: 'hit', cells: hits });
    if (destroyed.length > 0) events.push({ type: 'destroyed', scorer: seat, cells: destroyed });
  }

  // Steps 6-7: anchoring and cluster resolution.
  for (const decision of resolveClusters(s.owner, s.hp, s.root)) {
    const payout = clusterPoints(decision, seat, statusOf);
    if (payout) award(payout.seat, payout.points);
    const points = payout ? payout.points : 0;
    if (decision.outcome === 'detonate') {
      events.push({ type: 'detonated', scorer: seat, points, cells: decision.cells });
    } else if (decision.outcome === 'convert') {
      events.push({ type: 'converted', to: decision.to, points, cells: decision.cells });
    } else if (decision.newlyGreyed.length > 0) {
      events.push({ type: 'greyed', cells: decision.newlyGreyed, cluster: decision.cells });
    }
  }
  if (scoreDelta.some((d) => d !== 0)) events.push({ type: 'scored', deltas: scoreDelta });

  // Step 8: eliminations.
  for (const p of s.players) {
    if (p.status === ALIVE && countBlocks(s.owner, p.seat) === 0) {
      p.status = ELIMINATED;
      p.shuffleAvailable = false;
      events.push({ type: 'eliminated', seat: p.seat, at: now });
    }
  }

  // Step 9: mover bookkeeping. Completing a line is rewarded by refilling the
  // played slot with a special piece instead of a bag draw (§3).
  mover.shuffleAvailable = false;
  if (mover.status === ALIVE) {
    if (lines.length > 0) {
      mover.hand[handIndex] = drawSpecialPiece(mover.bag);
      events.push({ type: 'rewardPiece', seat, piece: mover.hand[handIndex], handIndex });
    } else {
      mover.hand[handIndex] = drawPiece(mover.bag);
    }
    addBonus(mover, cfg.moveBonusMs);
  }
  s.turnsTakenThisRound[seat] = true;

  // Steps 10-12.
  endTurn(s, now, events);
  return ok(s, events);
}

function shuffle(state, seat, now) {
  const blocker = actionBlocker(state, now);
  if (blocker) return fail(blocker);
  const player = state.players[seat];
  if (!player || player.status !== ALIVE) return fail('notAlive');
  if (!player.shuffleAvailable) return fail('noShuffleAvailable');

  const s = clone(state);
  const events = [];
  const p = s.players[seat];
  // A shuffled hand is bag draws plus one special piece in the last slot (§8).
  p.hand = [];
  for (let k = 0; k < s.config.handSize - 1; k++) p.hand.push(drawPiece(p.bag));
  p.hand.push(drawSpecialPiece(p.bag));
  p.shuffleAvailable = false;
  events.push({ type: 'shuffled', seat, hand: [...p.hand], at: now });

  const ownLiveTurn = s.phase === 'turn' && s.activeSeat === seat && s.turnStartedAt !== null;
  if (ownLiveTurn && !hasLegalMove(s.owner, seat, p.hand)) {
    p.remainingMs -= now - s.turnStartedAt;
    forcedPass(s, seat, now, events);
  } else if (
    s.phase === 'shuffleWindow' &&
    livingSeats(s).every((k) => !s.players[k].shuffleAvailable)
  ) {
    closeShuffleWindow(s, now, events);
  }
  return ok(s, events);
}

// Applies every deadline that has expired by `now`, in order. Each is applied
// at its own deadline time, so a late timer gives the same result as a punctual one.
function tick(state, now) {
  const s = clone(state);
  const events = [];
  for (;;) {
    const [due] = pendingDeadlines(s);
    if (!due || now < due.at) break;
    const at = due.at;
    if (due.kind === 'gameEnd') {
      endGame(s, 'timeUp', at, events);
    } else if (due.kind === 'clock') {
      const p = s.players[s.activeSeat];
      p.remainingMs = 0;
      p.status = TIMED_OUT;
      p.shuffleAvailable = false;
      events.push({ type: 'timedOut', seat: p.seat, at });
      endTurn(s, at, events);
    } else if (due.kind === 'afk') {
      const p = s.players[s.activeSeat];
      p.remainingMs -= s.config.afkMs;
      s.turnsTakenThisRound[p.seat] = true;
      events.push({ type: 'passed', seat: p.seat, reason: 'afk', at });
      endTurn(s, at, events);
    } else {
      closeShuffleWindow(s, at, events);
    }
  }
  return ok(s, events);
}

module.exports = {
  createGame,
  startTurn,
  applyMove,
  shuffle,
  tick,
  nextDeadline,
  livingSeats,
};
