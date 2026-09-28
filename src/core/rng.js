'use strict';

// Seeded PRNG (mulberry32). The generator state is a plain object `{ s }` so it
// can live inside the game state and be cloned or serialised with it.

function createRng(seed) {
  return { s: seed >>> 0 };
}

function nextUint32(rng) {
  rng.s = (rng.s + 0x6d2b79f5) >>> 0;
  let t = rng.s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return (t ^ (t >>> 14)) >>> 0;
}

function nextInt(rng, n) {
  return Math.floor((nextUint32(rng) / 2 ** 32) * n);
}

// Derives an independent seed for stream `k` from a game seed.
function deriveSeed(seed, k) {
  return nextUint32(createRng((seed ^ Math.imul(k + 1, 0x9e3779b9)) >>> 0));
}

function shuffleInPlace(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = nextInt(rng, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

module.exports = { createRng, nextUint32, nextInt, deriveSeed, shuffleInPlace };
