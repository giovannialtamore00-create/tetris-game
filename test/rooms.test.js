'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { RoomManager, publicState, cleanNickname } = require('../server/rooms');
const { SOUTH, WEST, NORTH } = require('../src/core/constants');
const { pieceCells, isLegalPlacement } = require('../src/core/board');

// A fake clock and timer queue, so deadlines can be driven by hand.
function fakeEnv() {
  let t = 1_000_000;
  let nextId = 1;
  const timers = new Map();
  const env = {
    now: () => t,
    setTimer(fn, ms) {
      const id = nextId++;
      timers.set(id, { at: t + ms, fn });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    random: (() => {
      let x = 0.123;
      return () => (x = (x * 9301 + 0.49297) % 1);
    })(),
    advance(ms) {
      const end = t + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, tm]) => tm.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        t = Math.max(t, due[1].at);
        due[1].fn();
      }
      t = end;
    },
  };
  return env;
}

function fakeConn() {
  return {
    session: null,
    sent: [],
    closed: false,
    send(message) {
      this.sent.push(JSON.parse(JSON.stringify(message)));
    },
    close() {
      this.closed = true;
    },
    last(type) {
      return [...this.sent].reverse().find((m) => m.type === type);
    },
    all(type) {
      return this.sent.filter((m) => m.type === type);
    },
  };
}

function setup(options = {}) {
  const env = fakeEnv();
  const rooms = new RoomManager({ ...env, lobbyGraceMs: 20_000, emptyRoomTtlMs: 60_000, ...options });
  return { env, rooms };
}

// Creates a room and fills it with four players; returns their connections by seat.
function fullRoom() {
  const { env, rooms } = setup();
  const conns = [fakeConn(), fakeConn(), fakeConn(), fakeConn()];
  rooms.handleMessage(conns[0], { type: 'create', nickname: 'Ann' });
  const code = conns[0].last('joined').code;
  ['Bob', 'Cat', 'Dan'].forEach((nickname, k) => rooms.handleMessage(conns[k + 1], { type: 'join', code, nickname }));
  return { env, rooms, conns, code, room: rooms.rooms.get(code) };
}

function firstLegalMove(state, seat) {
  const hand = state.players[seat].hand;
  for (let handIndex = 0; handIndex < hand.length; handIndex++) {
    for (let rotation = 0; rotation < 4; rotation++) {
      for (let y = 0; y < 11; y++) {
        for (let x = 0; x < 11; x++) {
          if (isLegalPlacement(state.owner, seat, pieceCells(hand[handIndex], rotation, x, y))) {
            return { handIndex, rotation, x, y };
          }
        }
      }
    }
  }
  return null;
}

describe('rooms: creating and joining', () => {
  it('creates a room with a 4-character code and seats the creator at South', () => {
    const { rooms } = setup();
    const ann = fakeConn();
    rooms.handleMessage(ann, { type: 'create', nickname: 'Ann' });
    const joined = ann.last('joined');
    assert.match(joined.code, /^[A-HJ-NP-Z2-9]{4}$/);
    assert.equal(joined.seat, SOUTH);
    assert.match(joined.token, /^[0-9a-f]{32}$/);
    const lobby = ann.last('lobby');
    assert.deepEqual(lobby.seats, [{ nickname: 'Ann', bot: false, connected: true }, null, null, null]);
    assert.equal(lobby.you, SOUTH);
  });

  it('seats joiners clockwise in join order and tells everyone who is in the lobby', () => {
    const { rooms } = setup();
    const ann = fakeConn();
    const bob = fakeConn();
    rooms.handleMessage(ann, { type: 'create', nickname: 'Ann' });
    const code = ann.last('joined').code;
    rooms.handleMessage(bob, { type: 'join', code: code.toLowerCase(), nickname: 'Bob' });
    assert.equal(bob.last('joined').seat, WEST);
    assert.deepEqual(ann.last('lobby').seats.map((s) => s && s.nickname), ['Ann', 'Bob', null, null]);
  });

  it('starts the game when the fourth player joins', () => {
    const { conns } = fullRoom();
    conns.forEach((conn, seat) => {
      const msg = conn.last('state');
      assert.ok(msg, `seat ${seat} got no state`);
      assert.equal(msg.you, seat);
      assert.deepEqual(msg.seats.map((s) => s.nickname), ['Ann', 'Bob', 'Cat', 'Dan']);
      assert.equal(msg.state.phase, 'interlude');
      assert.ok(msg.events.some((e) => e.type === 'gameStarted'));
    });
  });

  it('broadcasts the start of the first turn when the 2 s pause ends', () => {
    const { env, conns, room } = fullRoom();
    env.advance(2_000);
    for (const conn of conns) {
      assert.ok(conn.last('state').events.some((e) => e.type === 'turnStarted' && e.seat === room.state.activeSeat));
    }
  });

  it('never sends the bags, which would reveal upcoming pieces', () => {
    const { conns } = fullRoom();
    const { state } = conns[0].last('state');
    for (const p of state.players) {
      assert.equal(p.bag, undefined);
      assert.equal(p.hand.length, 4);
    }
  });

  it('rejects unknown codes, full rooms and games already started', () => {
    const { rooms, code } = fullRoom();
    const eve = fakeConn();
    rooms.handleMessage(eve, { type: 'join', code: 'ZZZZ', nickname: 'Eve' });
    assert.equal(eve.last('error').error, 'roomNotFound');
    rooms.handleMessage(eve, { type: 'join', code, nickname: 'Eve' });
    assert.equal(eve.last('error').error, 'gameStarted');
  });

  it('cleans nicknames', () => {
    assert.equal(cleanNickname('  Ann\u0007  '), 'Ann');
    assert.equal(cleanNickname('A'.repeat(40)).length, 16);
    assert.equal(cleanNickname(''), 'Player');
    assert.equal(cleanNickname(undefined), 'Player');
  });
});

describe('rooms: playing', () => {
  it('applies a legal move from the active player and broadcasts it to everyone', () => {
    const { env, rooms, conns, room } = fullRoom();
    env.advance(2_000); // the pause before the first turn
    const seat = room.state.activeSeat;
    const move = firstLegalMove(room.state, seat);
    rooms.handleMessage(conns[seat], { type: 'move', move });
    for (const conn of conns) {
      const msg = conn.last('state');
      assert.ok(msg.events.some((e) => e.type === 'placed' && e.seat === seat));
    }
    assert.notEqual(room.state.activeSeat, seat);
  });

  it('rejects a move from a player whose turn it is not, telling only them', () => {
    const { env, rooms, conns, room } = fullRoom();
    env.advance(2_000);
    const other = (room.state.activeSeat + 1) % 4;
    const before = conns.map((c) => c.sent.length);
    rooms.handleMessage(conns[other], { type: 'move', move: { handIndex: 0, rotation: 0, x: 5, y: 5 } });
    assert.equal(conns[other].last('error').error, 'notYourTurn');
    conns.forEach((c, seat) => {
      if (seat !== other) assert.equal(c.sent.length, before[seat]);
    });
  });

  it('runs deadlines on the server: an idle player is AFK-passed after 10 s', () => {
    const { env, conns, room } = fullRoom();
    const seat = room.state.activeSeat;
    env.advance(2_000 + 10_000); // the pause, then the AFK timer
    const msg = conns[0].last('state');
    assert.ok(msg.events.some((e) => e.type === 'passed' && e.reason === 'afk' && e.seat === seat));
  });

  it('rejects moves before the game has started', () => {
    const { rooms } = setup();
    const ann = fakeConn();
    rooms.handleMessage(ann, { type: 'create', nickname: 'Ann' });
    rooms.handleMessage(ann, { type: 'move', move: {} });
    assert.equal(ann.last('error').error, 'notStarted');
  });
});

describe('rooms: reconnecting', () => {
  it('shows a disconnected player as offline and lets them reclaim their seat with the token', () => {
    const { rooms, conns, code } = fullRoom();
    const token = conns[1].last('joined').token;
    rooms.handleDisconnect(conns[1]);
    assert.equal(conns[0].last('state').seats[1].connected, false);

    const again = fakeConn();
    rooms.handleMessage(again, { type: 'resume', code, token });
    assert.equal(again.last('joined').seat, WEST);
    assert.equal(again.last('state').you, WEST);
    assert.equal(conns[0].last('state').seats[1].connected, true);
  });

  it('rejects an unknown token', () => {
    const { rooms, code } = fullRoom();
    const eve = fakeConn();
    rooms.handleMessage(eve, { type: 'resume', code, token: 'nope' });
    assert.equal(eve.last('error').error, 'sessionExpired');
  });

  it('moves the seat to a new tab and tells the old one it was replaced', () => {
    const { rooms, conns, code } = fullRoom();
    const token = conns[2].last('joined').token;
    const tab = fakeConn();
    rooms.handleMessage(tab, { type: 'resume', code, token });
    assert.ok(conns[2].last('replaced'));
    assert.equal(conns[2].closed, true);
    assert.equal(conns[2].session, null);
    assert.equal(tab.last('joined').seat, NORTH);
  });

  it('holds a lobby seat for the grace period, then frees it', () => {
    const { env, rooms } = setup();
    const ann = fakeConn();
    const bob = fakeConn();
    rooms.handleMessage(ann, { type: 'create', nickname: 'Ann' });
    const code = ann.last('joined').code;
    rooms.handleMessage(bob, { type: 'join', code, nickname: 'Bob' });
    rooms.handleDisconnect(bob);
    assert.deepEqual(ann.last('lobby').seats[1], { nickname: 'Bob', bot: false, connected: false });
    env.advance(20_000);
    assert.equal(ann.last('lobby').seats[1], null);
  });

  it('lets a lobby player who refreshes within the grace period keep their seat', () => {
    const { env, rooms } = setup();
    const ann = fakeConn();
    const bob = fakeConn();
    rooms.handleMessage(ann, { type: 'create', nickname: 'Ann' });
    const code = ann.last('joined').code;
    rooms.handleMessage(bob, { type: 'join', code, nickname: 'Bob' });
    const token = bob.last('joined').token;
    rooms.handleDisconnect(bob);
    env.advance(5_000);
    const bobAgain = fakeConn();
    rooms.handleMessage(bobAgain, { type: 'resume', code, token });
    env.advance(30_000);
    assert.deepEqual(ann.last('lobby').seats[1], { nickname: 'Bob', bot: false, connected: true });
  });
});

describe('rooms: leaving and cleanup', () => {
  it('frees a lobby seat when its player leaves', () => {
    const { rooms } = setup();
    const ann = fakeConn();
    const bob = fakeConn();
    rooms.handleMessage(ann, { type: 'create', nickname: 'Ann' });
    const code = ann.last('joined').code;
    rooms.handleMessage(bob, { type: 'join', code, nickname: 'Bob' });
    rooms.handleMessage(bob, { type: 'leave' });
    assert.ok(bob.last('left'));
    assert.equal(ann.last('lobby').seats[1], null);
  });

  it('removes a lobby as soon as everyone has left', () => {
    const { rooms } = setup();
    const ann = fakeConn();
    rooms.handleMessage(ann, { type: 'create', nickname: 'Ann' });
    rooms.handleMessage(ann, { type: 'leave' });
    assert.equal(rooms.rooms.size, 0);
  });

  it('keeps a started game for a while after everyone disconnects, then removes it', () => {
    const { env, rooms, conns } = fullRoom();
    for (const conn of conns) rooms.handleDisconnect(conn);
    assert.equal(rooms.rooms.size, 1);
    env.advance(60_000);
    assert.equal(rooms.rooms.size, 0);
  });
});

describe('rooms: bots', () => {
  function hostRoom() {
    const { env, rooms } = setup();
    const ann = fakeConn();
    rooms.handleMessage(ann, { type: 'create', nickname: 'Ann' });
    const code = ann.last('joined').code;
    return { env, rooms, ann, code, room: rooms.rooms.get(code) };
  }

  it('lets the host add easy bots, shown as bots in the lobby', () => {
    const { rooms, ann } = hostRoom();
    rooms.handleMessage(ann, { type: 'addBot' });
    const lobby = ann.last('lobby');
    assert.equal(lobby.host, SOUTH);
    assert.deepEqual(lobby.seats[1], { nickname: 'Easy bot 1', bot: true, connected: true });
  });

  it('refuses bot changes from anyone but the host', () => {
    const { rooms, code } = hostRoom();
    const bob = fakeConn();
    rooms.handleMessage(bob, { type: 'join', code, nickname: 'Bob' });
    rooms.handleMessage(bob, { type: 'addBot' });
    assert.equal(bob.last('error').error, 'notHost');
  });

  it('lets the host remove a bot, freeing its seat', () => {
    const { rooms, ann } = hostRoom();
    rooms.handleMessage(ann, { type: 'addBot' });
    rooms.handleMessage(ann, { type: 'removeBot', seat: 1 });
    assert.equal(ann.last('lobby').seats[1], null);
    rooms.handleMessage(ann, { type: 'removeBot', seat: 0 });
    assert.equal(ann.last('error').error, 'notABot');
  });

  it('starts the game once bots fill the room', () => {
    const { rooms, ann } = hostRoom();
    for (let k = 0; k < 3; k++) rooms.handleMessage(ann, { type: 'addBot' });
    const msg = ann.last('state');
    assert.ok(msg);
    assert.deepEqual(msg.seats.map((s) => s.bot), [false, true, true, true]);
    rooms.handleMessage(ann, { type: 'addBot' });
    assert.equal(ann.last('error').error, 'gameStarted');
  });

  it('plays bot turns on the server, within the AFK timer', () => {
    const { env, rooms, ann, room } = hostRoom();
    for (let k = 0; k < 3; k++) rooms.handleMessage(ann, { type: 'addBot' });
    // Let the game run for a while: bots move on their own; Ann is AFK-passed.
    env.advance(60_000);
    const placed = ann.all('state').flatMap((m) => m.events).filter((e) => e.type === 'placed');
    const botSeats = new Set(placed.map((e) => e.seat));
    assert.ok([1, 2, 3].every((seat) => botSeats.has(seat)), `bots that moved: ${[...botSeats]}`);
    const afk = ann.all('state').flatMap((m) => m.events).filter((e) => e.type === 'passed' && e.reason === 'afk');
    assert.ok(afk.every((e) => e.seat === SOUTH), 'a bot was AFK-passed');
    assert.equal(room.state.players[SOUTH].status === 'alive' || room.state.over, true);
  });

  it('removes a lobby whose only human leaves, even with bots seated', () => {
    const { rooms, ann } = hostRoom();
    rooms.handleMessage(ann, { type: 'addBot' });
    rooms.handleMessage(ann, { type: 'leave' });
    assert.equal(rooms.rooms.size, 0);
  });

  it('passes hosting to the next human when the host leaves the lobby', () => {
    const { rooms, ann, code } = hostRoom();
    const bob = fakeConn();
    rooms.handleMessage(ann, { type: 'addBot' });
    rooms.handleMessage(bob, { type: 'join', code, nickname: 'Bob' });
    rooms.handleMessage(ann, { type: 'leave' });
    assert.equal(bob.last('lobby').host, 2);
    rooms.handleMessage(bob, { type: 'addBot' });
    assert.equal(bob.last('lobby').seats.filter((s) => s && s.bot).length, 2);
  });
});

describe('rooms: game mode', () => {
  function hostRoom() {
    const { env, rooms } = setup();
    const ann = fakeConn();
    rooms.handleMessage(ann, { type: 'create', nickname: 'Ann' });
    const code = ann.last('joined').code;
    return { env, rooms, ann, code, room: rooms.rooms.get(code) };
  }

  it('is turn-based unless the host picks real-time in the lobby', () => {
    const { rooms, ann } = hostRoom();
    assert.equal(ann.last('lobby').mode, 'turns');
    rooms.handleMessage(ann, { type: 'setMode', mode: 'realtime' });
    assert.equal(ann.last('lobby').mode, 'realtime');
    rooms.handleMessage(ann, { type: 'setMode', mode: 'chess' });
    assert.equal(ann.last('error').error, 'badMode');
  });

  it('only lets the host change the mode', () => {
    const { rooms, code } = hostRoom();
    const bob = fakeConn();
    rooms.handleMessage(bob, { type: 'join', code, nickname: 'Bob' });
    rooms.handleMessage(bob, { type: 'setMode', mode: 'realtime' });
    assert.equal(bob.last('error').error, 'notHost');
  });

  it('starts a real-time game when the host chose real-time', () => {
    const { rooms, ann } = hostRoom();
    rooms.handleMessage(ann, { type: 'setMode', mode: 'realtime' });
    for (let k = 0; k < 3; k++) rooms.handleMessage(ann, { type: 'addBot' });
    const { state } = ann.last('state');
    assert.equal(state.config.mode, 'realtime');
    assert.equal(state.phase, 'realtime');
  });

  it('lets bots play a real-time game at their own pace, respecting cooldowns', () => {
    const { env, rooms, ann } = hostRoom();
    rooms.handleMessage(ann, { type: 'setMode', mode: 'realtime' });
    for (let k = 0; k < 3; k++) rooms.handleMessage(ann, { type: 'addBot' });
    env.advance(30_000);
    const placed = ann.all('state').flatMap((m) => m.events).filter((e) => e.type === 'placed');
    for (const seat of [1, 2, 3]) {
      const moves = placed.filter((e) => e.seat === seat);
      // At most one piece per 3 s cooldown + 1.5 s think, with line clears allowing more.
      assert.ok(moves.length >= 3, `bot ${seat} placed only ${moves.length} pieces`);
      assert.ok(moves.length <= 30, `bot ${seat} placed ${moves.length} pieces`);
    }
  });
});

describe('rooms: pause', () => {
  it('lets any player pause the game for everyone', () => {
    const { env, rooms, conns } = fullRoom();
    env.advance(2_000);
    rooms.handleMessage(conns[2], { type: 'pause' });
    for (const conn of conns) {
      const msg = conn.last('state');
      assert.equal(msg.state.pausedBy, 2);
      assert.ok(msg.events.some((e) => e.type === 'paused' && e.seat === 2));
    }
  });

  it('lets only the player who paused, or the host, resume', () => {
    const { env, rooms, conns, room } = fullRoom();
    env.advance(2_000);
    rooms.handleMessage(conns[2], { type: 'pause' });
    rooms.handleMessage(conns[1], { type: 'unpause' });
    assert.equal(conns[1].last('error').error, 'notAllowedToResume');
    assert.notEqual(room.state.pausedAt, null);
    rooms.handleMessage(conns[0], { type: 'unpause' }); // Ann is the host
    assert.equal(room.state.pausedAt, null);

    rooms.handleMessage(conns[3], { type: 'pause' });
    rooms.handleMessage(conns[3], { type: 'unpause' }); // the pauser themselves
    assert.equal(room.state.pausedAt, null);
  });

  it('stops all deadlines while paused, then carries on', () => {
    const { env, rooms, conns, room } = fullRoom();
    env.advance(2_000); // first turn starts
    const seat = room.state.activeSeat;
    rooms.handleMessage(conns[0], { type: 'pause' });
    env.advance(60_000);
    const passes = () => conns[0].all('state').flatMap((m) => m.events).filter((e) => e.type === 'passed');
    assert.equal(passes().length, 0);
    rooms.handleMessage(conns[0], { type: 'unpause' });
    env.advance(10_000);
    assert.deepEqual(passes().map((e) => e.seat), [seat]);
  });

  it('keeps bots waiting while paused', () => {
    const { env, rooms } = setup();
    const ann = fakeConn();
    rooms.handleMessage(ann, { type: 'create', nickname: 'Ann' });
    rooms.handleMessage(ann, { type: 'setMode', mode: 'realtime' });
    for (let k = 0; k < 3; k++) rooms.handleMessage(ann, { type: 'addBot' });
    rooms.handleMessage(ann, { type: 'pause' });
    const before = ann.sent.length;
    env.advance(30_000);
    assert.equal(ann.sent.length, before);
  });
});

describe('rooms: move history', () => {
  it('records the start and every placement, and sends it to a player who reconnects', () => {
    const { env, rooms, conns, code, room } = fullRoom();
    env.advance(2_000);
    const seat = room.state.activeSeat;
    rooms.handleMessage(conns[seat], { type: 'move', move: firstLegalMove(room.state, seat) });
    assert.equal(room.history.length, 2);
    assert.equal(room.history[0].seat, null); // the starting board
    assert.equal(room.history[1].seat, seat);
    assert.deepEqual(room.history[1].owner, room.state.owner);

    const token = conns[1].last('joined').token;
    const again = fakeConn();
    rooms.handleMessage(again, { type: 'resume', code, token });
    assert.deepEqual(again.last('history').entries, room.history);
  });
});

describe('publicState', () => {
  it('drops only the bags', () => {
    const state = { owner: [], players: [{ seat: 0, hand: ['I'], bag: { rng: { s: 1 }, queue: ['O'] } }] };
    assert.deepEqual(publicState(state), { owner: [], players: [{ seat: 0, hand: ['I'] }] });
  });
});
