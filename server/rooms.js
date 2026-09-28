'use strict';

// Private rooms: one player creates a room and gets a short code, others join
// with it, and the game starts when the fourth seat fills (§1, §13). The host
// (the first human seat) can fill empty seats with easy bots, which the room
// plays on the server.
//
// This module knows nothing about sockets. A connection is any object with
// `send(message)` and optionally `close()`; the manager stores the player's
// room and seat on `conn.session`. Time, timers and randomness are injected so
// tests can drive them.

const crypto = require('node:crypto');
const game = require('../src/core/game');
const bot = require('../src/core/bot');
const { SEAT_COUNT, ALIVE, TURNS, REALTIME } = require('../src/core/constants');

const BOT_SHUFFLE_DELAY_MS = 600;

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I
const CODE_LENGTH = 4;
const NICKNAME_MAX = 16;

function cleanNickname(raw) {
  const nickname = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, NICKNAME_MAX);
  return nickname || 'Player';
}

// The state sent to clients: everything except each player's bag, whose queue
// and RNG state would reveal upcoming pieces. Hands stay visible (§3).
function publicState(state) {
  return { ...state, players: state.players.map(({ bag, ...rest }) => rest) };
}

// Move history: a snapshot of the board at the start and after every
// placement. Clients build the same entries from the states they receive;
// the server's copy is sent to a player who reconnects. Returns null when the
// events contain no placement.
function historyEntry(state, events) {
  const placed = events.find((e) => e.type === 'placed');
  const started = events.find((e) => e.type === 'gameStarted');
  if (!placed && !started) return null;
  return {
    owner: [...state.owner],
    hp: [...state.hp],
    seat: placed ? placed.seat : null,
    piece: placed ? placed.piece : null,
    cells: placed ? placed.cells : [],
    at: placed ? placed.at : started.at,
  };
}

class Room {
  constructor(manager, code) {
    this.manager = manager;
    this.code = code;
    // seats[seat] = { nickname, bot, token, conn, graceTimer } or null when free.
    // Bots have no token and no connection.
    this.seats = new Array(SEAT_COUNT).fill(null);
    this.state = null; // set when the game starts
    this.history = []; // board after the start and after every placement (move history)
    this.mode = TURNS; // chosen by the host in the lobby
    this.deadlineTimer = null;
    this.cleanupTimer = null;
    this.botTimer = null;
    this.botPlans = []; // real-time mode: botPlans[seat] = { readyAt, at }
  }

  get started() {
    return this.state !== null;
  }

  // The host is the first human seat: the creator, or whoever is next if they leave.
  get hostSeat() {
    const seat = this.seats.findIndex((s) => s && !s.bot);
    return seat === -1 ? null : seat;
  }

  isBot(seat) {
    return Boolean(this.seats[seat] && this.seats[seat].bot);
  }

  seatOf(conn) {
    return conn.session && conn.session.room === this ? conn.session.seat : null;
  }

  // --- Joining and leaving -------------------------------------------------

  join(conn, nickname) {
    if (this.started) return this.sendError(conn, 'gameStarted');
    const seat = this.seats.indexOf(null);
    if (seat === -1) return this.sendError(conn, 'roomFull');

    const token = crypto.randomBytes(16).toString('hex');
    this.seats[seat] = { nickname: cleanNickname(nickname), bot: false, token, conn: null, graceTimer: null };
    this.attach(conn, seat);

    if (this.seats.every(Boolean)) this.start();
    else this.broadcastLobby();
  }

  // Host only, before the game starts: seats an easy bot in the first free seat.
  addBot(conn) {
    const error = this.hostCheck(conn);
    if (error) return this.sendError(conn, error);
    const seat = this.seats.indexOf(null);
    if (seat === -1) return this.sendError(conn, 'roomFull');
    const taken = new Set(this.seats.filter((s) => s && s.bot).map((s) => s.nickname));
    let n = 1;
    while (taken.has(`Easy bot ${n}`)) n++;
    this.seats[seat] = { nickname: `Easy bot ${n}`, bot: true, token: null, conn: null, graceTimer: null };
    if (this.seats.every(Boolean)) this.start();
    else this.broadcastLobby();
  }

  // Host only, before the game starts: frees a bot's seat.
  removeBot(conn, seat) {
    const error = this.hostCheck(conn);
    if (error) return this.sendError(conn, error);
    if (!this.isBot(seat)) return this.sendError(conn, 'notABot');
    this.seats[seat] = null;
    this.broadcastLobby();
  }

  // Host only, before the game starts: turn-based or real-time mode.
  setMode(conn, mode) {
    const error = this.hostCheck(conn);
    if (error) return this.sendError(conn, error);
    if (mode !== TURNS && mode !== REALTIME) return this.sendError(conn, 'badMode');
    this.mode = mode;
    this.broadcastLobby();
  }

  hostCheck(conn) {
    if (this.started) return 'gameStarted';
    if (this.seatOf(conn) === null || this.seatOf(conn) !== this.hostSeat) return 'notHost';
    return null;
  }

  // Reclaims a seat with the token handed out on joining, e.g. after a refresh
  // or a dropped connection. A second tab using the same token takes over.
  resume(conn, token) {
    const seat = this.seats.findIndex((s) => s && s.token === token);
    if (seat === -1) return this.sendError(conn, 'sessionExpired');

    const entry = this.seats[seat];
    if (entry.conn && entry.conn !== conn) {
      const old = entry.conn;
      old.session = null;
      old.send({ type: 'replaced' });
      if (old.close) old.close();
    }
    this.attach(conn, seat);
    if (this.started) {
      this.broadcastState([]);
      conn.send({ type: 'history', entries: this.history }); // move history survives a refresh
    } else {
      this.broadcastLobby();
    }
  }

  attach(conn, seat) {
    const entry = this.seats[seat];
    this.manager.clearTimer(entry.graceTimer);
    entry.graceTimer = null;
    this.manager.clearTimer(this.cleanupTimer);
    this.cleanupTimer = null;
    entry.conn = conn;
    conn.session = { room: this, seat };
    conn.send({ type: 'joined', code: this.code, seat, token: entry.token });
  }

  // Explicit leave. Before the game starts the seat is freed; once it has
  // started the seat stays (the player's clock keeps running, §9).
  leave(conn) {
    const seat = this.seatOf(conn);
    if (seat === null) return;
    conn.session = null;
    if (this.started) {
      this.seats[seat].conn = null;
      this.broadcastState([]);
    } else {
      this.seats[seat] = null;
      this.broadcastLobby();
    }
    conn.send({ type: 'left' });
    this.checkEmpty();
  }

  // Dropped connection. In the lobby the seat is held for a grace period so a
  // refresh can reclaim it; in a game it is held for good.
  disconnect(conn) {
    const seat = this.seatOf(conn);
    if (seat === null) return;
    conn.session = null;
    const entry = this.seats[seat];
    entry.conn = null;
    if (this.started) {
      this.broadcastState([]);
    } else {
      entry.graceTimer = this.manager.setTimer(() => {
        if (this.seats[seat] === entry && !entry.conn) {
          this.seats[seat] = null;
          this.broadcastLobby();
          this.checkEmpty();
        }
      }, this.manager.lobbyGraceMs);
      this.broadcastLobby();
    }
    this.checkEmpty();
  }

  // A room nobody is connected to is removed: at once if no seat is taken,
  // otherwise after a grace period (so a started game can still be resumed).
  checkEmpty() {
    if (this.seats.some((s) => s && s.conn)) return;
    if (!this.seats.some((s) => s && !s.bot)) {
      this.destroy(); // no humans left at all (at most bots)
      return;
    }
    if (!this.cleanupTimer) {
      this.cleanupTimer = this.manager.setTimer(() => this.destroy(), this.manager.emptyRoomTtlMs);
    }
  }

  destroy() {
    this.manager.clearTimer(this.deadlineTimer);
    this.manager.clearTimer(this.cleanupTimer);
    this.manager.clearTimer(this.botTimer);
    for (const entry of this.seats) {
      if (!entry) continue;
      this.manager.clearTimer(entry.graceTimer);
      if (entry.conn) entry.conn.session = null; // later disconnects must not touch this room
    }
    this.manager.rooms.delete(this.code);
  }

  // --- Playing ----------------------------------------------------------------

  start() {
    const seed = Math.floor(this.manager.random() * 2 ** 31);
    const config = { ...this.manager.gameConfig, mode: this.mode };
    const result = game.createGame({ seed, now: this.manager.now(), config });
    this.state = result.state;
    this.broadcastState(result.events);
    this.scheduleDeadline();
  }

  move(conn, move) {
    this.act(conn, (state, seat, now) => game.applyMove(state, seat, move, now));
  }

  shuffle(conn) {
    this.act(conn, (state, seat, now) => game.shuffle(state, seat, now));
  }

  // §22: any player may pause; only the player who paused, or the host, may resume.
  pause(conn) {
    this.act(conn, (state, seat, now) => game.pause(state, seat, now));
  }

  unpause(conn) {
    const seat = this.seatOf(conn);
    if (this.started && this.state.pausedAt !== null && seat !== this.state.pausedBy && seat !== this.hostSeat) {
      return this.sendError(conn, 'notAllowedToResume');
    }
    this.act(conn, (state, k, now) => game.resume(state, k, now));
  }

  act(conn, fn) {
    const seat = this.seatOf(conn);
    if (seat === null) return this.sendError(conn, 'notInRoom');
    if (!this.started) return this.sendError(conn, 'notStarted');
    const result = this.perform(seat, fn);
    if (!result.ok) this.sendError(conn, result.error);
  }

  // Applies one action for a seat (human or bot) and shares the result.
  perform(seat, fn) {
    const now = this.manager.now();
    this.advance(now); // apply expired deadlines first, as the core requires (§17)
    const result = fn(this.state, seat, now);
    if (result.ok) {
      this.state = result.state;
      this.broadcastState(result.events);
    }
    this.scheduleDeadline();
    return result;
  }

  // --- Bots ---------------------------------------------------------------------
  // After every state change the room looks for something a bot should do: use
  // a shuffle offer (shortly), or move on its live turn (after thinking for
  // 1.5-2.5 s). One timer is enough, because every bot action changes the
  // state and so schedules the next one.
  scheduleBots() {
    this.manager.clearTimer(this.botTimer);
    this.botTimer = null;
    const s = this.state;
    if (!s || s.over || s.pausedAt !== null) return; // bots wait while paused
    if (s.config.mode === REALTIME) {
      this.scheduleRealtimeBots();
      return;
    }

    const shuffler = this.seats.findIndex((entry, seat) => entry && entry.bot && bot.wantsShuffle(s, seat));
    if (shuffler !== -1) {
      this.botTimer = this.manager.setTimer(() => {
        this.botTimer = null;
        this.perform(shuffler, (state, seat, now) => game.shuffle(state, seat, now));
      }, BOT_SHUFFLE_DELAY_MS);
      return;
    }

    if (s.phase === 'turn' && s.turnStartedAt !== null && this.isBot(s.activeSeat)) {
      const seat = s.activeSeat;
      const turnStartedAt = s.turnStartedAt;
      const delay = Math.max(0, turnStartedAt + bot.botThinkMs(this.manager.random) - this.manager.now());
      this.botTimer = this.manager.setTimer(() => {
        this.botTimer = null;
        this.advance(this.manager.now());
        // The turn may have ended meanwhile (e.g. the game clock ran out).
        if (this.state.activeSeat !== seat || this.state.turnStartedAt !== turnStartedAt) {
          this.scheduleDeadline();
          return;
        }
        const move = bot.chooseEasyMove(this.state, seat, this.manager.random);
        if (move) this.perform(seat, (state, k, now) => game.applyMove(state, k, move, now));
        else this.scheduleDeadline();
      }, delay);
    }
  }

  advance(now) {
    const result = game.tick(this.state, now);
    this.state = result.state;
    if (result.events.length > 0) this.broadcastState(result.events);
  }

  // Real-time mode (§21): each bot acts when its cooldown is over plus a
  // 1.5-2.5 s think. The plan is redrawn whenever the bot's cooldown changes.
  // The room's one bot timer is set for whichever bot acts first.
  scheduleRealtimeBots() {
    const s = this.state;
    const now = this.manager.now();
    let next = null;
    this.seats.forEach((entry, seat) => {
      if (!entry || !entry.bot || s.players[seat].status !== ALIVE) return;
      const readyAt = s.players[seat].cooldownUntil;
      let plan = this.botPlans[seat];
      if (!plan || plan.readyAt !== readyAt) {
        plan = { readyAt, at: Math.max(now, readyAt) + bot.botThinkMs(this.manager.random) };
        this.botPlans[seat] = plan;
      }
      if (!next || plan.at < next.at) next = { seat, at: plan.at };
    });
    if (!next) return;
    this.botTimer = this.manager.setTimer(() => {
      this.botTimer = null;
      this.realtimeBotAct(next.seat);
    }, Math.max(0, next.at - now));
  }

  // A real-time bot's action: place a random legal piece if it can, otherwise
  // use a shuffle offer, otherwise wait and think again.
  realtimeBotAct(seat) {
    this.botPlans[seat] = null;
    this.advance(this.manager.now());
    const s = this.state;
    if (s.over) return;
    const choice = bot.chooseEasyMove(s, seat, this.manager.random);
    if (choice && this.manager.now() >= s.players[seat].cooldownUntil) {
      this.perform(seat, (state, k, now) => game.applyMove(state, k, choice, now));
    } else if (bot.wantsShuffle(s, seat)) {
      this.perform(seat, (state, k, now) => game.shuffle(state, k, now));
    } else {
      this.scheduleDeadline();
    }
  }

  // One timer per room, always set for the game's next deadline (§17). Also
  // (re)schedules any bot action for the current state.
  scheduleDeadline() {
    this.manager.clearTimer(this.deadlineTimer);
    this.deadlineTimer = null;
    this.scheduleBots();
    const deadline = game.nextDeadline(this.state);
    if (deadline === null) return;
    const delay = Math.max(0, deadline - this.manager.now());
    this.deadlineTimer = this.manager.setTimer(() => {
      this.deadlineTimer = null;
      this.advance(this.manager.now());
      this.scheduleDeadline();
    }, delay);
  }

  // --- Messages -----------------------------------------------------------------

  seatInfo() {
    return this.seats.map((s) => (s ? { nickname: s.nickname, bot: s.bot, connected: s.bot || Boolean(s.conn) } : null));
  }

  eachConnected(fn) {
    this.seats.forEach((entry, seat) => {
      if (entry && entry.conn) fn(entry.conn, seat);
    });
  }

  broadcastLobby() {
    const seats = this.seatInfo();
    const host = this.hostSeat;
    const mode = this.mode;
    this.eachConnected((conn, seat) => conn.send({ type: 'lobby', code: this.code, you: seat, host, mode, seats }));
  }

  broadcastState(events) {
    const entry = historyEntry(this.state, events);
    if (entry) this.history.push(entry);
    const message = {
      type: 'state',
      code: this.code,
      host: this.hostSeat,
      seats: this.seatInfo(),
      state: publicState(this.state),
      events,
      serverNow: this.manager.now(),
    };
    this.eachConnected((conn, seat) => conn.send({ ...message, you: seat }));
  }

  sendError(conn, error) {
    conn.send({ type: 'error', error });
  }
}

class RoomManager {
  constructor({
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    random = Math.random,
    lobbyGraceMs = 20_000,
    emptyRoomTtlMs = 10 * 60_000,
    gameConfig = {}, // overrides for the core's DEFAULT_CONFIG in every new game
  } = {}) {
    this.gameConfig = gameConfig;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = (handle) => {
      if (handle !== null && handle !== undefined) clearTimer(handle);
    };
    this.random = random;
    this.lobbyGraceMs = lobbyGraceMs;
    this.emptyRoomTtlMs = emptyRoomTtlMs;
    this.rooms = new Map();
  }

  createRoom() {
    let code;
    do {
      code = '';
      for (let k = 0; k < CODE_LENGTH; k++) {
        code += CODE_ALPHABET[Math.floor(this.random() * CODE_ALPHABET.length)];
      }
    } while (this.rooms.has(code));
    const room = new Room(this, code);
    this.rooms.set(code, room);
    return room;
  }

  // Client -> server messages:
  //   { type: 'create', nickname }
  //   { type: 'join', code, nickname }
  //   { type: 'resume', code, token }
  //   { type: 'leave' }
  //   { type: 'move', move: { handIndex, rotation, x, y } }
  //   { type: 'shuffle' }
  //   { type: 'addBot' }              (host, lobby only)
  //   { type: 'removeBot', seat }     (host, lobby only)
  //   { type: 'setMode', mode }       (host, lobby only: 'turns' or 'realtime')
  //   { type: 'pause' }               (any player, during a game)
  //   { type: 'unpause' }             (the player who paused, or the host)
  handleMessage(conn, msg) {
    const room = conn.session ? conn.session.room : null;
    switch (msg.type) {
      case 'create':
        if (room) return conn.send({ type: 'error', error: 'alreadyInRoom' });
        this.createRoom().join(conn, msg.nickname);
        return;
      case 'join': {
        if (room) return conn.send({ type: 'error', error: 'alreadyInRoom' });
        const target = this.rooms.get(String(msg.code ?? '').trim().toUpperCase());
        if (!target) return conn.send({ type: 'error', error: 'roomNotFound' });
        target.join(conn, msg.nickname);
        return;
      }
      case 'resume': {
        const target = this.rooms.get(String(msg.code ?? '').trim().toUpperCase());
        if (room && room !== target) return conn.send({ type: 'error', error: 'alreadyInRoom' });
        if (!target) return conn.send({ type: 'error', error: 'sessionExpired' });
        target.resume(conn, String(msg.token ?? ''));
        return;
      }
      case 'leave':
        if (room) room.leave(conn);
        return;
      case 'move':
        if (!room) return conn.send({ type: 'error', error: 'notInRoom' });
        room.move(conn, msg.move);
        return;
      case 'shuffle':
        if (!room) return conn.send({ type: 'error', error: 'notInRoom' });
        room.shuffle(conn);
        return;
      case 'addBot':
        if (!room) return conn.send({ type: 'error', error: 'notInRoom' });
        room.addBot(conn);
        return;
      case 'removeBot':
        if (!room) return conn.send({ type: 'error', error: 'notInRoom' });
        room.removeBot(conn, Number(msg.seat));
        return;
      case 'setMode':
        if (!room) return conn.send({ type: 'error', error: 'notInRoom' });
        room.setMode(conn, msg.mode);
        return;
      case 'pause':
        if (!room) return conn.send({ type: 'error', error: 'notInRoom' });
        room.pause(conn);
        return;
      case 'unpause':
        if (!room) return conn.send({ type: 'error', error: 'notInRoom' });
        room.unpause(conn);
        return;
      default:
        conn.send({ type: 'error', error: 'unknownMessage' });
    }
  }

  handleDisconnect(conn) {
    if (conn.session) conn.session.room.disconnect(conn);
  }

  // Stops every room's timers and forgets all rooms (server shutdown).
  closeAll() {
    for (const room of [...this.rooms.values()]) room.destroy();
  }
}

module.exports = { RoomManager, publicState, cleanNickname, historyEntry };
