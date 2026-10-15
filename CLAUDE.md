# TETRA

Block-placing game for 2–4 players on one 11×11 board. Rainbow pieces are always on; real-time is the default mode.

## Commands
- `npm test`: all tests (node --test)
- `npm start`: rebuilds the bundle and serves the game at http://localhost:8080 (online play works from there too)
- `npm run client`: rebuild `client/core.bundle.js` from `src/core` (generated, not in git)

## Docs
- [DESIGN.md](DESIGN.md): full game rules and protocol. Read only the section the task needs (it is long).

## Hosting
- Live: https://giovannialtamore00-create.github.io/tetris-game/ (GitHub Pages; `.github/workflows/pages.yml` tests, builds and deploys on every push to master).
- Online play is peer-to-peer (PeerJS from cdnjs), so it works on any static host; no game server needed.
- Games hub: the Platypus site (https://giovannialtamore00-create.github.io/, repo giovannialtamore00-create.github.io). Update the TETRA card when links change.

## Status
- Done: M13 rainbow-only + real-time default; M14 GitHub repo + Pages deploy, renamed to TETRA; M15 peer-to-peer online play (PeerJS; the creator's tab runs `server/rooms.js`, see DESIGN.md §13). Tested with two headless browsers; waiting on the user's two-device playtest on the live link. After M15: 2.3 s cooldown (2, 1, ✓), touch drag-and-drop with parked pieces, hidden "perfect fit" rainbow 1×1 reward (DESIGN.md §25). M16: bots fill gaps and avoid leaving them (line clears exempt); a boxed-in shuffle grants 2 rainbow pieces incl. a 1×1 or 1×2. M17: menu redesign, block wordmark logo, 5×5 mini-board icon (`client/icon.svg`, `icon-180.png`; also on the Platypus TETRA card as `tetra-logo.svg`).
- Open questions: remove the unused WebSocket server and `ws`? Add a TURN relay if some networks can't connect (STUN only now)?
- M18: menu rebuilt: Play (Free Play, Ranked, Ranked 1v1, Practice, Play with friends), Options (volume slider), Rules. All bot games are real-time; turn-based only in friends rooms; hot-seat removed. Ranked has no ranking yet (plays vs bots). Practice bot is 1.5× slower. Awaiting playtest.
- Next: upload a zip of `client/` (with the built bundle) to itch.io as an HTML game, and add the itch.io link to the Platypus TETRA card.
