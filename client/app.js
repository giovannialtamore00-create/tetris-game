'use strict';

// Browser client. Two modes share all of the rendering below:
//   - local hot-seat: the game core runs in this tab and all four seats play
//     here, taking turns on one screen;
//   - online: the server runs the core; this tab controls one seat, sends its
//     moves over a WebSocket and draws the state the server broadcasts.
// A "controller" object hides the difference from the rendering code.

(function () {
  const { game, board: B, pieces: P, constants: C } = window.TetrisCore;

  const SEATS = [
    { name: 'South', hueVar: '--south' },
    { name: 'West', hueVar: '--west' },
    { name: 'North', hueVar: '--north' },
    { name: 'East', hueVar: '--east' },
  ];
  const HUES = SEATS.map((s) => Number(getComputedStyle(document.documentElement).getPropertyValue(s.hueVar)));
  const HP_LIGHTNESS = { 3: 34, 2: 48, 1: 64 };
  const GREY_LIGHTNESS = { 3: 34, 2: 48, 1: 62 };
  const PIECE_NAMES = { M: '1×1', D: '1×2', L3: 'small L' };
  const STATUS_TEXT = { alive: 'alive', eliminated: 'eliminated', timedOut: 'timed out' };

  const $ = (id) => document.getElementById(id);
  const el = {
    board: $('board'),
    players: $('players'),
    log: $('log'),
    gameClock: $('gameClock'),
    status: $('status'),
    hint: $('hint'),
    banner: $('banner'),
    pauseBtn: $('pauseBtn'),
    newGameBtn: $('newGameBtn'),
    overlay: $('overlay'),
    overlayReason: $('overlayReason'),
    overlayNew: $('overlayNew'),
    standings: $('standings'),
    nickname: $('nicknameInput'),
    code: $('codeInput'),
    menuError: $('menuError'),
    onlineNote: $('onlineNote'),
    lobbyCode: $('lobbyCode'),
    lobbyLink: $('lobbyLink'),
    lobbySeats: $('lobbySeats'),
    lobbyStatus: $('lobbyStatus'),
  };

  const ERRORS = {
    illegalPlacement: 'Not a legal placement: every cell must be empty and one must touch your own block.',
    notYourTurn: 'It is not your turn.',
    noShuffleAvailable: 'No shuffle offer available.',
    notAlive: 'You are out of the game.',
    gameOver: 'The game is over.',
    tickRequired: 'A deadline just passed — try again.',
    roomNotFound: 'No room with that code.',
    roomFull: 'That room is full.',
    gameStarted: 'That room\'s game has already started.',
    sessionExpired: 'That room no longer exists.',
    alreadyInRoom: 'You are already in a room.',
    serverError: 'The server hit an error. Try again.',
  };
  const errorText = (code) => ERRORS[code] || code;

  // --- Storage (a per-browser convenience; everything works without it) -----

  // The nickname is shared by every tab (localStorage). The room session is
  // per tab (sessionStorage): it survives a refresh, and several tabs can each
  // hold a different seat, e.g. when testing alone.
  function makeStorage(area) {
    return {
      get(key) {
        try {
          return JSON.parse(window[area].getItem(key));
        } catch {
          return null;
        }
      },
      set(key, value) {
        try {
          if (value === null) window[area].removeItem(key);
          else window[area].setItem(key, JSON.stringify(value));
        } catch {
          /* ignore */
        }
      },
    };
  }
  const storage = makeStorage('localStorage');
  const tabStorage = makeStorage('sessionStorage');

  // --- View state ------------------------------------------------------------

  const ui = {
    state: null,
    selected: null, // hand index of the picked-up piece
    rotation: 0,
    hover: null, // board cell index under the pointer
    message: '',
    messageIsError: false,
    overlayDismissed: false,
  };
  let ctl = null; // the active controller

  function showScreen(name) {
    for (const screen of ['menu', 'lobby', 'game']) $(`${screen}Screen`).hidden = screen !== name;
    if (name !== 'game') el.overlay.hidden = true;
  }

  function resetGameView() {
    ui.state = null;
    ui.selected = null;
    ui.rotation = 0;
    ui.overlayDismissed = false;
    el.log.innerHTML = '';
    setMessage('');
    setBanner('');
  }

  function setMessage(text, isError = false) {
    ui.message = text;
    ui.messageIsError = isError;
  }

  function setBanner(text) {
    el.banner.textContent = text;
    el.banner.hidden = !text;
  }

  // Every state change goes through here. The picked-up piece is dropped when
  // the hand it came from changes or stops being controllable.
  function applyUpdate(state, events, t) {
    const prevSeat = ui.state ? ctl.controlledSeat() : null;
    const prevHand = prevSeat === null ? null : ui.state.players[prevSeat].hand.join();
    ui.state = state;
    const seat = ctl.controlledSeat();
    if (seat === null || seat !== prevSeat || state.players[seat].hand.join() !== prevHand) {
      ui.selected = null;
      ui.rotation = 0;
    }
    logEvents(events, t);
    const flashCells = [];
    for (const e of events) {
      if (e.type === 'destroyed') flashCells.push(...e.cells.map((d) => d.cell));
      if (e.type === 'detonated' || e.type === 'converted' || e.type === 'greyed') flashCells.push(...e.cells);
    }
    if (flashCells.length > 0) flash(flashCells);
    render();
  }

  // --- Local hot-seat controller ----------------------------------------------

  function createLocalController() {
    // Virtual time: pausing freezes it. A local testing aid, not a game rule.
    const time = { virtual: 0, lastReal: performance.now(), paused: false };
    const now = () => {
      const t = performance.now();
      if (!time.paused) time.virtual += t - time.lastReal;
      time.lastReal = t;
      return Math.floor(time.virtual);
    };

    function tick(t) {
      if (ui.state.over) return;
      const result = game.tick(ui.state, t);
      if (result.events.length > 0) applyUpdate(result.state, result.events, t);
    }

    function act(fn, successMessage = '') {
      const t = now();
      tick(t);
      const result = fn(ui.state, t);
      if (!result.ok) {
        setMessage(errorText(result.error), true);
        render();
        return;
      }
      setMessage(successMessage);
      applyUpdate(result.state, result.events, t);
    }

    const c = {
      mode: 'local',
      now,
      get paused() {
        return time.paused;
      },
      togglePause() {
        now();
        time.paused = !time.paused;
        render();
      },
      // In hot-seat the viewer is whoever's live turn it is.
      controlledSeat() {
        const s = ui.state;
        return s && s.phase === 'turn' && s.turnStartedAt !== null ? s.activeSeat : null;
      },
      canPlace() {
        return c.controlledSeat() !== null;
      },
      canShuffle() {
        return true; // every player is at this screen
      },
      seatLabel(seat) {
        return SEATS[seat].name;
      },
      seatConnected() {
        return true;
      },
      start() {
        time.virtual = 0;
        time.lastReal = performance.now();
        time.paused = false;
        const seed = Math.floor(Math.random() * 2 ** 31);
        const result = game.createGame({ seed, now: 0 });
        resetGameView();
        showScreen('game');
        applyUpdate(result.state, [{ type: 'note', text: `New game (seed ${seed})`, at: 0 }, ...result.events], 0);
      },
      frame() {
        tick(now());
      },
      move(move) {
        const seat = c.controlledSeat();
        act((s, t) => game.applyMove(s, seat, move, t));
      },
      shuffle(seat) {
        act((s, t) => game.shuffle(s, seat, t), `${SEATS[seat].name} shuffled their hand.`);
      },
      leave() {
        showMenu();
      },
    };
    return c;
  }

  // --- Online controller --------------------------------------------------------

  const SESSION_KEY = 'tetris.session';
  const NICKNAME_KEY = 'tetris.nickname';
  const RECONNECT_DELAY_MS = 1500;
  const MAX_RECONNECTS = 10;

  function createOnlineController() {
    let socket = null;
    let offset = 0; // server clock minus local clock
    let mySeat = null;
    let seats = [null, null, null, null];
    let session = null; // { code, token }
    let leaving = false;
    let reconnects = 0;
    let inGame = false;

    function send(message) {
      if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    }

    function connect(firstMessage) {
      leaving = false;
      const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
      socket = new WebSocket(url);
      socket.addEventListener('open', () => send(firstMessage));
      socket.addEventListener('message', (e) => {
        let msg;
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }
        handle(msg);
      });
      socket.addEventListener('close', () => {
        socket = null;
        if (leaving) return;
        if (session && reconnects < MAX_RECONNECTS) {
          reconnects++;
          setBanner('Connection lost — reconnecting…');
          setTimeout(() => {
            if (!leaving && session) connect({ type: 'resume', ...session });
          }, RECONNECT_DELAY_MS);
        } else {
          showMenu(session ? 'Lost connection to the server.' : 'Could not reach the server.');
        }
      });
    }

    function handle(msg) {
      switch (msg.type) {
        case 'joined':
          mySeat = msg.seat;
          session = { code: msg.code, token: msg.token };
          tabStorage.set(SESSION_KEY, session);
          reconnects = 0;
          setBanner('');
          history.replaceState(null, '', `?room=${msg.code}`);
          return;
        case 'lobby':
          seats = msg.seats;
          mySeat = msg.you;
          showScreen('lobby');
          renderLobby(msg.code);
          return;
        case 'state':
          offset = msg.serverNow - Date.now();
          seats = msg.seats;
          mySeat = msg.you;
          if (!inGame) {
            inGame = true;
            resetGameView();
            showScreen('game');
          }
          applyUpdate(msg.state, msg.events, c.now());
          return;
        case 'error':
          if (msg.error === 'sessionExpired' || !inGame) {
            if (msg.error === 'sessionExpired') tabStorage.set(SESSION_KEY, null);
            c.close();
            showMenu(errorText(msg.error));
          } else {
            setMessage(errorText(msg.error), true);
            render();
          }
          return;
        case 'replaced':
          c.close();
          showMenu('This seat was opened in another tab.');
          return;
        default:
      }
    }

    const c = {
      mode: 'online',
      now: () => Date.now() + offset,
      controlledSeat() {
        const s = ui.state;
        if (!s || s.over || mySeat === null) return null;
        return s.players[mySeat].status === C.ALIVE ? mySeat : null;
      },
      // You may pick up and preview pieces at any time; placing needs your live turn.
      canPlace() {
        const s = ui.state;
        return c.controlledSeat() !== null && s.phase === 'turn' && s.turnStartedAt !== null && s.activeSeat === mySeat;
      },
      canShuffle(seat) {
        return seat === mySeat;
      },
      seatLabel(seat) {
        return seats[seat] ? seats[seat].nickname : SEATS[seat].name;
      },
      seatConnected(seat) {
        return !seats[seat] || seats[seat].connected;
      },
      get mySeat() {
        return mySeat;
      },
      get seats() {
        return seats;
      },
      create(nickname) {
        connect({ type: 'create', nickname });
      },
      join(code, nickname) {
        connect({ type: 'join', code, nickname });
      },
      resume(saved) {
        session = saved;
        connect({ type: 'resume', ...saved });
      },
      frame() {},
      move(move) {
        send({ type: 'move', move });
      },
      shuffle() {
        send({ type: 'shuffle' });
      },
      // Leaves the room for good: the seat is freed in the lobby; in a game it
      // stays taken and its clock keeps running (§9).
      leave() {
        send({ type: 'leave' });
        tabStorage.set(SESSION_KEY, null);
        session = null;
        c.close();
        showMenu();
      },
      close() {
        leaving = true;
        if (socket) socket.close();
        socket = null;
      },
    };
    return c;
  }

  // --- Menu and lobby -----------------------------------------------------------

  const online = location.protocol === 'http:' || location.protocol === 'https:';

  function showMenu(error = '') {
    if (ctl && ctl.mode === 'online') ctl.close();
    ctl = null;
    ui.state = null;
    if (online) {
      history.replaceState(null, '', location.pathname);
      el.onlineNote.textContent = '';
    }
    el.menuError.textContent = error;
    showScreen('menu');
  }

  function nickname() {
    const name = el.nickname.value.trim();
    storage.set(NICKNAME_KEY, name);
    return name;
  }

  function startOnline(action) {
    if (!online) return;
    el.menuError.textContent = '';
    ctl = createOnlineController();
    action(ctl);
  }

  function renderLobby(code) {
    const link = `${location.origin}${location.pathname}?room=${code}`;
    el.lobbyCode.textContent = code;
    el.lobbyLink.value = link;
    el.lobbySeats.innerHTML = '';
    ctl.seats.forEach((info, seat) => {
      const li = document.createElement('li');
      li.style.setProperty('--hue', HUES[seat]);
      const name = document.createElement('span');
      const where = document.createElement('span');
      where.textContent = SEATS[seat].name;
      if (info) {
        name.textContent = `${info.nickname}${seat === ctl.mySeat ? ' (you)' : ''}${info.connected ? '' : ' — reconnecting…'}`;
        if (seat === ctl.mySeat) li.className = 'you';
      } else {
        name.textContent = 'Waiting for a player…';
        li.className = 'empty';
      }
      li.append(name, where);
      el.lobbySeats.appendChild(li);
    });
    const missing = ctl.seats.filter((s) => !s).length;
    el.lobbyStatus.textContent = `The game starts automatically when 4 players have joined (${missing} more needed).`;
  }

  // --- Actions ------------------------------------------------------------------

  function selectPiece(handIndex) {
    if (!ui.state || ctl.controlledSeat() === null) return;
    if (ui.selected === handIndex) {
      ui.selected = null;
    } else {
      ui.selected = handIndex;
      ui.rotation = 0;
    }
    setMessage('');
    render();
  }

  function rotate(delta) {
    if (ui.selected === null) return;
    ui.rotation = (ui.rotation + delta + 4) % 4;
    render();
  }

  // The picked-up piece positioned so the pointer sits near its centre.
  function placementAt(cell) {
    const seat = ctl ? ctl.controlledSeat() : null;
    if (seat === null || ui.selected === null || cell === null) return null;
    const piece = ui.state.players[seat].hand[ui.selected];
    const offsets = P.ROTATIONS[piece][ui.rotation];
    const h = Math.max(...offsets.map(([r]) => r)) + 1;
    const w = Math.max(...offsets.map(([, c]) => c)) + 1;
    const y = Math.floor(cell / C.SIZE) - Math.floor((h - 1) / 2);
    const x = (cell % C.SIZE) - Math.floor((w - 1) / 2);
    const cells = offsets
      .map(([r, c]) => [y + r, x + c])
      .filter(([r, c]) => C.inBounds(r, c))
      .map(([r, c]) => C.idx(r, c));
    const exact = B.pieceCells(piece, ui.rotation, x, y);
    const legal = B.isLegalPlacement(ui.state.owner, seat, exact);
    return { x, y, cells, legal };
  }

  function place(cell) {
    const placement = placementAt(cell);
    if (!placement) return;
    if (!ctl.canPlace()) {
      setMessage('Wait for your turn to place it.', true);
      render();
      return;
    }
    ctl.move({ handIndex: ui.selected, rotation: ui.rotation, x: placement.x, y: placement.y });
  }

  // --- Board rendering ------------------------------------------------------------

  const cellEls = [];
  function buildBoard() {
    for (let i = 0; i < C.CELL_COUNT; i++) {
      const div = document.createElement('div');
      div.className = 'cell';
      div.dataset.i = i;
      el.board.appendChild(div);
      cellEls.push(div);
    }
    el.board.addEventListener('mousemove', (e) => {
      const i = e.target.dataset && e.target.dataset.i;
      const cell = i === undefined ? null : Number(i);
      if (cell !== ui.hover) {
        ui.hover = cell;
        if (ui.state) renderBoard();
      }
    });
    el.board.addEventListener('mouseleave', () => {
      ui.hover = null;
      if (ui.state) renderBoard();
    });
    el.board.addEventListener('click', (e) => {
      if (ui.state && e.target.dataset && e.target.dataset.i !== undefined) place(Number(e.target.dataset.i));
    });
    el.board.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      rotate(1);
    });
  }

  function cellStyle(i) {
    const s = ui.state;
    const owner = s.owner[i];
    const hp = s.hp[i];
    if (owner === C.BLOCKED) return { className: 'cell blocked', background: '', shadow: '', text: '' };
    if (owner === C.EMPTY) return { className: 'cell', background: '', shadow: '', text: '' };
    if (owner === C.GREY) {
      return { className: 'cell', background: `hsl(0, 0%, ${GREY_LIGHTNESS[hp]}%)`, shadow: '', text: String(hp) };
    }
    const hue = HUES[owner];
    const l = HP_LIGHTNESS[hp];
    if (s.players[owner].status === C.TIMED_OUT) {
      // Dulled: hollow outline in a washed-out version of the owner's colour.
      return {
        className: 'cell dulled',
        background: `repeating-linear-gradient(45deg, hsla(${hue}, 20%, ${l}%, 0.35) 0 3px, transparent 3px 7px)`,
        shadow: `inset 0 0 0 3px hsl(${hue}, 22%, ${l}%)`,
        text: String(hp),
      };
    }
    return { className: 'cell', background: `hsl(${hue}, 65%, ${l}%)`, shadow: '', text: String(hp) };
  }

  function renderBoard() {
    const placement = placementAt(ui.hover);
    const preview = new Set(placement ? placement.cells : []);
    for (let i = 0; i < C.CELL_COUNT; i++) {
      const style = cellStyle(i);
      const div = cellEls[i];
      let className = style.className;
      if (preview.has(i)) className += placement.legal ? ' preview legal' : ' preview illegal';
      if (div.classList.contains('flash')) className += ' flash';
      div.className = className;
      div.style.background = style.background;
      div.style.boxShadow = style.shadow;
      div.textContent = style.text;
    }
  }

  function flash(cells) {
    for (const i of cells) {
      const div = cellEls[i];
      div.classList.remove('flash');
      void div.offsetWidth; // restart the animation
      div.classList.add('flash');
      setTimeout(() => div.classList.remove('flash'), 600);
    }
  }

  // --- Players ------------------------------------------------------------------

  function miniPiece(piece, rotation, hue) {
    const offsets = P.ROTATIONS[piece][rotation];
    const h = Math.max(...offsets.map(([r]) => r)) + 1;
    const w = Math.max(...offsets.map(([, c]) => c)) + 1;
    const filled = new Set(offsets.map(([r, c]) => `${r},${c}`));
    const grid = document.createElement('div');
    grid.className = 'mini';
    grid.style.gridTemplateColumns = `repeat(${w}, 9px)`;
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        const d = document.createElement('div');
        if (filled.has(`${r},${c}`)) d.style.background = `hsl(${hue}, 65%, 55%)`;
        grid.appendChild(d);
      }
    }
    return grid;
  }

  const pieceName = (piece) => PIECE_NAMES[piece] || piece;
  const fmtSeconds = (ms) => (Math.max(0, ms) / 1000).toFixed(1);
  const liveSeat = () => {
    const s = ui.state;
    return s.phase === 'turn' && s.turnStartedAt !== null ? s.activeSeat : null;
  };

  function span(className, text) {
    const node = document.createElement('span');
    node.className = className;
    node.textContent = text;
    return node;
  }

  // Rebuilt only when the state or selection changes; the per-frame clock
  // readouts are updated in place by renderTimers().
  const timerEls = [];

  function renderPlayers() {
    const s = ui.state;
    const live = liveSeat();
    const controlled = ctl.controlledSeat();
    el.players.innerHTML = '';
    for (const p of s.players) {
      const hue = HUES[p.seat];
      const isActive = live === p.seat;
      const isMine = controlled === p.seat;
      const card = document.createElement('div');
      card.className = `player${isActive ? ' active' : ''}${p.status !== C.ALIVE ? ' out' : ''}`;
      card.style.setProperty('--hue', hue);

      const head = document.createElement('div');
      head.className = 'player-head';
      const name = span('player-name', ctl.seatLabel(p.seat));
      if (ctl.mode === 'online') {
        name.appendChild(span('player-seat', `${SEATS[p.seat].name}${p.seat === ctl.mySeat ? ' · you' : ''}`));
        if (!ctl.seatConnected(p.seat)) name.appendChild(span('player-flag', 'offline'));
      }
      head.append(name, span('player-score', String(p.score)));

      const meta = document.createElement('div');
      meta.className = 'player-meta';
      const clock = span('player-clock', '');
      meta.append(span('', `${STATUS_TEXT[p.status]} · ${B.countBlocks(s.owner, p.seat)} blocks`), clock);

      const afk = document.createElement('div');
      afk.className = `afk-bar${isActive ? '' : ' hidden'}`;
      afk.title = 'AFK timer';
      const fill = document.createElement('div');
      afk.appendChild(fill);
      card.append(head, meta, afk);
      timerEls[p.seat] = { clock, afk: fill, isActive };

      const hand = document.createElement('div');
      hand.className = 'hand';
      p.hand.forEach((piece, k) => {
        const slot = document.createElement('div');
        const selected = isMine && ui.selected === k;
        const special = P.SPECIAL_PIECES.includes(piece);
        slot.className = `hand-slot${isMine ? ' clickable' : ''}${selected ? ' selected' : ''}${special ? ' special' : ''}`;
        const label = `${pieceName(piece)}${special ? ' (special)' : ''}`;
        slot.title = isMine ? `${label} — press ${k + 1}` : label;
        slot.appendChild(miniPiece(piece, selected ? ui.rotation : 0, hue));
        if (isMine) slot.addEventListener('click', () => selectPiece(k));
        hand.appendChild(slot);
      });
      card.appendChild(hand);

      if (p.status === C.ALIVE && p.shuffleAvailable && ctl.canShuffle(p.seat)) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'shuffle-btn';
        btn.textContent = 'Shuffle hand (offer available)';
        btn.addEventListener('click', () => ctl.shuffle(p.seat));
        card.appendChild(btn);
      }
      el.players.appendChild(card);
    }
  }

  // --- Top bar, hint, overlay -------------------------------------------------------

  function renderTimers(t) {
    const s = ui.state;
    for (const p of s.players) {
      const refs = timerEls[p.seat];
      if (!refs) continue;
      const elapsed = refs.isActive && !s.over ? Math.max(0, t - s.turnStartedAt) : 0;
      const remaining = p.remainingMs - elapsed;
      refs.clock.textContent = `${fmtSeconds(remaining)} / ${fmtSeconds(p.capMs)} s`;
      refs.clock.classList.toggle('running', refs.isActive);
      refs.clock.classList.toggle('low', refs.isActive && remaining < 10_000);
      refs.afk.style.width = `${Math.min(100, (elapsed / s.config.afkMs) * 100)}%`;
    }

    const left = s.over ? 0 : s.endsAt - t;
    const mins = Math.floor(Math.max(0, left) / 60_000);
    const secs = Math.floor((Math.max(0, left) % 60_000) / 1000);
    el.gameClock.textContent = `${mins}:${String(secs).padStart(2, '0')}`;
    el.gameClock.classList.toggle('low', left < 60_000);

    let status;
    if (s.over) status = 'Game over';
    else if (s.phase === 'shuffleWindow') {
      status = `Everyone is stuck — shuffle window ${fmtSeconds(s.shuffleWindowEndsAt - t)} s`;
    } else if (ctl.mode === 'online' && s.activeSeat === ctl.mySeat) {
      status = `Round ${s.round} · Your turn`;
    } else {
      status = `Round ${s.round} · ${ctl.seatLabel(s.activeSeat)} to play`;
    }
    if (ctl.mode === 'local' && ctl.paused) status += ' · PAUSED';
    el.status.textContent = status;
    el.pauseBtn.textContent = ctl.mode === 'local' && ctl.paused ? 'Resume' : 'Pause';
  }

  function renderHint() {
    let text = ui.message;
    if (!text) {
      const s = ui.state;
      const seat = ctl.controlledSeat();
      if (s.over) text = '';
      else if (seat === null) {
        text = ctl.mode === 'online' ? 'You are out of the game — watching.' : 'Waiting for the shuffle window to close.';
      } else if (!ctl.canPlace()) {
        text = 'Not your turn yet: you can pick, rotate and preview a piece while you wait.';
      } else if (ui.selected === null) {
        text = ctl.mode === 'online' ? 'Your turn: pick a piece from your hand.' : `${SEATS[seat].name}: pick a piece from your hand.`;
      } else {
        text = 'Hover over the board and click to place. R rotates.';
      }
    }
    el.hint.textContent = text;
    el.hint.classList.toggle('error', ui.messageIsError && !!ui.message);
  }

  function renderOverlay() {
    const s = ui.state;
    const show = s.over && !ui.overlayDismissed;
    el.overlay.hidden = !show;
    if (!show) return;
    const r = s.result;
    const names = r.winners.map((seat) => ctl.seatLabel(seat)).join(' and ');
    const why = r.reason === 'timeUp' ? 'The 10-minute game clock ran out.' : 'Only one player is left alive.';
    el.overlayReason.textContent = `${why} ${r.draw ? `Draw between ${names}.` : `${names} wins.`}`;
    el.standings.innerHTML = '';
    for (const row of r.standings) {
      const tr = document.createElement('tr');
      if (row.rank === 1) tr.className = 'winner';
      for (const value of [row.rank, ctl.seatLabel(row.seat), row.score, STATUS_TEXT[row.status], row.blocks]) {
        const td = document.createElement('td');
        td.textContent = String(value);
        tr.appendChild(td);
      }
      el.standings.appendChild(tr);
    }
    el.overlayNew.textContent = ctl.mode === 'local' ? 'New game' : 'Back to menu';
  }

  // --- Event log ------------------------------------------------------------------

  const cellName = (i) => `(${Math.floor(i / C.SIZE)},${i % C.SIZE})`;
  const who = (seat) => (seat >= 0 ? ctl.seatLabel(seat) : 'grey');
  const lineName = (l) => `${l.kind} ${l.index}`;

  function describe(e) {
    switch (e.type) {
      case 'note': return e.text;
      case 'gameStarted': return 'Game clock started (10:00).';
      case 'turnStarted': return `${who(e.seat)}'s turn.`;
      case 'placed': return `${who(e.seat)} placed ${pieceName(e.piece)} at ${cellName(e.cells[0])}.`;
      case 'lineClearBonus': return `${who(e.seat)} gains +${e.ms / 1000} s for ${e.lines} line clear(s) (up to the cap).`;
      case 'rewardPiece': return `${who(e.seat)} earned a special piece for the line clear: ${pieceName(e.piece)}.`;
      case 'linesCompleted': return `Line clear: ${e.lines.map(lineName).join(', ')}.`;
      case 'hit': return null;
      case 'destroyed': {
        const pts = e.cells.reduce((sum, d) => sum + d.points, 0);
        return `${e.cells.length} block(s) destroyed by the clear: +${pts} to ${who(e.scorer)}.`;
      }
      case 'detonated': return `${e.cells.length} cut-off block(s) detonated: +${e.points} to ${who(e.scorer)}.`;
      case 'converted': return `${e.cells.length} block(s) converted to ${who(e.to)} (+${e.points}).`;
      case 'greyed': return `${e.cells.length} block(s) turned grey.`;
      case 'scored': return null;
      case 'eliminated': return `${who(e.seat)} has no blocks left and is eliminated.`;
      case 'passed':
        return e.reason === 'afk'
          ? `${who(e.seat)} was AFK-passed (−10 s).`
          : `${who(e.seat)} has no legal move: passed (+5 s, shuffle offered).`;
      case 'timedOut': return `${who(e.seat)} ran out of time and is out; their blocks are dulled.`;
      case 'roundEnded': return `Round ${e.round} ended: +1 point to every living player, caps −1 s.`;
      case 'shuffled': return `${who(e.seat)} shuffled their hand (special piece: ${pieceName(e.hand[e.hand.length - 1])}).`;
      case 'shuffleWindowOpened': return 'Everyone is stuck: shuffle window open (10 s).';
      case 'shuffleWindowClosed': return 'Shuffle window closed.';
      case 'gameOver': return `Game over (${e.reason === 'timeUp' ? 'time up' : 'last player standing'}).`;
      default: return e.type;
    }
  }

  const fmtClock = (ms) => {
    const total = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  };

  function logEvents(events, t) {
    const start = ui.state ? ui.state.startedAt : 0;
    for (const e of events) {
      const text = describe(e);
      if (!text) continue;
      const li = document.createElement('li');
      li.appendChild(span('t', fmtClock((e.at !== undefined ? e.at : t) - start)));
      li.appendChild(document.createTextNode(text));
      el.log.prepend(li);
    }
    while (el.log.children.length > 200) el.log.lastChild.remove();
  }

  // --- Main loop ------------------------------------------------------------------

  function render() {
    if (!ui.state || !ctl) return;
    el.pauseBtn.hidden = ctl.mode !== 'local';
    el.newGameBtn.hidden = ctl.mode !== 'local';
    renderBoard();
    renderPlayers();
    renderHint();
    renderOverlay();
    renderTimers(ctl.now());
  }

  // Every 100 ms: let the controller advance time (local mode applies expired
  // deadlines here), then refresh the clock readouts.
  setInterval(() => {
    if (!ctl || !ui.state) return;
    ctl.frame();
    if (ctl && ui.state) renderTimers(ctl.now());
  }, 100);

  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || !ctl || !ui.state) return;
    if (e.key === 'r' || e.key === 'R') rotate(e.shiftKey ? -1 : 1);
    else if (e.key === 'Escape') {
      ui.selected = null;
      render();
    } else if (['1', '2', '3', '4'].includes(e.key)) selectPiece(Number(e.key) - 1);
    else if ((e.key === 'p' || e.key === 'P') && ctl.mode === 'local') ctl.togglePause();
  });

  // --- Wiring ---------------------------------------------------------------------

  $('hotseatBtn').addEventListener('click', () => {
    ctl = createLocalController();
    ctl.start();
  });
  $('createBtn').addEventListener('click', () => {
    const name = nickname();
    startOnline((c) => c.create(name));
  });
  function joinFromInput() {
    const code = el.code.value.trim().toUpperCase();
    if (code.length !== 4) {
      el.menuError.textContent = 'Enter the 4-character room code.';
      return;
    }
    const name = nickname();
    startOnline((c) => c.join(code, name));
  }
  $('joinBtn').addEventListener('click', joinFromInput);
  el.code.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') joinFromInput();
  });
  $('copyLinkBtn').addEventListener('click', () => {
    el.lobbyLink.select();
    if (navigator.clipboard) navigator.clipboard.writeText(el.lobbyLink.value).catch(() => {});
  });
  $('leaveLobbyBtn').addEventListener('click', () => ctl && ctl.leave());
  $('menuBtn').addEventListener('click', () => {
    if (!ctl) return;
    if (ctl.mode === 'online' && ui.state && !ui.state.over) {
      const ok = confirm('Leave this game? Your seat stays in the game and your clock keeps running until you time out.');
      if (!ok) return;
    }
    ctl.leave();
  });
  el.pauseBtn.addEventListener('click', () => ctl && ctl.mode === 'local' && ctl.togglePause());
  el.newGameBtn.addEventListener('click', () => ctl && ctl.mode === 'local' && ctl.start());
  el.overlayNew.addEventListener('click', () => {
    if (ctl.mode === 'local') ctl.start();
    else ctl.leave();
  });
  $('overlayClose').addEventListener('click', () => {
    ui.overlayDismissed = true;
    render();
  });

  // --- Start-up -------------------------------------------------------------------

  buildBoard();
  el.nickname.value = storage.get(NICKNAME_KEY) || '';
  const params = new URLSearchParams(location.search);
  const invitedCode = (params.get('room') || '').toUpperCase();
  if (invitedCode) el.code.value = invitedCode;

  if (!online) {
    $('createBtn').disabled = true;
    $('joinBtn').disabled = true;
    el.onlineNote.textContent = 'Online play needs the game server: run "npm start" and open the address it prints.';
    showScreen('menu');
  } else {
    const saved = tabStorage.get(SESSION_KEY);
    if (saved && saved.code && saved.token && (!invitedCode || invitedCode === saved.code)) {
      // Reclaim our seat after a refresh or a dropped connection.
      el.menuError.textContent = '';
      showScreen('menu');
      el.onlineNote.textContent = `Reconnecting to room ${saved.code}…`;
      ctl = createOnlineController();
      ctl.resume(saved);
    } else {
      showScreen('menu');
      if (invitedCode) el.onlineNote.textContent = `You were invited to room ${invitedCode}: enter a nickname and press Join.`;
    }
  }
})();
