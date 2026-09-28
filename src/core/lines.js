'use strict';

const { SIZE, idx, rowOf, colOf, isOccupied } = require('./constants');

const LAST = SIZE - 1;

function lineCells({ kind, index }) {
  const cells = [];
  for (let k = 0; k < SIZE; k++) cells.push(kind === 'row' ? idx(index, k) : idx(k, index));
  return cells;
}

// §5: an interior row or column (1..9) clears when it is full and the current
// move placed at least one of its cells. Edge lines contain blocked corners and
// can never be full, so they are never candidates.
function completedLines(owner, placedCells) {
  const candidates = new Map();
  for (const i of placedCells) {
    const r = rowOf(i);
    const c = colOf(i);
    if (r > 0 && r < LAST) candidates.set(`row:${r}`, { kind: 'row', index: r });
    if (c > 0 && c < LAST) candidates.set(`col:${c}`, { kind: 'col', index: c });
  }
  return [...candidates.values()]
    .filter((line) => lineCells(line).every((i) => isOccupied(owner[i])))
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.index - b.index);
}

// Map of cell -> number of hits (1, or 2 where a completed row and column cross).
function hitCounts(lines) {
  const hits = new Map();
  for (const line of lines) {
    for (const i of lineCells(line)) hits.set(i, (hits.get(i) || 0) + 1);
  }
  return hits;
}

module.exports = { lineCells, completedLines, hitCounts };
