'use strict';

const { CELL_COUNT, EMPTY, BLOCKED, GREY, ALIVE, TIMED_OUT, rowOf, colOf } = require('./constants');
const { isCorner } = require('./board');
const { computeAnchored, findClusters, touchingColours } = require('./resolve');

// Returns a list of violated invariants (empty when the state is consistent).
// Used by the tests after every step; cheap enough to call in development too.
function checkInvariants(state) {
  const { owner, hp, players } = state;
  const errors = [];
  const at = (i) => `(${rowOf(i)},${colOf(i)})`;

  for (let i = 0; i < CELL_COUNT; i++) {
    const o = owner[i];
    if (isCorner(rowOf(i), colOf(i)) !== (o === BLOCKED)) errors.push(`corner mismatch at ${at(i)}`);
    const occupied = o >= 0 || o === GREY;
    if (occupied && !(hp[i] >= 1 && hp[i] <= 3)) errors.push(`occupied cell ${at(i)} has hp ${hp[i]}`);
    if (!occupied && hp[i] !== 0) errors.push(`unoccupied cell ${at(i)} has hp ${hp[i]}`);
    if (o >= 0) {
      const status = players[o].status;
      if (status !== ALIVE && status !== TIMED_OUT) errors.push(`eliminated seat ${o} owns ${at(i)}`);
    } else if (o !== EMPTY && o !== BLOCKED && o !== GREY) {
      errors.push(`unknown owner ${o} at ${at(i)}`);
    }
  }

  const anchored = computeAnchored(owner);
  for (let i = 0; i < CELL_COUNT; i++) {
    if (owner[i] >= 0 && !anchored[i]) errors.push(`unanchored block of seat ${owner[i]} at ${at(i)}`);
  }

  for (const cells of findClusters((i) => owner[i] === GREY)) {
    const touching = touchingColours(cells, owner, anchored);
    if (touching.length < 2) {
      errors.push(`grey cluster at ${cells.map(at).join(' ')} touches ${touching.length} colour(s)`);
    }
  }

  return errors;
}

module.exports = { checkInvariants };
