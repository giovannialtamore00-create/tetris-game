'use strict';

// Local hot-seat client: all four seats play in this one browser tab. The game
// core (window.TetrisCore) holds every rule; this file only renders its state
// and turns clicks and keys into core actions.

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

  const $ = (id) => document.getElementById(id);
  const el = {
    board: $('board'),
    players: $('players'),
    log: $('log'),
    gameClock: $('gameClock'),
    status: $('status'),
    hint: $('hint'),
    pauseBtn: $('pauseBtn'),
    overlay: $('overlay'),
    overlayReason: $('overlayReason'),
    standings: $('standings'),
  };

  // --- Virtual time -------------------------------------------------------
  // The core only ever sees `now` from here. Pausing freezes it, which is a
  // local testing convenience, not a game rule.

  const time = { virtual: 0, lastReal: performance.now(), paused: false };

  function now() {
    const t = performance.now();
    if (!time.paused) time.virtual += t - time.lastReal;
    time.lastReal = t;
    return Math.floor(time.virtual);
  }

  // --- UI state -------------------------------------------------------------

  const ui = {
    state: null,
    selected: null, // hand index of the picked-up piece
    rotation: 0,
    hover: null, // board cell index under the pointer
    message: '',
    messageIsError: false,
    overlayDismissed: false,
  };

  function newGame() {
    time.virtual = 0;
    time.lastReal = performance.now();
    const seed = Math.floor(Math.random() * 2 ** 31);
    const result = game.createGame({ seed, now: 0 });
    ui.state = result.state;
    ui.selected = null;
    ui.rotation = 0;
    ui.overlayDismissed = false;
    el.log.innerHTML = '';
    logEvents([{ type: 'note', text: `New game (seed ${seed})` }, ...result.events], 0);
    setMessage('');
    render();
  }

  // Applies expired deadlines. Must run before every action (the core rejects
  // actions with 'tickRequired' otherwise) and on every frame.
  function runTick(t) {
    if (ui.state.over) return;
    const result = game.tick(ui.state, t);
    if (result.events.length > 0) {
      ui.state = result.state;
      afterEvents(result.events, t);
      render();
    }
  }

  function act(fn, successMessage = '') {
    const t = now();
    runTick(t);
    const result = fn(ui.state, t);
    if (!result.ok) {
      setMessage(ERRORS[result.error] || result.error, true);
    } else {
      ui.state = result.state;
      setMessage(successMessage);
      afterEvents(result.events, t);
    }
    render();
    return result.ok;
  }

  function afterEvents(events, t) {
    logEvents(events, t);
    if (events.some((e) => ['turnStarted', 'passed', 'timedOut', 'gameOver', 'shuffleWindowOpened'].includes(e.type))) {
      ui.selected = null;
      ui.rotation = 0;
    }
    const flashCells = [];
    for (const e of events) {
      if (e.type === 'destroyed') flashCells.push(...e.cells.map((d) => d.cell));
      if (e.type === 'detonated' || e.type === 'converted' || e.type === 'greyed') flashCells.push(...e.cells);
    }
    if (flashCells.length > 0) flash(flashCells);
  }

  const ERRORS = {
    illegalPlacement: 'Not a legal placement: every cell must be empty and one must touch your own block.',
    notYourTurn: 'It is not that player\'s turn.',
    noShuffleAvailable: 'No shuffle offer available.',
    notAlive: 'That player is out of the game.',
    gameOver: 'The game is over.',
    tickRequired: 'A deadline just passed — try again.',
  };

  function setMessage(text, isError = false) {
    ui.message = text;
    ui.messageIsError = isError;
  }

  // --- Actions ------------------------------------------------------------------

  function activePlayer() {
    const s = ui.state;
    return s.phase === 'turn' && s.turnStartedAt !== null ? s.players[s.activeSeat] : null;
  }

  function selectPiece(handIndex) {
    const p = activePlayer();
    if (!p) return;
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

  // Offsets of the picked-up piece, positioned so the pointer sits near its centre.
  function placementAt(cell) {
    const p = activePlayer();
    if (!p || ui.selected === null || cell === null) return null;
    const piece = p.hand[ui.selected];
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
    const legal = B.isLegalPlacement(ui.state.owner, p.seat, exact);
    return { x, y, cells, legal };
  }

  function place(cell) {
    const p = activePlayer();
    const placement = placementAt(cell);
    if (!p || !placement) return;
    const move = { handIndex: ui.selected, rotation: ui.rotation, x: placement.x, y: placement.y };
    act((s, t) => game.applyMove(s, p.seat, move, t));
  }

  function shuffleHand(seat) {
    act((s, t) => game.shuffle(s, seat, t), `${SEATS[seat].name} shuffled their hand.`);
  }

  // --- Board rendering --------------------------------------------------------

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
        renderBoard();
      }
    });
    el.board.addEventListener('mouseleave', () => {
      ui.hover = null;
      renderBoard();
    });
    el.board.addEventListener('click', (e) => {
      if (e.target.dataset && e.target.dataset.i !== undefined) place(Number(e.target.dataset.i));
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

  // --- Players ----------------------------------------------------------------

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

  const PIECE_NAMES = { M: '1×1', D: '1×2', L3: 'small L' };
  const pieceName = (piece) => PIECE_NAMES[piece] || piece;

  const fmtSeconds = (ms) => (Math.max(0, ms) / 1000).toFixed(1);
  const STATUS_TEXT = { alive: 'alive', eliminated: 'eliminated', timedOut: 'timed out' };

  // Rebuilt only when the state or selection changes; the per-frame clock
  // readouts are updated in place by renderTimers().
  const timerEls = [];

  function renderPlayers() {
    const s = ui.state;
    const live = activePlayer();
    el.players.innerHTML = '';
    for (const p of s.players) {
      const hue = HUES[p.seat];
      const isActive = live && live.seat === p.seat;
      const card = document.createElement('div');
      card.className = `player${isActive ? ' active' : ''}${p.status !== C.ALIVE ? ' out' : ''}`;
      card.style.setProperty('--hue', hue);
      card.innerHTML = `
        <div class="player-head">
          <span class="player-name">${SEATS[p.seat].name}</span>
          <span class="player-score">${p.score}</span>
        </div>
        <div class="player-meta">
          <span>${STATUS_TEXT[p.status]} · ${B.countBlocks(s.owner, p.seat)} blocks</span>
          <span class="player-clock"></span>
        </div>`;

      const afk = document.createElement('div');
      afk.className = `afk-bar${isActive ? '' : ' hidden'}`;
      afk.title = 'AFK timer';
      const fill = document.createElement('div');
      afk.appendChild(fill);
      card.appendChild(afk);
      timerEls[p.seat] = { clock: card.querySelector('.player-clock'), afk: fill, isActive };

      const hand = document.createElement('div');
      hand.className = 'hand';
      p.hand.forEach((piece, k) => {
        const slot = document.createElement('div');
        const selected = isActive && ui.selected === k;
        const special = P.SPECIAL_PIECES.includes(piece);
        slot.className = `hand-slot${isActive ? ' clickable' : ''}${selected ? ' selected' : ''}${special ? ' special' : ''}`;
        const label = `${pieceName(piece)}${special ? ' (special)' : ''}`;
        slot.title = isActive ? `${label} — press ${k + 1}` : label;
        slot.appendChild(miniPiece(piece, selected ? ui.rotation : 0, hue));
        if (isActive) slot.addEventListener('click', () => selectPiece(k));
        hand.appendChild(slot);
      });
      card.appendChild(hand);

      if (p.status === C.ALIVE && p.shuffleAvailable) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'shuffle-btn';
        btn.textContent = 'Shuffle hand (offer available)';
        btn.addEventListener('click', () => shuffleHand(p.seat));
        card.appendChild(btn);
      }
      el.players.appendChild(card);
    }
  }

  // --- Top bar, hint, overlay -------------------------------------------------

  function renderTimers(t) {
    const s = ui.state;
    for (const p of s.players) {
      const refs = timerEls[p.seat];
      if (!refs) continue;
      const elapsed = refs.isActive && !s.over ? t - s.turnStartedAt : 0;
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
    } else status = `Round ${s.round} · ${SEATS[s.activeSeat].name} to play`;
    if (time.paused) status += ' · PAUSED';
    el.status.textContent = status;
    el.pauseBtn.textContent = time.paused ? 'Resume' : 'Pause';
  }

  function renderHint() {
    let text = ui.message;
    if (!text) {
      const p = activePlayer();
      if (ui.state.over) text = '';
      else if (!p) text = 'Waiting for the shuffle window to close.';
      else if (ui.selected === null) text = `${SEATS[p.seat].name}: pick a piece from your hand.`;
      else text = `${SEATS[p.seat].name}: hover over the board and click to place. R rotates.`;
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
    const names = r.winners.map((seat) => SEATS[seat].name).join(' and ');
    const why = r.reason === 'timeUp' ? 'The 10-minute game clock ran out.' : 'Only one player is left alive.';
    el.overlayReason.textContent = `${why} ${r.draw ? `Draw between ${names}.` : `${names} wins.`}`;
    el.standings.innerHTML = r.standings
      .map(
        (row) => `<tr class="${row.rank === 1 ? 'winner' : ''}">
          <td>${row.rank}</td><td>${SEATS[row.seat].name}</td><td>${row.score}</td>
          <td>${STATUS_TEXT[row.status]}</td><td>${row.blocks}</td></tr>`,
      )
      .join('');
  }

  // --- Event log --------------------------------------------------------------

  const cellName = (i) => `(${Math.floor(i / C.SIZE)},${i % C.SIZE})`;
  const who = (seat) => (seat >= 0 ? SEATS[seat].name : 'grey');
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

  function logEvents(events, t) {
    for (const e of events) {
      const text = describe(e);
      if (!text) continue;
      const li = document.createElement('li');
      const at = e.at !== undefined ? e.at : t;
      li.innerHTML = `<span class="t">${fmtClock(at)}</span>`;
      li.appendChild(document.createTextNode(text));
      el.log.prepend(li);
    }
    while (el.log.children.length > 200) el.log.lastChild.remove();
  }

  const fmtClock = (ms) => {
    const total = Math.floor(ms / 1000);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  };

  // --- Main loop --------------------------------------------------------------

  function render() {
    renderBoard();
    renderPlayers();
    renderHint();
    renderOverlay();
    renderTimers(now());
  }

  // Every 100 ms: apply expired deadlines (which re-renders on any change),
  // then refresh the clock readouts.
  function frame() {
    const t = now();
    runTick(t);
    renderTimers(t);
  }

  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (e.key === 'r' || e.key === 'R') rotate(e.shiftKey ? -1 : 1);
    else if (e.key === 'Escape') {
      ui.selected = null;
      render();
    } else if (['1', '2', '3', '4'].includes(e.key)) selectPiece(Number(e.key) - 1);
    else if (e.key === 'p' || e.key === 'P') togglePause();
  });

  function togglePause() {
    now();
    time.paused = !time.paused;
    render();
  }

  el.pauseBtn.addEventListener('click', togglePause);
  $('newGameBtn').addEventListener('click', newGame);
  $('overlayNew').addEventListener('click', newGame);
  $('overlayClose').addEventListener('click', () => {
    ui.overlayDismissed = true;
    render();
  });

  buildBoard();
  newGame();
  setInterval(frame, 100);
})();
