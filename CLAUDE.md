# TETRA

Block-placing game for 2–4 players on one 11×11 board. Rainbow pieces are always on; real-time is the default mode.

## Commands
- `npm test`: all tests (node --test)
- `npm start`: local game server with online rooms (WebSocket, port 8080)
- `npm run client`: rebuild `client/core.bundle.js` from `src/core` (generated, not in git)

## Docs
- [DESIGN.md](DESIGN.md): full game rules and protocol. Read only the section the task needs (it is long).

## Hosting
- Live: https://giovannialtamore00-create.github.io/tetris-game/ (GitHub Pages; `.github/workflows/pages.yml` tests, builds and deploys on every push to master).
- On github.io / itch.io the online buttons are disabled ("coming soon"), see `staticHost` in `client/app.js`.
- Games hub (claude.ai artifact): https://claude.ai/artifact/4EXrfxbyTmsukjur2szCo6. Update the TETRA card when links change.

## Status
- Done: M13 rainbow-only + real-time default; M14 GitHub repo + Pages deploy, renamed to TETRA.
- Next (step 3, plan first and wait for approval): peer-to-peer online play. The room creator's browser runs the room logic (`server/rooms.js` only needs `node:crypto` + `src/core`), and guests connect with PeerJS (WebRTC, free signaling) instead of the WebSocket. Done when: two people on different devices finish a game through the GitHub Pages link.
- After that: upload a zip of `client/` (with the built bundle) to itch.io as an HTML game, and add the itch.io link to the hub card.
- Later / optional: move the games hub to GitHub Pages (links in claude.ai artifacts are blocked by ad blockers).
