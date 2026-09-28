'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { completedLines, hitCounts } = require('../src/core/lines');
const { parseBoard, at } = require('./helpers');

// Row 5 and column 5 are full; nothing else is. Ownership is irrelevant here.
const CROSS = [
  '#....N....#',
  '.....N.....',
  '.....N.....',
  '.....N.....',
  '.....N.....',
  'WWWWWGEEEEE',
  '.....S.....',
  '.....S.....',
  '.....S.....',
  '.....S.....',
  '#....S....#',
];

describe('line clears', () => {
  const { owner } = parseBoard(CROSS);

  it('clears a full line only when the move placed a block in it', () => {
    assert.deepEqual(completedLines(owner, [at(5, 2)]), [{ kind: 'row', index: 5 }]);
    assert.deepEqual(completedLines(owner, [at(4, 5)]), [{ kind: 'col', index: 5 }]);
    assert.deepEqual(completedLines(owner, [at(3, 8)]), []);
  });

  it('hits a cell where two completed lines cross twice', () => {
    const lines = completedLines(owner, [at(5, 5)]);
    assert.deepEqual(lines, [{ kind: 'col', index: 5 }, { kind: 'row', index: 5 }]);
    const hits = hitCounts(lines);
    assert.equal(hits.get(at(5, 5)), 2);
    assert.equal(hits.get(at(5, 0)), 1);
    assert.equal(hits.get(at(0, 5)), 1);
    assert.equal(hits.size, 21);
  });

  it('includes both edge cells of a line running across the board', () => {
    const hits = hitCounts(completedLines(owner, [at(2, 5)]));
    assert.equal(hits.get(at(0, 5)), 1);
    assert.equal(hits.get(at(10, 5)), 1);
  });

  it('never clears an edge line, because its corners are blocked', () => {
    const full = parseBoard([
      '#NNNNNNNNN#',
      ...Array.from({ length: 9 }, () => 'W.........E'),
      '#SSSSSSSSS#',
    ]);
    assert.deepEqual(completedLines(full.owner, [at(10, 4), at(0, 4), at(4, 0), at(4, 10)]), []);
  });
});
