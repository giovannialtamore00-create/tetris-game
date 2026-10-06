'use strict';

// Browser client. Two modes share all of the rendering below:
//   - local hot-seat: the game core runs in this tab and all four seats play
//     here, taking turns on one screen;
//   - online: the server runs the core; this tab controls one seat, sends its
//     moves over a WebSocket and draws the state the server broadcasts.
// A "controller" object hides the difference from the rendering code.

(function () {
  const { game, board: B, pieces: P, constants: C, bot } = window.TetrisCore;

  const SEATS = [
    { name: 'South', hueVar: '--south' },
    { name: 'West', hueVar: '--west' },
    { name: 'North', hueVar: '--north' },
    { name: 'East', hueVar: '--east' },
  ];
  const HUES = SEATS.map((s) => Number(getComputedStyle(document.documentElement).getPropertyValue(s.hueVar)));
  const HP_LIGHTNESS = { 3: 34, 2: 48, 1: 64 };
  const GREY_LIGHTNESS = { 3: 34, 2: 48, 1: 62 };
  const PIECE_NAMES = { M: '1×1', D: '1×2', L3: 'small L', I3: '1×3' };
  const STATUS_TEXT = { alive: 'alive', eliminated: 'eliminated', timedOut: 'timed out', absent: 'empty side' };

  const $ = (id) => document.getElementById(id);
  const el = {
    board: $('board'),
    panels: { bottom: $('panelBottom'), left: $('panelLeft'), top: $('panelTop'), right: $('panelRight') },
    log: $('log'),
    gameClock: $('gameClock'),
    status: $('status'),
    hint: $('hint'),
    banner: $('banner'),
    pauseBtn: $('pauseBtn'),
    newGameBtn: $('newGameBtn'),
    soundBtn: $('soundBtn'),
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
    paused: 'The game is paused.',
    notPaused: 'The game is not paused.',
    notAllowedToResume: 'Only the player who paused, or the host, can resume.',
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

  // --- Sound effects ---------------------------------------------------------
  // Synthesized with Web Audio, so there are no sound files. Browsers only
  // allow audio after the user has interacted with the page, so the audio
  // context is created (or resumed) on the first click or key press.

  const MUTE_KEY = 'tetris.muted';
  const sound = (() => {
    let ctx = null;
    let muted = storage.get(MUTE_KEY) === true;

    function context() {
      if (!ctx) {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) return null;
        ctx = new AudioContextClass();
      }
      if (ctx.state === 'suspended') ctx.resume();
      return ctx;
    }

    function tone(ac, freq, start, duration, type, volume) {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, start);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(volume, start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      osc.connect(gain).connect(ac.destination);
      osc.start(start);
      osc.stop(start + duration + 0.05);
    }

    return {
      get muted() {
        return muted;
      },
      unlock() {
        if (!muted) context();
      },
      toggle() {
        muted = !muted;
        storage.set(MUTE_KEY, muted);
        if (!muted) context();
      },
      // A low thump plus a rising C-major arpeggio; clearing several lines at
      // once extends the arpeggio an octave higher.
      lineClear(lineCount) {
        if (muted) return;
        const ac = context();
        if (!ac) return;
        const t = ac.currentTime + 0.01;
        const notes = [523.25, 659.25, 783.99, 1046.5]; // C5 E5 G5 C6
        if (lineCount >= 2) notes.push(1318.51, 1567.98, 2093.0); // E6 G6 C7
        tone(ac, 130.81, t, 0.3, 'sine', 0.3);
        notes.forEach((freq, k) => tone(ac, freq, t + k * 0.06, 0.4, 'triangle', 0.16));
      },
    };
  })();

  // --- View state ------------------------------------------------------------

  const ui = {
    state: null,
    selected: null, // hand index of the picked-up piece
    rotation: 0, // as the viewer sees it on screen (see boardRotation)
    hover: null, // board cell index under the pointer
    viewSeat: null, // whose point of view the board is drawn from (their edge at the bottom)
    message: '',
    messageIsError: false,
    overlayDismissed: false,
    // Move history: the board at the start and after every placement. While
    // viewIndex is set, the board shows that entry instead of the live game.
    history: [],
    viewIndex: null,
  };
  let ctl = null; // the active controller

  // Same entries as the server's (server/rooms.js historyEntry).
  function historyEntry(state, events) {
    const placed = events.find((e) => e.type === 'placed');
    const started = events.find((e) => e.type === 'gameStarted');
    if (!placed && !started) return null;
    return {
      owner: [...state.owner],
      hp: [...state.hp],
      seat: placed ? placed.seat : null,
      piece: placed ? placed.piece : null,
      cells: placed ? placed.cells : [],
      at: placed ? placed.at : started.at,
    };
  }

  function showScreen(name) {
    for (const screen of ['menu', 'lobby', 'game']) $(`${screen}Screen`).hidden = screen !== name;
    if (name !== 'game') el.overlay.hidden = true;
  }

  function resetGameView() {
    ui.state = null;
    ui.selected = null;
    ui.rotation = 0;
    ui.viewSeat = null;
    ui.overlayDismissed = false;
    ui.history = [];
    ui.viewIndex = null;
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
    updateViewSeat();
    const entry = historyEntry(state, events);
    if (entry) ui.history.push(entry);
    logEvents(events, t);
    const cleared = events.find((e) => e.type === 'linesCompleted');
    if (cleared) sound.lineClear(cleared.lines.length);
    const flashCells = [];
    for (const e of events) {
      if (e.type === 'destroyed') flashCells.push(...e.cells.map((d) => d.cell));
      if (e.type === 'detonated' || e.type === 'converted' || e.type === 'greyed') flashCells.push(...e.cells);
    }
    if (flashCells.length > 0) flash(flashCells);
    render();
  }

  // --- Local controller: hot-seat, or you against easy bots --------------------

  const HUMAN_SEAT = 0; // against bots you always play South

  function createLocalController({ bots = false, mode = C.TURNS, playerCount = 4 } = {}) {
    // Against bots you play South and the bots take the other seats in play (§26).
    const botSeats = bots ? C.activeSeatsFor(playerCount).filter((k) => k !== HUMAN_SEAT) : [];
    const vsBots = botSeats.length > 0;
    const isBotSeat = (seat) => botSeats.includes(seat);
    let botPlan = null; // turn-based: { turnStartedAt, at }, when the bot to move will play
    let realtimePlans = []; // real-time: realtimePlans[seat] = { readyAt, at }

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

    // Bot actions are silent: if one turns out stale, it simply doesn't happen.
    function act(fn, successMessage = '', { quiet = false } = {}) {
      const t = now();
      tick(t);
      const result = fn(ui.state, t);
      if (!result.ok) {
        if (quiet) return;
        setMessage(errorText(result.error), true);
        render();
        return;
      }
      if (!quiet) setMessage(successMessage);
      applyUpdate(result.state, result.events, t);
    }

    // Easy bots: use a shuffle offer at once; on their live turn, move after
    // thinking for 3-4 s of game time (so pausing pauses them too).
    function runBots(t) {
      const s = ui.state;
      if (!s || s.over) return;
      if (mode === C.REALTIME) {
        runRealtimeBots(t);
        return;
      }
      const shuffler = botSeats.find((seat) => bot.wantsShuffle(s, seat));
      if (shuffler !== undefined) {
        act((st, tt) => game.shuffle(st, shuffler, tt), '', { quiet: true });
        return;
      }
      if (s.phase !== 'turn' || s.turnStartedAt === null || !isBotSeat(s.activeSeat)) return;
      if (!botPlan || botPlan.turnStartedAt !== s.turnStartedAt) {
        botPlan = { turnStartedAt: s.turnStartedAt, at: s.turnStartedAt + bot.botThinkMs() };
      }
      if (t < botPlan.at) return;
      const seat = s.activeSeat;
      const choice = bot.chooseEasyMove(s, seat);
      if (choice) act((st, tt) => game.applyMove(st, seat, choice, tt), '', { quiet: true });
    }

    // Real-time (§21): each bot acts once its cooldown is over plus a
    // 3-4 s think: a random legal piece, or a shuffle if it has none.
    function runRealtimeBots(t) {
      for (const seat of botSeats) {
        const p = ui.state.players[seat];
        if (p.status !== C.ALIVE) continue;
        let plan = realtimePlans[seat];
        if (!plan || plan.readyAt !== p.cooldownUntil) {
          plan = { readyAt: p.cooldownUntil, at: Math.max(t, p.cooldownUntil) + bot.botThinkMs() };
          realtimePlans[seat] = plan;
        }
        if (t < plan.at) continue;
        realtimePlans[seat] = null;
        const choice = bot.chooseEasyMove(ui.state, seat);
        if (choice) act((st, tt) => game.applyMove(st, seat, choice, tt), '', { quiet: true });
        else if (bot.wantsShuffle(ui.state, seat)) act((st, tt) => game.shuffle(st, seat, tt), '', { quiet: true });
        return; // one bot action per frame
      }
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
      // Against bots you always play South. In hot-seat the player in control
      // is whoever's live turn it is.
      controlledSeat() {
        const s = ui.state;
        if (!s) return null;
        if (vsBots) return !s.over && s.players[HUMAN_SEAT].status === C.ALIVE ? HUMAN_SEAT : null;
        return s.phase === 'turn' && s.turnStartedAt !== null ? s.activeSeat : null;
      },
      canPlace() {
        const s = ui.state;
        if (!vsBots) return c.controlledSeat() !== null;
        if (mode === C.REALTIME) return c.controlledSeat() !== null && now() >= s.players[HUMAN_SEAT].cooldownUntil;
        return c.controlledSeat() !== null && s.phase === 'turn' && s.turnStartedAt !== null && s.activeSeat === HUMAN_SEAT;
      },
      canShuffle(seat) {
        return vsBots ? seat === HUMAN_SEAT : true; // in hot-seat every player is at this screen
      },
      fixedViewSeat() {
        return vsBots ? HUMAN_SEAT : null;
      },
      isBotSeat,
      seatLabel(seat) {
        if (!vsBots) return SEATS[seat].name;
        return seat === HUMAN_SEAT ? 'You' : `Easy bot ${botSeats.indexOf(seat) + 1}`;
      },
      seatConnected() {
        return true;
      },
      start() {
        time.virtual = 0;
        time.lastReal = performance.now();
        time.paused = false;
        const seed = Math.floor(Math.random() * 2 ** 31);
        const result = game.createGame({ seed, now: 0, config: { mode, rainbowMode: true, playerCount } }); // §25: rainbow is the only mode
        botPlan = null;
        realtimePlans = [];
        resetGameView();
        showScreen('game');
        applyUpdate(result.state, [{ type: 'note', text: `New game (seed ${seed})`, at: 0 }, ...result.events], 0);
      },
      frame() {
        const t = now();
        tick(t);
        if (vsBots) runBots(t);
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
    let host = null; // lobby host seat
    let lobbyMode = C.REALTIME;
    let lobbyPlayers = 4;
    let lobbyActiveSeats = [0, 1, 2, 3];
    let lobbyError = '';
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
          host = msg.host;
          lobbyMode = msg.mode;
          lobbyPlayers = msg.playerCount;
          lobbyActiveSeats = msg.activeSeats;
          lobbyError = '';
          showScreen('lobby');
          renderLobby(msg.code);
          return;
        case 'state':
          offset = msg.serverNow - Date.now();
          seats = msg.seats;
          mySeat = msg.you;
          host = msg.host;
          if (!inGame) {
            inGame = true;
            resetGameView();
            showScreen('game');
          }
          applyUpdate(msg.state, msg.events, c.now());
          return;
        case 'history':
          // Sent after reconnecting: the full move history so far.
          ui.history = msg.entries;
          if (ui.viewIndex !== null && ui.viewIndex >= ui.history.length) ui.viewIndex = null;
          render();
          return;
        case 'error':
          if (msg.error === 'sessionExpired' || !session) {
            // Could not get into a room at all: back to the menu.
            if (msg.error === 'sessionExpired') tabStorage.set(SESSION_KEY, null);
            c.close();
            showMenu(errorText(msg.error));
          } else if (!inGame) {
            lobbyError = errorText(msg.error);
            el.lobbyStatus.textContent = lobbyError;
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
      // You may pick up and preview pieces at any time; placing needs your live
      // turn (turn-based) or a finished cooldown (real-time).
      canPlace() {
        const s = ui.state;
        if (c.controlledSeat() === null || s.pausedAt !== null) return false;
        if (s.config.mode === C.REALTIME) return c.now() >= s.players[mySeat].cooldownUntil;
        return s.phase === 'turn' && s.turnStartedAt !== null && s.activeSeat === mySeat;
      },
      canShuffle(seat) {
        return seat === mySeat;
      },
      fixedViewSeat() {
        return mySeat;
      },
      isBotSeat(seat) {
        return Boolean(seats[seat] && seats[seat].bot);
      },
      get isHost() {
        return mySeat !== null && mySeat === host;
      },
      get hostSeat() {
        return host;
      },
      get lobbyError() {
        return lobbyError;
      },
      addBot() {
        send({ type: 'addBot' });
      },
      removeBot(seat) {
        send({ type: 'removeBot', seat });
      },
      setMode(newMode) {
        send({ type: 'setMode', mode: newMode });
      },
      // §22: anyone can pause; the player who paused, or the host, can resume.
      get paused() {
        return Boolean(ui.state && ui.state.pausedAt !== null);
      },
      canUnpause() {
        return c.paused && (ui.state.pausedBy === mySeat || mySeat === host);
      },
      togglePause() {
        if (!c.paused) send({ type: 'pause' });
        else if (c.canUnpause()) send({ type: 'unpause' });
      },
      get lobbyPlayers() {
        return lobbyPlayers;
      },
      get lobbyActiveSeats() {
        return lobbyActiveSeats;
      },
      setPlayers(count) {
        send({ type: 'setPlayers', count });
      },
      get lobbyMode() {
        return lobbyMode;
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
      if (!ctl.lobbyActiveSeats.includes(seat)) return;
      const li = document.createElement('li');
      li.style.setProperty('--hue', HUES[seat]);
      const name = document.createElement('span');
      const where = document.createElement('span');
      where.className = 'seat-where';
      where.textContent = SEATS[seat].name;
      if (info) {
        const tags = [];
        if (info.bot) tags.push('bot');
        if (seat === ctl.mySeat) tags.push('you');
        if (seat === ctl.hostSeat) tags.push('host');
        name.textContent = `${info.nickname}${tags.length ? ` (${tags.join(', ')})` : ''}${info.connected ? '' : ' — reconnecting…'}`;
        if (seat === ctl.mySeat) li.className = 'you';
      } else {
        name.textContent = 'Waiting for a player…';
        li.className = 'empty';
      }
      li.append(name, where);
      if (info && info.bot && ctl.isHost) {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'remove-bot';
        remove.textContent = 'Remove';
        remove.title = 'Remove this bot';
        remove.addEventListener('click', () => ctl.removeBot(seat));
        li.appendChild(remove);
      }
      el.lobbySeats.appendChild(li);
    });
    renderModeRow();
    renderPlayersRow();
    const missing = ctl.lobbyActiveSeats.filter((k) => !ctl.seats[k]).length;
    $('addBotBtn').hidden = !(ctl.isHost && missing > 0);
    const hostNote = ctl.isHost ? ' As host, you can fill empty seats with easy bots.' : '';
    el.lobbyStatus.textContent =
      ctl.lobbyError || `The game starts automatically when all 4 seats are filled (${missing} more needed).${hostNote}`;
  }

  const MODE_NAMES = { turns: 'Turn-based', realtime: 'Real-time' };
  const MODE_HELP = {
    turns: 'Players take turns, each with a personal clock.',
    realtime: 'No turns: place whenever you like, with a 3 s cooldown after each piece (none after a line clear).',
  };

  // §26: the host picks 2 or 4 players; everyone else sees the choice.
  function renderPlayersRow() {
    const row = $('playersRow');
    row.innerHTML = '';
    row.appendChild(span('label', 'Players:'));
    if (ctl.isHost) {
      for (const count of [4, 2]) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = String(count);
        if (ctl.lobbyPlayers === count) btn.className = 'on';
        btn.addEventListener('click', () => ctl.setPlayers(count));
        row.appendChild(btn);
      }
    } else {
      row.appendChild(span('', `${ctl.lobbyPlayers} (chosen by the host)`));
    }
    const help = document.createElement('p');
    help.className = 'mode-help';
    help.textContent = ctl.lobbyPlayers === 2
      ? 'Two players on opposite sides (South vs North); the other two sides stay empty.'
      : 'Four players, one on each side of the board.';
    row.appendChild(help);
  }

  // The host picks the mode; everyone else sees the choice.
  function renderModeRow() {
    const row = $('modeRow');
    row.innerHTML = '';
    row.appendChild(span('label', 'Mode:'));
    if (ctl.isHost) {
      for (const mode of [C.REALTIME, C.TURNS]) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = MODE_NAMES[mode];
        if (ctl.lobbyMode === mode) btn.className = 'on';
        btn.addEventListener('click', () => ctl.setMode(mode));
        row.appendChild(btn);
      }
    } else {
      row.appendChild(span('', `${MODE_NAMES[ctl.lobbyMode]} (chosen by the host)`));
    }
    const help = document.createElement('p');
    help.className = 'mode-help';
    help.textContent = MODE_HELP[ctl.lobbyMode];
    row.appendChild(help);
  }

  // --- Actions ------------------------------------------------------------------

  const isRealtimeGame = () => Boolean(ui.state && ui.state.config.mode === C.REALTIME);

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
    if (seat === null || ui.selected === null || cell === null || ui.viewIndex !== null) return null;
    const piece = ui.state.players[seat].hand[ui.selected];
    const rotation = boardRotation();
    const offsets = P.ROTATIONS[piece][rotation];
    const h = Math.max(...offsets.map(([r]) => r)) + 1;
    const w = Math.max(...offsets.map(([, c]) => c)) + 1;
    const y = Math.floor(cell / C.SIZE) - Math.floor((h - 1) / 2);
    const x = (cell % C.SIZE) - Math.floor((w - 1) / 2);
    const cells = offsets
      .map(([r, c]) => [y + r, x + c])
      .filter(([r, c]) => C.inBounds(r, c))
      .map(([r, c]) => C.idx(r, c));
    const exact = B.pieceCells(piece, rotation, x, y);
    const rainbow = Boolean(ui.state.players[seat].rainbow && ui.state.players[seat].rainbow[ui.selected]);
    const legal = B.isLegalPlacement(ui.state.owner, seat, exact, rainbow);
    return { x, y, rotation, cells, legal };
  }

  function place(cell) {
    if (ui.viewIndex !== null) {
      setMessage('You are looking at an earlier move. Press ⏭ (or End) to go back to the live game.', true);
      render();
      return;
    }
    const placement = placementAt(cell);
    if (!placement) return;
    if (!ctl.canPlace()) {
      // Real-time: the hint already counts the cooldown down, so no extra message.
      if (!isRealtimeGame()) setMessage('Wait for your turn to place it.', true);
      render();
      return;
    }
    ctl.move({ handIndex: ui.selected, rotation: placement.rotation, x: placement.x, y: placement.y });
  }

  // --- Point of view -------------------------------------------------------------
  // The board is drawn turned so the viewer's own edge is at the bottom. Turning
  // from one seat to the next (South -> West -> North -> East) is a quarter turn:
  // board cell (r, c) is drawn at screen (10 - c, r). The server and the core
  // only ever use board coordinates.

  // Online the viewer is always you. In hot-seat it is whoever's turn is live;
  // during the pause between turns the view stays with the player who just moved.
  function updateViewSeat() {
    const s = ui.state;
    const fixed = ctl.fixedViewSeat();
    if (fixed !== null && fixed !== undefined) ui.viewSeat = fixed;
    else if (s.phase === 'turn' && s.turnStartedAt !== null) ui.viewSeat = s.activeSeat;
    else if (ui.viewSeat === null) ui.viewSeat = s.activeSeat !== null ? s.activeSeat : 0;
  }

  // boardOfScreen[v][p] = board cell drawn at screen position p for viewer seat v.
  const boardOfScreen = [0, 1, 2, 3].map((v) => {
    const map = [];
    for (let p = 0; p < C.CELL_COUNT; p++) {
      let r = Math.floor(p / C.SIZE);
      let c = p % C.SIZE;
      for (let k = 0; k < v; k++) [r, c] = [c, C.SIZE - 1 - r];
      map.push(C.idx(r, c));
    }
    return map;
  });
  const screenOfBoard = boardOfScreen.map((map) => {
    const inverse = [];
    map.forEach((b, p) => {
      inverse[b] = p;
    });
    return inverse;
  });
  const view = () => (ui.viewSeat === null ? 0 : ui.viewSeat);

  // Which seat sits along each screen edge for the current viewer.
  const seatAt = (side) => (view() + { bottom: 0, left: 1, top: 2, right: 3 }[side]) % 4;

  // The board is drawn turned a quarter anticlockwise per seat, so a piece the
  // viewer sees at rotation k is rotation k + viewer seat in board terms.
  const boardRotation = () => (ui.rotation + view()) % 4;

  // --- Board rendering ------------------------------------------------------------

  const cellEls = []; // indexed by screen position
  function buildBoard() {
    for (let p = 0; p < C.CELL_COUNT; p++) {
      const div = document.createElement('div');
      div.className = 'cell';
      div.dataset.p = p;
      el.board.appendChild(div);
      cellEls.push(div);
    }
    const boardCellOf = (target) =>
      target.dataset && target.dataset.p !== undefined ? boardOfScreen[view()][Number(target.dataset.p)] : null;
    el.board.addEventListener('mousemove', (e) => {
      const cell = boardCellOf(e.target);
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
      const cell = boardCellOf(e.target);
      if (ui.state && cell !== null) place(cell);
    });
    el.board.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      rotate(1);
    });
  }

  // `board` is the live game, or a move-history entry when looking back.
  function cellStyle(i, board) {
    const s = ui.state;
    const owner = board.owner[i];
    const hp = board.hp[i];
    if (owner === C.BLOCKED) return { className: 'cell blocked', background: '', shadow: '', text: '' };
    if (owner === C.EMPTY) return { className: 'cell', background: '', shadow: '', text: '' };
    if (owner === C.RAINBOW) {
      return { className: 'cell rainbow-block', background: 'var(--rainbow)', shadow: '', text: '' };
    }
    if (owner === C.GREY) {
      return { className: 'cell', background: `hsl(0, 0%, ${GREY_LIGHTNESS[hp]}%)`, shadow: '', text: '' };
    }
    const hue = HUES[owner];
    const l = HP_LIGHTNESS[hp];
    if (s.players[owner].status === C.TIMED_OUT) {
      // Dulled: hollow outline in a washed-out version of the owner's colour.
      return {
        className: 'cell dulled',
        background: `repeating-linear-gradient(45deg, hsla(${hue}, 20%, ${l}%, 0.35) 0 3px, transparent 3px 7px)`,
        shadow: `inset 0 0 0 3px hsl(${hue}, 22%, ${l}%)`,
        text: '',
      };
    }
    return { className: 'cell', background: `hsl(${hue}, 65%, ${l}%)`, shadow: '', text: '' };
  }

  function renderBoard() {
    const placement = placementAt(ui.hover);
    const preview = new Set(placement ? placement.cells : []);
    const map = boardOfScreen[view()];
    for (const [side, prop] of [['top', '--edge-top'], ['bottom', '--edge-bottom'], ['left', '--edge-left'], ['right', '--edge-right']]) {
      const edgeSeat = seatAt(side);
      const empty = ui.state.players[edgeSeat].status === C.ABSENT;
      el.board.style.setProperty(prop, empty ? 'var(--line)' : `hsl(${HUES[edgeSeat]}, 60%, 50%)`);
    }
    // Looking back shows that history entry; live shows the game. Either way
    // the move that produced the board is highlighted.
    const viewing = ui.viewIndex !== null ? ui.history[ui.viewIndex] : null;
    const board = viewing || ui.state;
    const shown = viewing || ui.history[ui.history.length - 1];
    const highlight = new Set(shown ? shown.cells : []);
    el.board.classList.toggle('history-view', Boolean(viewing));
    for (let p = 0; p < C.CELL_COUNT; p++) {
      const i = map[p];
      const style = cellStyle(i, board);
      const div = cellEls[p];
      let className = style.className;
      if (highlight.has(i)) className += ' last-move';
      if (preview.has(i)) className += placement.legal ? ' preview legal' : ' preview illegal';
      if (div.classList.contains('flash')) className += ' flash';
      div.className = className;
      div.style.background = style.background;
      div.style.boxShadow = style.shadow;
      div.textContent = style.text;
    }
  }

  // --- Move history bar ------------------------------------------------------------

  function renderHistoryBar() {
    const n = ui.history.length - 1; // number of moves (entry 0 is the start)
    const label = $('histLabel');
    if (ui.viewIndex === null) {
      label.textContent = n > 0 ? `Live · ${n} move${n === 1 ? '' : 's'} so far` : 'Live · no moves yet';
    } else if (ui.viewIndex === 0) {
      label.textContent = `Start of the game · move 0 of ${n}`;
    } else {
      const entry = ui.history[ui.viewIndex];
      label.textContent = `Move ${ui.viewIndex} of ${n}: ${who(entry.seat)} placed ${pieceName(entry.piece)}`;
    }
    label.classList.toggle('viewing', ui.viewIndex !== null);
    const at = ui.viewIndex === null ? n : ui.viewIndex;
    $('histFirst').disabled = at <= 0;
    $('histPrev').disabled = at <= 0;
    $('histNext').disabled = ui.viewIndex === null;
    $('histLast').disabled = ui.viewIndex === null;
  }

  // Moves through the history; going past the newest entry returns to live.
  function stepHistory(where) {
    if (!ui.state || ui.history.length === 0) return;
    const last = ui.history.length - 1;
    const at = ui.viewIndex === null ? last : ui.viewIndex;
    let next;
    if (where === 'first') next = 0;
    else if (where === 'last') next = null;
    else if (where === 'prev') next = Math.max(0, at - 1);
    else next = at + 1 >= last ? null : at + 1;
    ui.viewIndex = next;
    setMessage('');
    render();
  }

  function flash(cells) {
    if (ui.viewIndex !== null) return; // looking back: live changes don't flash
    for (const i of cells) {
      const div = cellEls[screenOfBoard[view()][i]];
      div.classList.remove('flash');
      void div.offsetWidth; // restart the animation
      div.classList.add('flash');
      setTimeout(() => div.classList.remove('flash'), 600);
    }
  }

  // --- Players ------------------------------------------------------------------

  function miniPiece(piece, rotation, hue, rainbow = false) {
    const offsets = P.ROTATIONS[piece][rotation];
    const h = Math.max(...offsets.map(([r]) => r)) + 1;
    const w = Math.max(...offsets.map(([, c]) => c)) + 1;
    const filled = new Set(offsets.map(([r, c]) => `${r},${c}`));
    const grid = document.createElement('div');
    grid.className = 'mini';
    grid.style.gridTemplateColumns = `repeat(${w}, var(--mini, 9px))`;
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        const d = document.createElement('div');
        if (filled.has(`${r},${c}`)) d.style.background = rainbow ? 'var(--rainbow)' : `hsl(${hue}, 65%, 55%)`;
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

  // One panel beside each edge of the board: the viewer's own (large, with the
  // playable hand and the shuffle button) below it, the others at their edges.
  function renderPanels() {
    const s = ui.state;
    const live = liveSeat();
    const controlled = ctl.controlledSeat();
    for (const side of ['bottom', 'left', 'top', 'right']) {
      const p = s.players[seatAt(side)];
      const hue = HUES[p.seat];
      const isActive = live === p.seat;
      const isMine = controlled === p.seat;
      const card = el.panels[side];
      card.innerHTML = '';
      if (p.status === C.ABSENT) {
        card.className = `seat-panel ${side} out empty-side`;
        card.style.setProperty('--hue', 0);
        card.appendChild(span('player-seat', `${SEATS[p.seat].name}: empty side`));
        timerEls[p.seat] = null;
        continue;
      }
      card.className = `seat-panel ${side}${side === 'bottom' ? ' mine' : ''}${isActive ? ' active' : ''}${p.status !== C.ALIVE ? ' out' : ''}`;
      card.style.setProperty('--hue', hue);

      const head = document.createElement('div');
      head.className = 'player-head';
      const name = span('player-name', ctl.seatLabel(p.seat));
      if (ctl.fixedViewSeat() !== null) {
        const tags = [SEATS[p.seat].name];
        if (ctl.isBotSeat(p.seat)) tags.push('bot');
        if (p.seat === ctl.fixedViewSeat()) tags.push('you');
        name.appendChild(span('player-seat', tags.join(' · ')));
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
      card.append(head, meta);
      if (!isRealtimeGame()) card.appendChild(afk); // real-time has no turns, so no AFK timer

      // Real-time: a 3, 2, 1 countdown badge beside the hand while cooling down.
      const badge = span('cooldown-badge', '');
      badge.hidden = !isRealtimeGame() || p.status !== C.ALIVE;
      badge.title = 'Cooldown before this player can place again';
      timerEls[p.seat] = { clock, afk: fill, isActive, badge };

      const hand = document.createElement('div');
      hand.className = 'hand';
      p.hand.forEach((piece, k) => {
        const slot = document.createElement('div');
        const selected = isMine && ui.selected === k;
        const special = P.poolFor(s.config).special.includes(piece);
        const rainbow = Boolean(p.rainbow && p.rainbow[k]);
        slot.className = `hand-slot${isMine ? ' clickable' : ''}${selected ? ' selected' : ''}${special ? ' special' : ''}${rainbow ? ' rainbow' : ''}`;
        const label = `${rainbow ? 'Rainbow ' : ''}${pieceName(piece)}${special ? ' (special)' : ''}${rainbow ? ' — place it anywhere touching any block' : ''}`;
        slot.title = isMine ? `${label} — press ${k + 1}` : label;
        slot.appendChild(miniPiece(piece, selected ? ui.rotation : 0, hue, rainbow));
        if (isMine) slot.addEventListener('click', () => selectPiece(k));
        hand.appendChild(slot);
      });
      const handRow = document.createElement('div');
      handRow.className = 'hand-row';
      handRow.append(hand, badge);
      card.appendChild(handRow);

      if (p.status === C.ALIVE && p.shuffleAvailable && ctl.canShuffle(p.seat)) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'shuffle-btn';
        btn.textContent = side === 'bottom' ? 'Shuffle hand (offer available)' : 'Shuffle';
        btn.addEventListener('click', () => ctl.shuffle(p.seat));
        card.appendChild(btn);
      }
    }
  }

  // --- Top bar, hint, overlay -------------------------------------------------------

  function renderTimers(now) {
    const s = ui.state;
    // While paused online, every clock shows the moment the game was paused.
    const t = s.pausedAt !== null ? s.pausedAt : now;
    const realtime = isRealtimeGame();
    for (const p of s.players) {
      const refs = timerEls[p.seat];
      if (!refs) continue;
      if (realtime) {
        // No personal clocks: show the cooldown instead (3, 2, 1, then ready).
        refs.clock.textContent = '';
        const left = p.cooldownUntil - t;
        const cooling = !s.over && left > 0;
        refs.badge.textContent = cooling ? String(Math.ceil(left / 1000)) : '✓';
        refs.badge.classList.toggle('cooling', cooling);
        refs.badge.classList.toggle('ready', !cooling && !s.over);
        continue;
      }
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
    else if (realtime) {
      status = 'Real-time · place whenever you are ready';
      renderHint(); // the hint follows the cooldown, which changes without a new state
    } else if (s.phase === 'shuffleWindow') {
      status = `Everyone is stuck — shuffle window ${fmtSeconds(s.shuffleWindowEndsAt - t)} s`;
    } else if (s.phase === 'interlude') {
      const next = s.activeSeat === ctl.fixedViewSeat() ? 'Your turn' : `${ctl.seatLabel(s.activeSeat)}'s turn`;
      status = `Round ${s.round} · ${next} in ${fmtSeconds(s.interludeEndsAt - t)} s`;
    } else if (s.activeSeat === ctl.fixedViewSeat()) {
      status = `Round ${s.round} · Your turn`;
    } else {
      status = `Round ${s.round} · ${ctl.seatLabel(s.activeSeat)} to play`;
    }
    if (ctl.mode === 'local' && ctl.paused) status += ' · PAUSED';
    if (s.pausedAt !== null && !s.over) {
      status = `Paused by ${ctl.seatLabel(s.pausedBy)} — only they or the host can resume`;
    }
    el.status.textContent = status;
    el.pauseBtn.textContent = ctl.paused ? 'Resume' : 'Pause';
    el.pauseBtn.disabled = s.over || (ctl.mode === 'online' && ctl.paused && !ctl.canUnpause());
    el.pauseBtn.title = ctl.mode === 'online'
      ? 'Pause the game for everyone (P). Only you or the host can resume it.'
      : 'Freeze all clocks (P)';
    el.soundBtn.textContent = sound.muted ? 'Sound: off' : 'Sound: on';
  }

  function renderHint() {
    let text = ui.message;
    if (!text) {
      const s = ui.state;
      const seat = ctl.controlledSeat();
      if (s.over) text = '';
      else if (ctl.fixedViewSeat() === null && s.phase === 'interlude') {
        text = `Next up: ${SEATS[s.activeSeat].name}. The board turns to face them when their turn starts.`;
      } else if (seat === null) {
        text = ctl.fixedViewSeat() !== null ? 'You are out of the game — watching.' : 'Waiting for the shuffle window to close.';
      } else if (isRealtimeGame()) {
        const left = s.players[seat].cooldownUntil - ctl.now();
        if (left > 0) text = `Cooling down (${Math.ceil(left / 1000)}): pick and rotate your next piece meanwhile.`;
        else if (ui.selected === null) text = 'Ready: pick a piece and place it. Clear a line to skip the cooldown.';
        else text = 'Hover over the board and click to place. R rotates.';
      } else if (!ctl.canPlace()) {
        text = 'Not your turn yet: you can pick, rotate and preview a piece while you wait.';
      } else if (ui.selected === null) {
        text = ctl.fixedViewSeat() !== null ? 'Your turn: pick a piece from your hand.' : `${SEATS[seat].name}: pick a piece from your hand.`;
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
      case 'gameStarted': return `${e.mode === 'realtime' ? 'Real-time' : 'Turn-based'} game started (10:00 on the clock).`;
      case 'turnStarted': return `${who(e.seat)}'s turn.`;
      case 'placed': return `${who(e.seat)} placed ${e.rainbow ? 'a rainbow ' : ''}${pieceName(e.piece)} at ${cellName(e.cells[0])}.`;
      case 'lineClearBonus': return `${who(e.seat)} gains +${e.ms / 1000} s for ${e.lines} line clear(s) (up to the cap).`;
      case 'rewardPiece': return `${who(e.seat)} earned a special piece for the line clear: ${pieceName(e.piece)}.`;
      case 'linesCompleted': return `Line clear: ${e.lines.map(lineName).join(', ')}.`;
      case 'hit': return null;
      case 'destroyed': {
        const pts = e.cells.reduce((sum, d) => sum + d.points, 0);
        return `${e.cells.length} block(s) destroyed by the clear: +${pts} to ${who(e.scorer)}.`;
      }
      case 'detonated': return `${e.cells.length} cut-off ${e.rainbow ? 'rainbow ' : ''}block(s) detonated: +${e.points} to ${who(e.scorer)}.`;
      case 'converted': return `${e.cells.length} block(s) converted to ${who(e.to)} (+${e.points}).`;
      case 'greyed': return `${e.cells.length} block(s) turned grey.`;
      case 'scored': return null;
      case 'interlude': return null;
      case 'cooldown': return null;
      case 'shuffleOffered': return `${who(e.seat)} has no legal move: a shuffle is available.`;
      case 'clockHalved': {
        const left = Math.max(0, Math.round((e.endsAt - e.at) / 1000));
        return `A player is out: the game clock is halved (${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} left).`;
      }
      case 'paused': return `${who(e.seat)} paused the game.`;
      case 'resumed': return `${who(e.seat)} resumed the game after ${Math.round(e.pausedMs / 1000)} s.`;
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
    el.newGameBtn.hidden = ctl.mode !== 'local';
    renderBoard();
    renderPanels();
    renderHint();
    renderOverlay();
    renderHistoryBar();
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
    else if (e.key === 'p' || e.key === 'P') ctl.togglePause();
    else if (e.key === 'm' || e.key === 'M') toggleSound();
    else if (e.key === 'ArrowLeft') stepHistory('prev');
    else if (e.key === 'ArrowRight') stepHistory('next');
    else if (e.key === 'Home') stepHistory('first');
    else if (e.key === 'End') stepHistory('last');
  });

  function toggleSound() {
    sound.toggle();
    if (ui.state && ctl) renderTimers(ctl.now());
  }

  // Browsers only start audio after a user gesture: unlock it on any input.
  document.addEventListener('pointerdown', () => sound.unlock());
  document.addEventListener('keydown', () => sound.unlock());

  // --- Wiring ---------------------------------------------------------------------

  // Local games: the menu's 2 / 4 players choice (§26) also relabels the buttons.
  const localPlayers = () => Number(document.querySelector('input[name="localPlayers"]:checked').value);
  function relabelLocalButtons() {
    const n = localPlayers();
    const bots = n === 2 ? '1 easy bot' : '3 easy bots';
    $('vsBotsBtn').textContent = `Play vs ${bots} — turn-based`;
    $('vsBotsRealtimeBtn').textContent = `Play vs ${bots} — real-time`;
    $('hotseatBtn').textContent = `Local hot-seat (${n} players, 1 screen)`;
  }
  for (const radio of document.querySelectorAll('input[name="localPlayers"]')) {
    radio.addEventListener('change', relabelLocalButtons);
  }

  $('hotseatBtn').addEventListener('click', () => {
    ctl = createLocalController({ playerCount: localPlayers() });
    ctl.start();
  });
  $('vsBotsBtn').addEventListener('click', () => {
    ctl = createLocalController({ bots: true, playerCount: localPlayers() });
    ctl.start();
  });
  $('vsBotsRealtimeBtn').addEventListener('click', () => {
    ctl = createLocalController({ bots: true, mode: C.REALTIME, playerCount: localPlayers() });
    ctl.start();
  });
  $('addBotBtn').addEventListener('click', () => ctl && ctl.mode === 'online' && ctl.addBot());
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
  el.pauseBtn.addEventListener('click', () => ctl && ctl.togglePause());
  el.soundBtn.addEventListener('click', toggleSound);
  $('histFirst').addEventListener('click', () => stepHistory('first'));
  $('histPrev').addEventListener('click', () => stepHistory('prev'));
  $('histNext').addEventListener('click', () => stepHistory('next'));
  $('histLast').addEventListener('click', () => stepHistory('last'));

  // Rulebook drawer, reachable from every screen.
  function setRulesOpen(open) {
    $('rulesDrawer').hidden = !open;
    $('rulesTab').setAttribute('aria-expanded', String(open));
  }
  $('rulesTab').addEventListener('click', () => setRulesOpen($('rulesDrawer').hidden));
  $('rulesClose').addEventListener('click', () => setRulesOpen(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('rulesDrawer').hidden) setRulesOpen(false);
  });
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
