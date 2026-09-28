'use strict';

// Starts the game server: rebuilds the client bundle from src/core, then
// serves the client and the multiplayer WebSocket on one port.
//   PORT (default 8080) and HOST (default 0.0.0.0) can be set in the environment.

const os = require('node:os');
const { build } = require('../scripts/build-client');
const { createServer } = require('./app');

const port = Number(process.env.PORT) || 8080;
const host = process.env.HOST || '0.0.0.0';

build({ quiet: true });

createServer()
  .listen(port, host)
  .then(() => {
    console.log(`Game server running on port ${port}.`);
    console.log(`  This computer:     http://localhost:${port}`);
    for (const addresses of Object.values(os.networkInterfaces())) {
      for (const a of addresses || []) {
        if (a.family === 'IPv4' && !a.internal) console.log(`  Your home network: http://${a.address}:${port}`);
      }
    }
    console.log('Press Ctrl+C to stop.');
  });
