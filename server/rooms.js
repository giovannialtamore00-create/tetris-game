'use strict';

// Private rooms: one player creates a room and gets a short code, three more
// join with it, and the game starts when the fourth seat fills (§1, §13).
//
// This module knows nothing about sockets. A connection is any object with
// `send(message)` and optionally `close()`; the manager stores the player's
// room and seat on `conn.session`. Time and timers are injected so tests can
// drive them with a fake clock.

const crypto = require('node:crypto');
const game = require('../src/core/game');
const { SEAT_COUNT } = require('../src/core/constants');

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

class Room {
  constructor(manager, code) {
    this.manager = manager;
    this.code = code;
    // seats[seat] = { nickname, token, conn, graceTimer } or null when free.
    this.seats = new Array(SEAT_COUNT).fill(null);
    this.state = null; // set when the game starts
    this.deadlineTimer = null;
    this.cleanupTimer = null;
  }

  get started() {
    return this.state !== null;
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
    this.seats[seat] = { nickname: cleanNickname(nickname), token, conn: null, graceTimer: null };
    this.attach(conn, seat);

    if (this.seats.every(Boolean)) this.start();
    else this.broadcastLobby();
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
    if (this.started) this.broadcastState([]);
    else this.broadcastLobby();
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
    if (this.seats.every((s) => s === null)) {
      this.destroy();
      return;
    }
    if (!this.cleanupTimer) {
      this.cleanupTimer = this.manager.setTimer(() => this.destroy(), this.manager.emptyRoomTtlMs);
    }
  }

  destroy() {
    this.manager.clearTimer(this.deadlineTimer);
    this.manager.clearTimer(this.cleanupTimer);
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
    const result = game.createGame({ seed, now: this.manager.now() });
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

  act(conn, fn) {
    const seat = this.seatOf(conn);
    if (seat === null) return this.sendError(conn, 'notInRoom');
    if (!this.started) return this.sendError(conn, 'notStarted');
    const now = this.manager.now();
    this.advance(now); // apply expired deadlines first, as the core requires (§17)
    const result = fn(this.state, seat, now);
    if (!result.ok) return this.sendError(conn, result.error);
    this.state = result.state;
    this.broadcastState(result.events);
    this.scheduleDeadline();
  }

  advance(now) {
    const result = game.tick(this.state, now);
    this.state = result.state;
    if (result.events.length > 0) this.broadcastState(result.events);
  }

  // One timer per room, always set for the game's next deadline (§17).
  scheduleDeadline() {
    this.manager.clearTimer(this.deadlineTimer);
    this.deadlineTimer = null;
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
    return this.seats.map((s) => (s ? { nickname: s.nickname, connected: Boolean(s.conn) } : null));
  }

  eachConnected(fn) {
    this.seats.forEach((entry, seat) => {
      if (entry && entry.conn) fn(entry.conn, seat);
    });
  }

  broadcastLobby() {
    const seats = this.seatInfo();
    this.eachConnected((conn, seat) => conn.send({ type: 'lobby', code: this.code, you: seat, seats }));
  }

  broadcastState(events) {
    const message = {
      type: 'state',
      code: this.code,
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
  } = {}) {
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

module.exports = { RoomManager, publicState, cleanNickname };
