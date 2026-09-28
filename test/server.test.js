'use strict';

// End-to-end: a real HTTP + WebSocket server on a random port, real sockets.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { createServer } = require('../server/app');

let app;
let base;

before(async () => {
  app = createServer({ log: { error() {} } });
  const { port } = await app.listen(0, '127.0.0.1');
  base = `127.0.0.1:${port}`;
});

after(() => app.close());

// Opens a socket and returns helpers to send messages and await replies.
function client() {
  const socket = new WebSocket(`ws://${base}/ws`);
  const inbox = [];
  const waiters = [];
  socket.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    const k = waiters.findIndex((w) => w.type === msg.type);
    if (k >= 0) waiters.splice(k, 1)[0].resolve(msg);
    else inbox.push(msg);
  });
  const opened = new Promise((resolve) => socket.once('open', resolve));
  return {
    async send(msg) {
      await opened;
      socket.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
    },
    next(type) {
      const k = inbox.findIndex((m) => m.type === type);
      if (k >= 0) return Promise.resolve(inbox.splice(k, 1)[0]);
      return new Promise((resolve) => waiters.push({ type, resolve }));
    },
    close() {
      socket.close();
    },
  };
}

describe('server', () => {
  it('serves the client page and its scripts', async () => {
    const page = await fetch(`http://${base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(await page.text(), /<title>Tetris<\/title>/);
    const script = await fetch(`http://${base}/app.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type'), /javascript/);
  });

  it('refuses paths outside the client folder and unknown files', async () => {
    assert.equal((await fetch(`http://${base}/..%2Fpackage.json`)).status, 404);
    assert.equal((await fetch(`http://${base}/nope.html`)).status, 404);
  });

  it('plays a room end to end: four sockets join, the game starts, a move is broadcast', async () => {
    const players = [client(), client(), client(), client()];
    await players[0].send({ type: 'create', nickname: 'Ann' });
    const { code } = await players[0].next('joined');
    for (const [k, nickname] of ['Bob', 'Cat', 'Dan'].entries()) {
      await players[k + 1].send({ type: 'join', code, nickname });
      await players[k + 1].next('joined');
    }
    const starts = await Promise.all(players.map((p) => p.next('state')));
    starts.forEach((msg, seat) => assert.equal(msg.you, seat));
    const { state } = starts[0];

    // The active player places a piece; everyone receives the move.
    const seat = state.activeSeat;
    const { pieceCells, isLegalPlacement } = require('../src/core/board');
    let move = null;
    const hand = state.players[seat].hand;
    for (let h = 0; h < 4 && !move; h++)
      for (let r = 0; r < 4 && !move; r++)
        for (let y = 0; y < 11 && !move; y++)
          for (let x = 0; x < 11 && !move; x++)
            if (isLegalPlacement(state.owner, seat, pieceCells(hand[h], r, x, y))) move = { handIndex: h, rotation: r, x, y };
    await players[seat].send({ type: 'move', move });
    const after = await Promise.all(players.map((p) => p.next('state')));
    for (const msg of after) assert.ok(msg.events.some((e) => e.type === 'placed' && e.seat === seat));

    players.forEach((p) => p.close());
  });

  it('answers malformed messages with an error instead of crashing', async () => {
    const eve = client();
    await eve.send('not json');
    assert.equal((await eve.next('error')).error, 'badMessage');
    await eve.send({ type: 'fly' });
    assert.equal((await eve.next('error')).error, 'unknownMessage');
    eve.close();
  });
});
