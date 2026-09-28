'use strict';

// HTTP + WebSocket server. HTTP serves the browser client from client/; the
// WebSocket endpoint at /ws carries the JSON messages handled by RoomManager.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const { RoomManager } = require('./rooms');

const CLIENT_DIR = path.join(__dirname, '..', 'client');
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};
const MAX_MESSAGE_BYTES = 4096;
const HEARTBEAT_MS = 30_000;

function serveStatic(req, res, clientDir) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return;
  }
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (pathname === '/') pathname = '/index.html';
  const file = path.join(clientDir, pathname);
  const contentType = CONTENT_TYPES[path.extname(file)];
  if (!file.startsWith(clientDir + path.sep) || !contentType) {
    res.writeHead(404).end();
    return;
  }
  fs.readFile(file, (err, body) => {
    if (err) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
}

function createServer({ rooms = new RoomManager(), clientDir = CLIENT_DIR, log = console } = {}) {
  const server = http.createServer((req, res) => serveStatic(req, res, clientDir));
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_MESSAGE_BYTES });

  wss.on('connection', (socket) => {
    socket.isAlive = true;
    socket.on('pong', () => {
      socket.isAlive = true;
    });

    const conn = {
      session: null,
      send(message) {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
      },
      close() {
        socket.close();
      },
    };

    socket.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        conn.send({ type: 'error', error: 'badMessage' });
        return;
      }
      if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
        conn.send({ type: 'error', error: 'badMessage' });
        return;
      }
      try {
        rooms.handleMessage(conn, msg);
      } catch (err) {
        log.error('Error handling message', msg.type, err);
        conn.send({ type: 'error', error: 'serverError' });
      }
    });

    socket.on('close', () => rooms.handleDisconnect(conn));
    socket.on('error', () => {});
  });

  // Drop connections that stop answering pings, so their seats show as
  // disconnected instead of silently hanging.
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (!socket.isAlive) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  return {
    server,
    wss,
    rooms,
    listen(port, host) {
      return new Promise((resolve) => server.listen(port, host, () => resolve(server.address())));
    },
    close() {
      clearInterval(heartbeat);
      for (const socket of wss.clients) socket.terminate();
      rooms.closeAll();
      return new Promise((resolve) => wss.close(() => server.close(() => resolve())));
    },
  };
}

module.exports = { createServer };
