# Design

A multiplayer, turn-based Tetris variant for 4 players on one shared board. Each player grows a "tree" of blocks from their own edge of the board and tries to score by clearing lines and cutting off other players' branches.

This document is the reference for the rules and the server architecture. Part 1 defines the rules; Part 2 describes how the server implements them.

---

# Part 1 — Rules

## 1. Board

- The board is an **11×11 grid**. Row 0 is the North edge, row 10 the South edge, column 0 the West edge, column 10 the East edge.
- The **four corner cells are blocked**: they can never be occupied.
- A game has exactly **4 players**, one on each edge. Turn order is clockwise.
- A lobby fills up to 4 players and the game starts automatically once it is full. Seats are assigned in join order, starting with South and going clockwise; the first player to move is chosen by the seeded RNG.
- A player's **edge line** is the row or column along their edge, excluding the corners (9 cells).
- There is **no gravity**. Blocks never move once placed; they are only ever hit, destroyed, or change owner.

## 2. Blocks

Every occupied cell is a block with two independent properties:

- **Owner**: a player, or **grey** (owned by no one).
- **HP**: 1, 2 or 3.

HP belongs to the block, not to its colour: when a block changes owner it keeps its HP. Blocks are shaded by HP (darkest = 3).

A block owned by a player who has **timed out** (§9) is **dulled**: drawn as a hollow, dulled version of that player's colour. Dulled blocks are otherwise ordinary owned blocks.

### Starting position

Each player starts with a root pyramid centred on their edge. For the South player:

| Row | Columns | HP |
|---|---|---|
| 10 (edge) | 3–7 | 3 |
| 9 | 4–6 | 2 |
| 8 | 5 | 1 |

The other edges use the same shape rotated to face inward. These nine **starting pieces** are the player's only roots (§6).

## 3. Hands and pieces

- There are **10 pieces**: the 7 standard tetrominoes plus three small **special pieces**, a 1×1 single block, a 1×2 domino and a 3-cell small L. Every piece has 4 rotations (rotations that look identical still count as separate rotations).
- *Rationale:* with no gravity, holes of 1–3 cells appear that no tetromino can fill; the small pieces fill them.
- The piece list lives in one config file (`src/core/pieceSet.js`), which also marks which pieces are special.
- Each player has a **hand of 4 pieces**, dealt from their own shuffled **bag** holding each of the 7 tetrominoes once per cycle (all 7 in random order, then reshuffled). This prevents long droughts of any one piece.
- **Special pieces are never dealt from the bag**, so starting hands and normal refills only ever contain tetrominoes. The only ways to get a special piece are a shuffle and a line-clear reward (below).
- All hands are visible to all players.
- After a player places a piece, the slot they played from is refilled from the bag, except after a line clear (below).
- **Special piece picks** are made at random from the three special pieces, using the player's seeded random generator, **outside the bag**: they never remove a piece from the bag, so the bag cycle is unaffected. A player receives one:
  - when they **shuffle** their hand (§8): the new hand is 3 pieces from the bag plus 1 special piece; and
  - as a **reward for completing a line**: a move that completes at least one line refills the played slot with a special piece instead of a bag draw (one reward per move, however many lines it completes).
- Special pieces follow every other rule, like any other piece.

## 4. Placing a piece

On their turn, a player picks a piece from their hand, chooses a rotation, and places it. The placement is legal only if:

1. every cell of the piece is on the board, not a corner, and empty; and
2. at least one cell of the piece is orthogonally adjacent to a block the player already owns.

Placing on your own edge is **not** automatically legal: rule 2 still applies. New blocks are placed with **1 HP**.

Players may pick up, hover and rotate pieces during other players' turns. This is purely client-side; nothing is sent to the server until the player submits a move on their own turn.

## 5. Line clears

- Only the **9 interior rows and 9 interior columns** can clear. Edge lines always contain two blocked corners, so they can never be full.
- Every interior line still spans the full 11 cells, edge to edge, so it includes one cell from each of the two edges it crosses. Edge blocks, including roots, are therefore **not immune**: they are hit whenever a line running across their edge clears (for example, clearing column 3 hits cells (0,3) and (10,3)). They can never be hit by their own edge line, because that line can never clear.
- A line clears when it is full **and the current move placed at least one block in it**. A line that survives a clear stays full, but does not clear again until one of its cells is emptied and then refilled.
- Every block in a clearing line takes **1 hit**, whatever its HP. A block where a clearing row and a clearing column cross takes **2 hits**.
- A hit reduces HP by 1. A block at 0 HP is **destroyed** and its cell becomes empty.

## 6. Connectivity, orphans and grey clusters

### Anchoring

A player's **roots** are their surviving **starting pieces**: the pyramid blocks they were given at the start of the game. A block is **anchored** if it is a root, or is connected to one of its owner's roots through an orthogonal chain of blocks with the same owner.

- A block placed later is **never** a root, even on the player's own edge. It must connect through the player's own blocks to a surviving starting piece.
- Once a starting piece is destroyed it is gone. A block placed in that cell later is an ordinary block, not a root.
- A timed-out player's dulled starting pieces stay roots, so their dulled structure stays in place for as long as it remains connected to them.

### Orphans

After a move's line clears, any owned block that is no longer anchored is **orphaned**. Ownership is severed the instant a block is orphaned: from then on it belongs to no one, exactly like a grey block, and it keeps its HP.

### Cluster resolution

All ownerless cells — newly orphaned blocks from every player, plus grey blocks already on the board — are grouped into **clusters** of orthogonally connected cells. A fresh orphan that touches an existing grey cluster merges with it before anything is counted.

For each cluster, count its **touching colours**: the distinct players (living *or* timed out) that own an anchored block orthogonally adjacent to any cell of the cluster. Grey cells and other orphans never count as a colour.

| Touching colours | Outcome |
|---|---|
| 0 | The whole cluster **detonates**: every cell is destroyed, whatever its HP. |
| exactly 1 | The whole cluster **converts** to that player and keeps its HP. If that player has timed out, the blocks become dulled. |
| 2 or more | The whole cluster **becomes or stays grey**. |

All clusters are decided simultaneously from the same board snapshot.

Grey is never permanent. **Every grey cluster on the board is re-evaluated after every move**, because a move anywhere on the board can remove one of the colours touching it. As a result, after every move:

- every block owned by a player is anchored; and
- every grey cluster touches at least 2 colours.

A timeout changes nothing on the board, so it never changes a cluster's touching colours and triggers no re-evaluation.

## 7. Scoring

All points go to the player who made the move, except conversion points, which go to the adopting player.

| Event | Scores | Points per block |
|---|---|---|
| A line hit destroys a block the mover owns at that instant | mover | **2** |
| A line hit destroys any other block (another player's, dulled, or grey) | mover | 1 |
| A cluster detonates (0 touching colours) | mover | 1, whoever the blocks used to belong to |
| A cluster converts (exactly 1 touching colour) | the adopting player, if alive | 1 |
| A round ends | every living player | +1 each |

- Points are awarded only when a block is destroyed or converted. A hit that only lowers HP scores nothing.
- There is no self-detonation bonus: once a cluster is orphaned it belongs to no one, so detonating your own former branch scores the normal 1 per block.
- **A player who is not alive never gains points** from any source; their score is frozen at the moment they are eliminated or time out. It still counts for the final ranking.

## 8. Turns and passes

**Pause between turns.** Every turn, including the first turn of the game and the first turn after a shuffle window, starts **2 s** after the previous turn ended, so players can see what just happened. During the pause no personal clock runs and the AFK timer has not started; the 10-minute game clock keeps running. Nobody can move during the pause, but shuffling is still allowed (§8, shuffle offer).

On each turn, the active player does one of the following:

- **Makes a move.** Their clock is charged the time taken, then they receive +2 s, plus **+2 s for every line the move completes** (a row and a column completed together earn +4 s). Like every bonus, this never pushes the clock above its cap.
- **Is force-passed.** If, at the start of their turn, no piece in their hand has any legal placement in any rotation, they are passed **immediately**. No time is charged, they receive **+5 s**, and they are granted a **shuffle offer**.
- **Is AFK-passed.** If they make no move within **10 s** of their turn starting, they are passed. The 10 s is charged to their clock and they receive **no bonus**. Their hand does not change.

### Shuffle offer

- A shuffle offer lets the player replace their whole hand, **once**, with 3 pieces drawn from their bag plus 1 special piece (§3).
- It can be used at any time: during their own turn or anyone else's.
- An unused offer stays available across any number of turns and passes. It disappears when the player makes a legal move, or when it is used.
- If a player's hand is still stuck after shuffling, their next forced pass grants a fresh offer. Offers do not stack.
- If a player shuffles during their own live turn and the new hand has no legal placement, they are force-passed immediately.

## 9. Clocks

| Clock | Length | Runs | When it runs out |
|---|---|---|---|
| Game clock | 10 minutes, shared, shown above the board | always, never paused | the game ends |
| Personal clock | 60 s start, 60 s cap | only during your own live turn | you **time out** |
| AFK timer | 10 s | only during your own live turn | you are AFK-passed |

- **Bonuses never push a clock above its cap**: `remaining = max(remaining, min(remaining + bonus, cap))`.
- **Cap decay:** at the end of every round, every living player's cap drops by 1 s (never below 0). Remaining time is not reduced: 15/60 becomes 15/59, and 60/60 becomes 60/59.
- A turn can cost at most 10 s, so a player times out only after their remaining time has fallen below 10 s and they are slow once more.
- If deadlines coincide, the game clock takes precedence, then the personal clock, then the AFK timer.

### Timing out

A player whose personal clock runs out is eliminated with status **timed out**. Their blocks are not removed, greyed or reassigned: they stay on the board as dulled blocks, still anchored to their starting pieces, still able to be hit and destroyed, and still counting as a touching colour. If a later move cuts part of a dulled region off, that part is orphaned and resolved like any other cluster.

## 10. Rounds

- A round ends once every living player has taken a turn (a move, an AFK pass or a forced pass) since the round began.
- At the end of every round, every living player gets **+1 point** and their clock cap drops by **1 s**. This happens even if nobody moved during the round.
- No passive point is awarded for a round cut short by the end of the game.

### Shuffle window

If every living player was force-passed in the same round, the next round does not start immediately. Instead there is a **shuffle window** of up to **10 s**, which closes early once every stuck player has used their shuffle offer. Personal clocks do not run during the window; the game clock does.

*Rationale:* forced passes take no time, so without this pause a table where everyone is stuck would loop through rounds instantly, handing out passive points and decaying caps without limit, and real time would never advance for the game clock to end it.

## 11. Elimination

- A living player who owns zero blocks at the end of a move is **eliminated**. This can happen to the mover, including through their own misplay.
- A player whose personal clock runs out is **timed out** (§9).
- Players who are not alive take no further turns, their shuffle offer is removed, and their score is frozen.

## 12. End of game and winner

The game ends when **either**:

- at most 1 player is still alive; or
- the 10-minute game clock runs out.

The player with the **most points** wins, including players who are no longer alive. Ties are broken among the tied players, each step narrowing the group before the next:

1. A living player beats a player who is not alive (eliminated and timed-out players rank equally here).
2. The player who owns the most blocks on the board wins. For living players this is their blocks; for players who are not alive it is their dulled blocks (an eliminated player has none).
3. Any players still tied draw.

---

# Part 2 — Architecture

## 13. Layers

| Layer | Responsibility |
|---|---|
| **Game core** | All rules. Pure and deterministic: no I/O, no timers, never reads the system clock. The current time `now` is always passed in. |
| **Room layer** | One game per room: the lobby (waits until 4 players have joined, then starts the game), seats, player connections, reconnection tokens, and a single wake-up timer. |
| **Transport** | WebSockets. itch.io only serves static files, so the Node server is hosted separately and must be reachable over `wss://`. |

The server is authoritative. Clients send intents; the server validates, applies and broadcasts.

### Rooms and lobby (`server/rooms.js`)

- **Private rooms.** A player enters a nickname (up to 16 characters) and creates a room, which gets a 4-character code (letters and digits, without the look-alikes 0/O and 1/I). Others join with the code or an invite link (`/?room=CODE`).
- **Seats** are taken in join order: South, West, North, East. The game starts automatically when the fourth player joins; no one can join after that.
- **Reconnect token.** Joining hands out a secret token, kept in the browser. After a refresh or a dropped connection, the client resumes its seat with the token. Opening the same seat in a second tab moves it there and tells the first tab.
- **Disconnects.** In the lobby, a disconnected player's seat is held for 20 s, then freed. In a game the seat is held for good: the player shows as offline, and their clocks keep running as normal (§9).
- **Leaving.** Leaving from the lobby frees the seat. Leaving a game keeps the seat, and its clock keeps running.
- **Cleanup.** A lobby is removed as soon as it has no players. A game with nobody connected is removed after 10 minutes.
- The room layer runs each room's one deadline timer (§17) and applies expired deadlines before every action.

## 14. State

| Part | Fields |
|---|---|
| Board | `owner[121]`: `EMPTY`, `BLOCKED`, `GREY` or a player id. `hp[121]`: 0–3. `root[121]`: true for a surviving starting piece. |
| Player | `seat`, `status` (`alive` / `eliminated` / `timedOut`), `score`, `hand[4]`, `bag` (seeded RNG state), `remainingMs`, `capMs`, `shuffleAvailable` |
| Turn | `activeSeat`, `turnStartedAt`, `turnsTakenThisRound`, `forcedPassesThisRound` |
| Game | `endsAt`, `shuffleWindowEndsAt`, `over`, `result` |

- Blocks never move, so a cell *is* its block; no block ids are needed.
- Owner and HP live in separate arrays. Ownership changes write only `owner`; hits write only `hp`; only destruction clears both. This is what makes HP persist through ownership changes.
- "Dulled" is not stored per cell: a cell is dulled when its owner's status is `timedOut`.
- `root` is set only by the starting pyramid and cleared when that piece is destroyed; nothing else ever sets it. A root is always anchored, so it is never orphaned and never changes owner.
- All randomness comes from seeded generators stored in the state, so any game can be replayed exactly from its seed and move list.

## 15. Resolving a move

`applyMove(state, seat, move, now)` runs these steps in order:

1. **Validate**: the game is not over, it is this seat's live turn, and the placement is legal (§4).
2. **Charge time** to the mover's clock.
3. **Place** the piece at 1 HP.
4. **Line hits**: find completed lines (§5) and apply 1 hit per completed line containing each cell.
5. **Destructions**: empty cells at 0 HP and clear their `root` flag; score 2 per mover-owned block, 1 per other block.
6. **Anchoring**: breadth-first search from each player's surviving starting pieces through their own blocks.
7. **Cluster resolution**: mark unanchored owned cells as ownerless, flood-fill all ownerless and grey cells into clusters, count touching colours, and apply detonate / convert / grey to all clusters at once. Score as in §7.
8. **Eliminations**: living players with zero blocks become `eliminated`.
9. **Mover bookkeeping**: refill the played slot (from the bag, or with a special piece if step 4 completed a line), +1 s bonus plus 2 s per completed line, clear `shuffleAvailable`, record the turn in `turnsTakenThisRound`.
10. **Game over?** If at most 1 player is alive, end the game.
11. **Round end?** If every living player has taken a turn, award passive points and decay caps; open a shuffle window if every living player was force-passed.
12. **Advance** to the next living seat clockwise and start their turn (§16).

Step 7 needs only one pass. Clusters never touch each other (touching cells would be one cluster), detonation only empties cells that anchor no one, and a converted cluster is anchored the moment it converts because it touches its new owner's anchored blocks. Nothing in steps 6–7 can complete a line or cut off another block.

`applyMove` returns the new state plus an ordered list of events (`placed`, `hit`, `destroyed`, `detonated`, `converted`, `greyed`, `scored`, `rewardPiece`, `lineClearBonus`, `eliminated`, `roundEnded`, `turnStarted`, `passed`, `timedOut`, `shuffled`, `gameOver`) that clients use to animate the result.

## 16. Turn loop

When a turn ends, the next one is queued: the game enters the `interlude` phase for `turnDelayMs` (2 s), with `activeSeat` already set to the next player and `interludeEndsAt` set. When the pause ends, `tick` starts the turn. With `turnDelayMs` set to 0 the turn starts at once (most tests use this).

`startTurn` runs whenever a turn begins:

1. Enumerate every legal placement of the player's hand (at most 4 pieces × 4 rotations × 121 positions). If there are none, force-pass them (§8) and advance.
2. Otherwise the turn is live: set `turnStartedAt = now`. The turn now has an AFK deadline (`turnStartedAt + 10 s`) and a personal clock deadline (`turnStartedAt + remainingMs`).

`shuffle(state, seat, now)` may be called at any time by a player with `shuffleAvailable`. It draws a new hand (3 from the bag, then 1 special piece in the last slot), clears the offer, and, if called during that player's own live turn and the new hand is stuck, force-passes them.

## 17. Time handling

The core exposes two functions:

- `nextDeadline(state)` returns the earliest pending deadline: game end, the active player's personal clock, their AFK deadline, the end of a shuffle window, or the end of the pause before a turn.
- `tick(state, now)` applies everything that has expired, in precedence order: game end, then personal clock, then AFK, then shuffle window, then the pause.

The room layer keeps **one** `setTimeout` set to `nextDeadline(state)` and resets it after every state change. It also calls `tick(state, now)` before handling any incoming message, so a timer that fires late can never let a stale move through. Node processes one event at a time, so there are no races between moves and timers.

## 18. Client sync

- One public state is broadcast to every client after each change, together with the events that produced it. At this size, full snapshots are cheaper than diffs.
- The public state is the full game state **minus each player's bag**, whose queue and random-generator state would reveal upcoming pieces. Hands stay visible (§3).
- Each state message carries the server's current time. Clients work out the offset between their clock and the server's, then count down locally (game clock, each player's `remaining/cap`, the active player's AFK bar, any shuffle window) and resynchronise on every update.
- Client → server messages: `create { nickname }`, `join { code, nickname }`, `resume { code, token }`, `leave`, `move { handIndex, rotation, x, y }`, `shuffle`.
- Server → client messages: `joined { code, seat, token }`, `lobby { code, you, seats }`, `state { code, you, seats, state, events, serverNow }`, `error { error }`, `replaced`, `left`. `seats` lists each seat's nickname and whether it is connected.
- Players can pick up, rotate and preview a piece at any time; the client only sends the move on their live turn.
- The server works only in absolute board coordinates. Each client turns its view so the viewer's own edge is at the bottom: board cell (r, c) is drawn a quarter turn anticlockwise per seat after South, and a piece rotation the player picks on screen is converted to board terms before it is sent.
- **Layout.** The board sits in the centre of the screen with a panel beside each edge for the player on that edge: name, score, clock, AFK bar and hand. The viewer's own panel is below the board and twice the size of the others, with the shuffle button under their hand. Online, the viewer is always you. In hot-seat it is whoever's turn is live, and the view stays with the player who just moved until the next turn starts.
- Every line clear plays a short synthesized chime (Web Audio, no sound files), longer when several lines clear at once. Everyone in the room hears it. A Sound on/off button (key **M**) mutes it, and the choice is remembered in the browser.
- The same page also offers local hot-seat play, running the core in the browser. Opened straight from disk (`file://`), only hot-seat is available.

## 19. Code layout and tests

Plain JavaScript (CommonJS), tested with Node's built-in `node:test`; no dependencies.

| Module | Contents |
|---|---|
| `rng` | Seeded random number generator |
| `pieceSet` | The piece list: shapes and which are special (the one place to tune pieces) |
| `pieces` | Rotations, the bag, special-piece picks |
| `board` | Layout, blocked corners, pyramids, placement legality, legal-move enumeration |
| `lines` | Completed-line detection and hits |
| `resolve` | Anchoring and cluster resolution |
| `ranking` | Final standings and tie-breaks |
| `game` | `createGame`, `applyMove`, `startTurn`, `shuffle`, `tick`, `nextDeadline` |
| `server/rooms.js` | Rooms, seats, tokens and the per-room deadline timer (no sockets; clock and timers injected) |
| `server/app.js` | HTTP server for the client files plus the WebSocket endpoint `/ws` (uses the `ws` package, the only dependency) |
| `server/index.js` | `npm start`: rebuilds the client bundle and starts the server on port 8080 |
| `client/` | The browser page: menu, lobby and game, in online or local hot-seat mode |

Room tests drive the room layer with a fake clock and fake connections; one end-to-end test runs the real server with four real sockets.

Tests use hand-built boards and a fake clock. After every step of every test, they assert the invariants from §6: every owned block is anchored, and every grey cluster touches at least 2 colours. Named cases include:

- **Roots**: *a block placed later on the player's own edge, cut off from the starting pieces, detonates*; a destroyed starting piece's cell is not a root when refilled.
- **Resolution**: each of the 0 / 1 / 2+ outcomes; conversion to a timed-out player (dulled, no points); a dulled region breaking off; *fresh orphan merges with adjacent grey cluster before counting colours*; *same orphan without the grey neighbour detonates*; *merged cluster counts touching colours from both parts*; a grey cluster re-evaluated after a remote move removes one of its colours.
- **Pieces**: all 10 shapes and their rotations; the bag deals each tetromino once per cycle and never a special piece; starting hands contain no special pieces; special picks leave the bag untouched; a 1×1 fills a one-cell hole no tetromino fits; small pieces must touch an own block; a shuffle deals 3 bag pieces plus 1 special; a line clear refills the played slot with a special piece, and a move without one refills from the bag.
- **Lines and scoring**: 2 hits at a crossing; 2 points for the mover's own block destroyed by a line; no points for HP-only hits; frozen scores for players who are not alive.
- **Turns and clocks**: AFK pass versus personal-clock timeout and their precedence; bonus capping; +2 s per completed line (+4 s for a row and column together), within the cap; cap decay; forced pass and +5 s.
- **Shuffle**: offer persists across stuck turns and AFK passes; offer cleared on a legal move; one use per offer, with a fresh offer on the next forced pass.
- **Stuck table**: an all-pass round still awards passive points and decays caps; the shuffle window pauses personal clocks and closes early when everyone has shuffled; consecutive all-stuck rounds are paced by the window, never looped instantly.
- **Ranking**: living beats not-living; all-living tie broken by blocks on board; all-not-living tie broken by dulled blocks; eliminated (0 blocks) loses to timed-out with dulled blocks; remaining tie is a draw; a three-way tie narrows step by step.

## 20. Configuration

| Setting | Value |
|---|---|
| Board size | 11 × 11 |
| Players | 4 (lobby starts when full) |
| Pieces | 7 tetrominoes (bag) + 1×1, 1×2, small L (special: shuffle and line-clear reward only), in `src/core/pieceSet.js` |
| Hand size | 4 |
| Placed block HP | 1 |
| Personal clock start and cap | 60 s |
| Move bonus | +2 s |
| Pause before each turn | 2 s (`turnDelayMs`) |
| Line-clear bonus | +2 s per completed line |
| Forced-pass bonus | +5 s |
| Cap decay per round | 1 s |
| AFK timeout | 10 s |
| Shuffle window | 10 s |
| Game length | 10 minutes |
