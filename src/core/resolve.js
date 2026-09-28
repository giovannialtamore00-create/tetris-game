'use strict';

const { CELL_COUNT, EMPTY, GREY, ALIVE } = require('./constants');
const { NEIGHBOURS } = require('./board');

// §6: a block is anchored if an orthogonal chain of same-owner blocks links it
// to one of its owner's roots: the owner's surviving starting pieces
// (`root[i]`). Blocks placed later are never roots, even on the owner's own
// edge. This is computed for every seat, living or timed out.
function computeAnchored(owner, root) {
  const anchored = new Array(CELL_COUNT).fill(false);
  const queue = [];
  for (let i = 0; i < CELL_COUNT; i++) {
    if (root[i] && owner[i] >= 0) {
      anchored[i] = true;
      queue.push(i);
    }
  }
  while (queue.length > 0) {
    const i = queue.pop();
    for (const n of NEIGHBOURS[i]) {
      if (!anchored[n] && owner[n] === owner[i]) {
        anchored[n] = true;
        queue.push(n);
      }
    }
  }
  return anchored;
}

// Groups the cells matching `include` into orthogonally connected clusters.
function findClusters(include) {
  const seen = new Array(CELL_COUNT).fill(false);
  const clusters = [];
  for (let start = 0; start < CELL_COUNT; start++) {
    if (seen[start] || !include(start)) continue;
    seen[start] = true;
    const cells = [];
    const queue = [start];
    while (queue.length > 0) {
      const i = queue.pop();
      cells.push(i);
      for (const n of NEIGHBOURS[i]) {
        if (!seen[n] && include(n)) {
          seen[n] = true;
          queue.push(n);
        }
      }
    }
    clusters.push(cells.sort((a, b) => a - b));
  }
  return clusters;
}

// Distinct seats owning an anchored block next to any cell of the cluster.
function touchingColours(cells, owner, anchored) {
  const colours = new Set();
  for (const i of cells) {
    for (const n of NEIGHBOURS[i]) {
      if (owner[n] >= 0 && anchored[n]) colours.add(owner[n]);
    }
  }
  return [...colours].sort((a, b) => a - b);
}

// §6 cluster resolution. Unanchored owned blocks lose their owner; together
// with existing grey blocks they form clusters that detonate (0 touching
// colours), convert (1) or become/stay grey (2+). Every cluster is decided from
// the same snapshot, then all outcomes are applied. Mutates `owner` and `hp`.
// A root is always anchored, so no cluster ever contains one.
//
// Returns one entry per cluster:
//   { outcome: 'detonate' | 'convert' | 'grey', cells, touching,
//     to (convert only), newlyGreyed (grey only), formerOwners }
function resolveClusters(owner, hp, root) {
  const anchored = computeAnchored(owner, root);
  const ownerless = (i) => owner[i] === GREY || (owner[i] >= 0 && !anchored[i]);

  const decisions = findClusters(ownerless).map((cells) => {
    const touching = touchingColours(cells, owner, anchored);
    const formerOwners = cells.map((i) => owner[i]);
    if (touching.length === 0) return { outcome: 'detonate', cells, touching, formerOwners };
    if (touching.length === 1) return { outcome: 'convert', cells, touching, formerOwners, to: touching[0] };
    return {
      outcome: 'grey',
      cells,
      touching,
      formerOwners,
      newlyGreyed: cells.filter((i) => owner[i] !== GREY),
    };
  });

  for (const d of decisions) {
    for (const i of d.cells) {
      if (d.outcome === 'detonate') {
        owner[i] = EMPTY;
        hp[i] = 0;
      } else if (d.outcome === 'convert') {
        owner[i] = d.to;
      } else {
        owner[i] = GREY;
      }
    }
  }
  return decisions;
}

// Scoring for resolved clusters (§7): detonations pay the mover 1 per block;
// conversions pay the adopter 1 per block if the adopter is alive.
function clusterPoints(decision, moverSeat, statusOf) {
  if (decision.outcome === 'detonate') return { seat: moverSeat, points: decision.cells.length };
  if (decision.outcome === 'convert' && statusOf(decision.to) === ALIVE) {
    return { seat: decision.to, points: decision.cells.length };
  }
  return null;
}

module.exports = { computeAnchored, findClusters, touchingColours, resolveClusters, clusterPoints };
