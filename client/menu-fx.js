// Menu effects: block capitals on menu buttons, and the animated backdrop
// behind the arcade cabinet. Purely visual; the game never reads this.
(function () {
  'use strict';

  // ---- Block letters: button labels drawn in capitals made of blocks, 5 tall ----
  const GLYPHS = {
    A: ['.##.', '#..#', '####', '#..#', '#..#'],
    B: ['###.', '#..#', '###.', '#..#', '###.'],
    C: ['.###', '#...', '#...', '#...', '.###'],
    D: ['###.', '#..#', '#..#', '#..#', '###.'],
    E: ['####', '#...', '###.', '#...', '####'],
    F: ['####', '#...', '###.', '#...', '#...'],
    G: ['.###', '#...', '#.##', '#..#', '.###'],
    H: ['#..#', '#..#', '####', '#..#', '#..#'],
    I: ['###', '.#.', '.#.', '.#.', '###'],
    J: ['..##', '...#', '...#', '#..#', '.##.'],
    K: ['#..#', '#.#.', '##..', '#.#.', '#..#'],
    L: ['#...', '#...', '#...', '#...', '####'],
    M: ['#...#', '##.##', '#.#.#', '#...#', '#...#'],
    N: ['#..#', '##.#', '#.##', '#..#', '#..#'],
    O: ['.##.', '#..#', '#..#', '#..#', '.##.'],
    P: ['###.', '#..#', '###.', '#...', '#...'],
    Q: ['.##.', '#..#', '#..#', '#.#.', '.#.#'],
    R: ['###.', '#..#', '###.', '#.#.', '#..#'],
    S: ['.###', '#...', '.##.', '...#', '###.'],
    T: ['###', '.#.', '.#.', '.#.', '.#.'],
    U: ['#..#', '#..#', '#..#', '#..#', '.##.'],
    V: ['#...#', '#...#', '#...#', '.#.#.', '..#..'],
    W: ['#...#', '#...#', '#.#.#', '##.##', '#...#'],
    X: ['#...#', '.#.#.', '..#..', '.#.#.', '#...#'],
    Y: ['#...#', '.#.#.', '..#..', '..#..', '..#..'],
    Z: ['####', '...#', '.##.', '#...', '####'],
    0: ['.##.', '#..#', '#..#', '#..#', '.##.'],
    1: ['.#.', '##.', '.#.', '.#.', '###'],
    2: ['###.', '...#', '.##.', '#...', '####'],
    3: ['###.', '...#', '.##.', '...#', '###.'],
    4: ['#..#', '#..#', '####', '...#', '...#'],
    '!': ['#', '#', '#', '.', '#'],
  };
  const SVG = 'http://www.w3.org/2000/svg';

  function blockLetter(ch) {
    const rows = GLYPHS[ch];
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('class', 'bl');
    svg.setAttribute('viewBox', `0 0 ${rows[0].length * 10 - 1} 49`);
    svg.setAttribute('aria-hidden', 'true');
    rows.forEach((row, y) => [...row].forEach((c, x) => {
      if (c !== '#') return;
      const r = document.createElementNS(SVG, 'rect');
      r.setAttribute('x', x * 10); r.setAttribute('y', y * 10);
      r.setAttribute('width', 9); r.setAttribute('height', 9); r.setAttribute('rx', 1.5);
      svg.appendChild(r);
    }));
    return svg;
  }

  // Text as block letters, one word per unbreakable group.
  function blockWords(text) {
    const frag = document.createDocumentFragment();
    for (const word of text.trim().toUpperCase().split(/\s+/).filter(Boolean)) {
      const group = document.createElement('span');
      group.className = 'bw';
      for (const ch of word) group.appendChild(GLYPHS[ch] ? blockLetter(ch) : document.createTextNode(ch));
      frag.appendChild(group);
    }
    return frag;
  }

  // Set a button's whole label in block letters (skipped when unchanged).
  function blockText(btn, text) {
    if (btn.dataset.label === text) return;
    btn.dataset.label = text;
    btn.setAttribute('aria-label', text);
    btn.replaceChildren(blockWords(text));
  }

  for (const btn of document.querySelectorAll('.menu-card button, .topbar .controls button')) {
    btn.setAttribute('aria-label', btn.textContent.replace(/\s+/g, ' ').trim());
    const host = btn.querySelector(':scope > span') || btn;
    for (const n of [...host.childNodes]) {
      if (n.nodeType === Node.TEXT_NODE && n.textContent.trim()) n.replaceWith(blockWords(n.textContent));
    }
  }

  // ---- Commentary: big block words beside the board, alternating sides ----
  const slots = [document.getElementById('commentLeft'), document.getElementById('commentRight')];
  let nextSlot = 0;
  function comment(text, hue) {
    const slot = slots[nextSlot];
    nextSlot = 1 - nextSlot;
    if (!slot) return;
    const word = document.createElement('div');
    word.className = 'comment';
    word.style.setProperty('--hue', Number.isFinite(hue) ? hue : 45);
    word.setAttribute('role', 'status');
    word.setAttribute('aria-label', text);
    word.appendChild(blockWords(text));
    slot.replaceChildren(word);
    word.addEventListener('animationend', () => word.remove());
  }


  // ---- Fit: the match is laid out at a natural size, then scaled to the window ----
  const layout = document.querySelector('.layout');
  const MIN_SCALE = 0.2, MAX_SCALE = 1.45, SIDE_W = 340;
  function fit() {
    const game = document.getElementById('gameScreen');
    if (!layout || !game || game.hidden) return;
    if (innerWidth <= 600) { layout.style.zoom = ''; return; } // phones have their own layout
    layout.style.zoom = '1';
    const area = layout.querySelector('.table-area');
    const sides = innerWidth > 1100 ? 2 * SIDE_W : 0; // controls panel and commentary columns
    const needW = area.offsetWidth + sides + 32;
    const needH = layout.offsetHeight;
    const topH = document.querySelector('.topbar').offsetHeight;
    const s = Math.min(MAX_SCALE, (innerHeight - topH) / needH, innerWidth / needW);
    layout.style.zoom = String(Math.max(MIN_SCALE, Math.floor(s * 1000) / 1000));
  }
  addEventListener('resize', fit);
  addEventListener('load', fit);
  window.TetraFx = { blockText, comment, fit };

  // ---- Backdrop: tetrominoes in player colours fading in and out ----
  const canvas = document.getElementById('backdrop');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const CELL = 26;
  const MAX_PIECES = 40;
  const COLORS = ['hsl(14,65%,55%)', 'hsl(210,65%,55%)', 'hsl(145,65%,45%)', 'hsl(285,65%,60%)'];
  const SHAPES = [
    [[0, 0], [1, 0], [2, 0], [3, 0]], [[0, 0], [1, 0], [0, 1], [1, 1]],
    [[0, 0], [1, 0], [2, 0], [1, 1]], [[1, 0], [2, 0], [0, 1], [1, 1]],
    [[0, 0], [1, 0], [1, 1], [2, 1]], [[0, 0], [0, 1], [1, 1], [2, 1]],
    [[2, 0], [0, 1], [1, 1], [2, 1]],
  ];
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let w = 0, h = 0, pieces = [], last = 0, spawnAt = 0;

  function resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    w = innerWidth; h = innerHeight;
    canvas.width = w * dpr; canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (reduced) { pieces = Array.from({ length: 24 }, () => spawn(0, true)); draw(0); }
  }

  function spawn(now, still) {
    const turn = Math.floor(Math.random() * 4);
    const cells = SHAPES[Math.floor(Math.random() * SHAPES.length)].map(([x, y]) =>
      [[x, y], [-y, x], [-x, -y], [y, -x]][turn]);
    return {
      cells,
      gx: Math.floor(Math.random() * (w / CELL)), gy: Math.floor(Math.random() * (h / CELL)),
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      born: now, life: still ? Infinity : 6000 + Math.random() * 3000,
    };
  }

  // 0 → 1 over the first 1.2 s, hold, back to 0 over the last 1.8 s.
  function alphaOf(p, now) {
    if (p.life === Infinity) return 0.22;
    const t = now - p.born;
    return 0.32 * Math.max(0, Math.min(1, t / 1200, (p.life - t) / 1800));
  }

  function draw(now) {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(255,255,255,0.025)';
    for (let x = 0; x < w; x += CELL) ctx.fillRect(x, 0, 1, h);
    for (let y = 0; y < h; y += CELL) ctx.fillRect(0, y, w, 1);
    for (const p of pieces) {
      ctx.globalAlpha = alphaOf(p, now);
      ctx.fillStyle = p.color;
      for (const [x, y] of p.cells) {
        ctx.beginPath();
        ctx.roundRect((p.gx + x) * CELL + 2, (p.gy + y) * CELL + 2, CELL - 3, CELL - 3, 3);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  function frame(now) {
    requestAnimationFrame(frame);
    if (now - last < 33) return; // ~30 fps
    last = now;
    pieces = pieces.filter((p) => now - p.born < p.life);
    if (now >= spawnAt && pieces.length < MAX_PIECES) {
      pieces.push(spawn(now));
      spawnAt = now + 180;
    }
    draw(now);
  }

  addEventListener('resize', resize);
  resize();
  // Start with the backdrop already populated, at staggered ages.
  if (!reduced) for (let i = 0; i < 25; i++) pieces.push(spawn(-Math.random() * 5000));
  if (!reduced) requestAnimationFrame(frame);
})();
