'use strict';

const {
  SEAT_COUNT,
  EMPTY,
  ALIVE,
  ELIMINATED,
  TIMED_OUT,
  REALTIME,
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
      cooldownUntil: now, // real-time mode: may place again from this time
    });
  }

  const s = {
    config: cfg,
    owner,
    hp,
    root,
    players,
    phase: 'turn', // 'interlude' | 'turn' | 'shuffleWindow' | 'realtime' | 'over'
    activeSeat: null, // the player to move (during an interlude: the next one)
    turnStartedAt: null, // set while a turn is live
    interludeEndsAt: null, // set during the pause before a turn
    pendingSeat: null, // seat that starts the next round after a shuffle window
    round: 1,
    turnsTakenThisRound: new Array(SEAT_COUNT).fill(false),
    forcedPassesThisRound: new Array(SEAT_COUNT).fill(false),
    startedAt: now,
    endsAt: now + cfg.gameLengthMs,
    shuffleWindowEndsAt: null,
    over: false,
    result: null,
    pausedAt: null, // §22: set while the game is paused
    pausedBy: null,
  };

  const events = [{ type: 'gameStarted', mode: cfg.mode, at: now, endsAt: s.endsAt }];
  if (cfg.mode === REALTIME) {
    // §21: no turns; everyone may place from the start.
    s.phase = 'realtime';
    refreshOffers(s, now, events);
    return ok(s, events);
  }
  const firstSeat = nextInt(createRng(deriveSeed(seed, 0)), SEAT_COUNT);
  queueTurn(s, firstSeat, now, events);
  return ok(s, events);
}

const isRealtime = (s) => s.config.mode === REALTIME;

// §21: in real-time mode a living player with no legal move gets a shuffle
// offer at once. Checked after every change to the board or a hand.
function refreshOffers(s, now, events) {
  for (const p of s.players) {
    if (p.status === ALIVE && !p.shuffleAvailable && !hasLegalMove(s.owner, p.seat, p.hand)) {
      p.shuffleAvailable = true;
      events.push({ type: 'shuffleOffered', seat: p.seat, at: now });
    }
  }
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
// ties broken game clock > personal clock > AFK > shuffle window > interlude (§9).
function pendingDeadlines(s) {
  if (s.over || s.pausedAt !== null) return []; // nothing falls due while paused (§22)
  const list = [{ at: s.endsAt, kind: 'gameEnd', priority: 0 }];
  if (s.phase === 'turn' && s.turnStartedAt !== null) {
    const p = s.players[s.activeSeat];
    list.push({ at: s.turnStartedAt + p.remainingMs, kind: 'clock', priority: 1 });
    list.push({ at: s.turnStartedAt + s.config.afkMs, kind: 'afk', priority: 2 });
  }
  if (s.phase === 'shuffleWindow') {
    list.push({ at: s.shuffleWindowEndsAt, kind: 'shuffleWindow', priority: 3 });
  }
  if (s.phase === 'interlude') {
    list.push({ at: s.interludeEndsAt, kind: 'interlude', priority: 4 });
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
  if (state.pausedAt !== null) return 'paused';
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

// §8: every turn is preceded by a short pause so players can see what just
// happened. No personal clock runs during it; the game clock does.
function queueTurn(s, seat, now, events) {
  if (s.config.turnDelayMs <= 0) {
    beginTurn(s, seat, now, events);
    return;
  }
  s.phase = 'interlude';
  s.activeSeat = seat;
  s.turnStartedAt = null;
  s.interludeEndsAt = now + s.config.turnDelayMs;
  events.push({ type: 'interlude', nextSeat: seat, at: now, endsAt: s.interludeEndsAt });
}

function beginTurn(s, seat, now, events) {
  s.phase = 'turn';
  s.interludeEndsAt = null;
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

  queueTurn(s, nextLivingSeat(s, fromSeat), now, events);
}

function closeShuffleWindow(s, now, events) {
  const seat = s.pendingSeat;
  s.pendingSeat = null;
  s.shuffleWindowEndsAt = null;
  events.push({ type: 'shuffleWindowClosed', at: now });
  queueTurn(s, seat, now, events);
}

function endGame(s, reason, now, events) {
  s.over = true;
  s.phase = 'over';
  s.activeSeat = null;
  s.turnStartedAt = null;
  s.interludeEndsAt = null;
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
  const realtime = isRealtime(state);
  const player = state.players[seat];
  if (realtime) {
    // §21: anyone alive may place at any time, once their cooldown is over.
    if (!player || player.status !== ALIVE) return fail('notAlive');
    if (now < player.cooldownUntil) return fail('coolingDown');
  } else if (state.phase !== 'turn' || state.activeSeat !== seat || state.turnStartedAt === null) {
    return fail('notYourTurn');
  }

  const { handIndex, rotation, x, y } = move || {};
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

  // §15 step 2: charge time (turn-based only; real-time has no personal clocks).
  if (!realtime) mover.remainingMs -= now - s.turnStartedAt;
  const lines = resolvePlacement(s, seat, { piece, rotation, x, y, cells }, now, events);
  mover.shuffleAvailable = false;

  if (realtime) {
    // §21: refill from the bag (no special reward piece); a line clear skips the cooldown.
    if (mover.status === ALIVE) {
      mover.hand[handIndex] = drawPiece(mover.bag);
      mover.cooldownUntil = lines.length > 0 ? now : now + cfg.cooldownMs;
      events.push({ type: 'cooldown', seat, until: mover.cooldownUntil, at: now });
    }
    if (livingSeats(s).length <= 1) endGame(s, 'lastPlayerStanding', now, events);
    else refreshOffers(s, now, events);
    return ok(s, events);
  }

  // Step 9: mover bookkeeping. Completing a line is rewarded by refilling the
  // played slot with a special piece instead of a bag draw (§3).
  if (mover.status === ALIVE) {
    if (lines.length > 0) {
      mover.hand[handIndex] = drawSpecialPiece(mover.bag);
      events.push({ type: 'rewardPiece', seat, piece: mover.hand[handIndex], handIndex });
    } else {
      mover.hand[handIndex] = drawPiece(mover.bag);
    }
    // +2 s for the move, plus 2 s for every line it completed (§8).
    const lineBonusMs = lines.length * cfg.lineClearBonusMs;
    if (lineBonusMs > 0) events.push({ type: 'lineClearBonus', seat, lines: lines.length, ms: lineBonusMs });
    addBonus(mover, cfg.moveBonusMs + lineBonusMs);
  }
  s.turnsTakenThisRound[seat] = true;

  // Steps 10-12.
  endTurn(s, now, events);
  return ok(s, events);
}

// §15 steps 3-8, shared by both modes: place the piece, apply line hits and
// destructions, resolve orphan and grey clusters, and eliminate players left
// with no blocks. Mutates `s`; returns the completed lines.
function resolvePlacement(s, seat, { piece, rotation, x, y, cells }, now, events) {
  const cfg = s.config;
  const statusOf = (k) => s.players[k].status;
  const scoreDelta = new Array(SEAT_COUNT).fill(0);
  const award = (k, points) => {
    s.players[k].score += points;
    scoreDelta[k] += points;
  };

  // Step 3: place.
  for (const i of cells) {
    s.owner[i] = seat;
    s.hp[i] = cfg.placedHp;
  }
  events.push({ type: 'placed', seat, piece, rotation, x, y, cells, at: now });

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
  return lines;
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

  if (isRealtime(s)) {
    // §21: still stuck after shuffling? A fresh offer is available at once.
    refreshOffers(s, now, events);
    return ok(s, events);
  }

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
    } else if (due.kind === 'shuffleWindow') {
      closeShuffleWindow(s, at, events);
    } else {
      beginTurn(s, s.activeSeat, at, events);
    }
  }
  return ok(s, events);
}

// §22: pausing freezes the whole game: the game clock, personal clocks, the
// AFK timer, the pause between turns, a shuffle window and real-time
// cooldowns. Who may resume is decided by the room (the pauser or the host).
function pause(state, seat, now) {
  const blocker = actionBlocker(state, now);
  if (blocker) return fail(blocker);
  if (!state.players[seat]) return fail('notInGame');
  const s = clone(state);
  s.pausedAt = now;
  s.pausedBy = seat;
  return ok(s, [{ type: 'paused', seat, at: now }]);
}

// Resuming shifts every pending time forward by the length of the pause, so
// the game carries on exactly where it stopped.
function resume(state, seat, now) {
  if (state.over) return fail('gameOver');
  if (state.pausedAt === null) return fail('notPaused');
  const s = clone(state);
  const pausedMs = Math.max(0, now - s.pausedAt);
  const shift = (t) => (t === null ? null : t + pausedMs);
  s.endsAt = shift(s.endsAt);
  s.turnStartedAt = shift(s.turnStartedAt);
  s.interludeEndsAt = shift(s.interludeEndsAt);
  s.shuffleWindowEndsAt = shift(s.shuffleWindowEndsAt);
  for (const p of s.players) p.cooldownUntil = shift(p.cooldownUntil);
  s.pausedAt = null;
  s.pausedBy = null;
  return ok(s, [{ type: 'resumed', seat, at: now, pausedMs }]);
}

module.exports = {
  createGame,
  pause,
  resume,
  startTurn,
  applyMove,
  shuffle,
  tick,
  nextDeadline,
  livingSeats,
};
