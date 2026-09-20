import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DIRTY_BACKGROUND_COUNT,
  TRANSFORM_VARIANTS,
  assignFaceVariants,
} from './card-face-compositor.js';

// A tiny deterministic stand-in for shuffle.js's real randomInt: cycles
// through a fixed sequence so a test can assert exact output, and so this
// file never has to touch real randomness (or shuffle.js at all) to test
// pure assignment logic.
function sequenceRandomInt(sequence) {
  let i = 0;
  return (maxExclusive) => {
    const n = sequence[i % sequence.length] % maxExclusive;
    i++;
    return n;
  };
}

test('assignFaceVariants: assigns exactly one variant per given key', () => {
  const keys = ['hearts-1', 'spades-13', 'clubs-7'];
  const result = assignFaceVariants(keys, sequenceRandomInt([0, 1, 2, 3, 4, 5]));
  assert.equal(Object.keys(result).length, keys.length);
  for (const key of keys) assert.ok(key in result);
});

test('assignFaceVariants: every dirtyIndex is in range, every transform is a valid TRANSFORM_VARIANTS entry', () => {
  const keys = Array.from({ length: 52 }, (_, i) => `card-${i}`);
  // A real-shaped RNG (varies across the full range), not a fixed stub -
  // this test cares about the produced SHAPE holding for any input, not
  // one specific sequence.
  let seed = 1;
  const randomInt = (maxExclusive) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % maxExclusive;
  };
  const result = assignFaceVariants(keys, randomInt);
  for (const key of keys) {
    const { dirtyIndex, flipX, flipY } = result[key];
    assert.ok(Number.isInteger(dirtyIndex) && dirtyIndex >= 0 && dirtyIndex < DIRTY_BACKGROUND_COUNT);
    assert.ok(TRANSFORM_VARIANTS.some(v => v.flipX === flipX && v.flipY === flipY));
  }
});

test('assignFaceVariants: same randomInt sequence produces the same assignment (stability within a game)', () => {
  const keys = ['a', 'b', 'c'];
  const seq = [2, 1, 5, 3, 0, 2];
  const first = assignFaceVariants(keys, sequenceRandomInt(seq));
  const second = assignFaceVariants(keys, sequenceRandomInt(seq));
  assert.deepEqual(first, second);
});

test('assignFaceVariants: TRANSFORM_VARIANTS has exactly 4 distinct entries (flipX+flipY covers 180deg rotation)', () => {
  assert.equal(TRANSFORM_VARIANTS.length, 4);
  const seen = new Set(TRANSFORM_VARIANTS.map(v => `${v.flipX}:${v.flipY}`));
  assert.equal(seen.size, 4);
});

test('assignFaceVariants: an empty key list produces an empty assignment', () => {
  assert.deepEqual(assignFaceVariants([], sequenceRandomInt([0])), {});
});
