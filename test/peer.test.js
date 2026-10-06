'use strict';

// Peer-to-peer online play: the host's browser runs a RoomManager and every
// player reaches it through channelConn. Here the PeerJS channels are replaced
// by in-memory ones that pass the same JSON text.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { RoomManager, channelConn } = require('../server/rooms');

function fakeEnv() {
  let t = 1_000_000;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => t,
    setTimer(fn, ms) {
      timers.set(nextId, { at: t + ms, fn });
      return nextId++;
    },
    clearTimer: (id) => timers.delete(id),
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
}

// A player on the far end of a text channel: records what the room sends.
function player(manager) {
  const inbox = [];
  const channel = { send: (text) => inbox.push(JSON.parse(text)), close() {} };
  const end = channelConn(manager, channel);
  return {
    inbox,
    end,
    send: (message) => end.receive(JSON.stringify(message)),
    last: (type) => inbox.filter((m) => m.type === type).pop(),
  };
}

describe('peer-to-peer channels', () => {
  it('plays a two-player game to the end through text channels', () => {
    const env = fakeEnv();
    const manager = new RoomManager(env);
    const room = manager.createRoom();
    const hostP = player(manager);
    const guest = player(manager);

    hostP.send({ type: 'join', code: room.code, nickname: 'Host' });
    hostP.send({ type: 'setPlayers', count: 2 });
    guest.send({ type: 'join', code: room.code, nickname: 'Guest' });

    assert.equal(hostP.last('joined').code, room.code);
    assert.equal(guest.last('joined').code, room.code);
    assert.ok(guest.last('state'), 'the guest receives the game state');

    // Nobody moves: clocks run out until the game ends (capped).
    for (let i = 0; i < 2000 && !room.state.over; i++) env.advance(1_000);
    assert.equal(room.state.over, true);
    assert.equal(guest.last('state').state.over, true);
    manager.closeAll();
  });

  it('lets a guest who dropped resume their seat', () => {
    const manager = new RoomManager(fakeEnv());
    const room = manager.createRoom();
    const guest = player(manager);
    guest.send({ type: 'join', code: room.code, nickname: 'Guest' });
    const { token, seat } = guest.last('joined');
    guest.end.closed();

    const again = player(manager);
    again.send({ type: 'resume', code: room.code, token });
    assert.equal(again.last('joined').seat, seat);
    manager.closeAll();
  });

  it('rejects bad and oversized messages', () => {
    const manager = new RoomManager(fakeEnv());
    const p = player(manager);
    p.end.receive('not json');
    p.end.receive(JSON.stringify({ type: 'join', nickname: 'x'.repeat(5000) }));
    p.end.receive(JSON.stringify([1, 2]));
    assert.deepEqual(
      p.inbox.map((m) => m.error),
      ['badMessage', 'badMessage', 'badMessage'],
    );
  });
});
