// Cryptographically-sourced, unbiased Fisher–Yates shuffle. Deliberately
// its own small module with no game-specific card shape and no
// dependencies, so both script.js (real games) and shuffle-audit.js (the
// statistical test harness) import and exercise the exact same function -
// an audit is only meaningful if it's testing what actually ships, not a
// reimplementation of it.

// crypto.getRandomValues() fills a typed array with cryptographically
// strong random bytes, unlike Math.random()'s output, which is generated
// by a fast but non-cryptographic, potentially-predictable engine PRNG
// (V8 uses xorshift128+). Available as a global in every modern browser
// and in Node (where this module also runs, under the audit harness).
//
// Pulled from a refillable buffer rather than calling
// crypto.getRandomValues() for one uint32 at a time: a single call fills
// the whole buffer with the same cryptographically strong randomness a
// call-per-value approach would produce (there's nothing lower-quality
// about consuming random bytes a few at a time after the fact), it just
// does it in ~1/1024th as many calls - the difference between a real
// game's single 52-card shuffle (never a bottleneck either way) and the
// audit harness's hundreds of thousands of shuffles finishing in seconds
// rather than minutes.
const RANDOM_BUFFER_SIZE = 1024;
let randomBuffer = new Uint32Array(0);
let randomBufferIndex = 0;

function randomUint32() {
  if (randomBufferIndex >= randomBuffer.length) {
    randomBuffer = new Uint32Array(RANDOM_BUFFER_SIZE);
    crypto.getRandomValues(randomBuffer);
    randomBufferIndex = 0;
  }
  return randomBuffer[randomBufferIndex++];
}

// Uniformly random integer in [0, maxExclusive), with zero modulo bias.
// Naively computing `randomUint32() % maxExclusive` is biased whenever
// 2^32 isn't an exact multiple of maxExclusive (true for every
// maxExclusive a 52-card shuffle ever uses): the remainder values below
// 2^32 % maxExclusive get one extra source draw mapping to them compared
// to the rest, making those outcomes fractionally more likely. Rejection
// sampling removes this entirely: draw only from the largest span of the
// 32-bit range that divides evenly by maxExclusive, and redraw (rarely -
// at most ~51/2^32 of the time for anything this shuffle needs) whenever
// a draw lands outside it.
export function randomInt(maxExclusive) {
  if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
    throw new RangeError('maxExclusive must be a positive integer');
  }
  const RANGE = 0x100000000; // 2^32
  const limit = RANGE - (RANGE % maxExclusive);
  let x;
  do {
    x = randomUint32();
  } while (x >= limit);
  return x % maxExclusive;
}

// In-place Fisher–Yates (Durstenfeld variant): for each position from the
// last down to the second, swap it with a uniformly random position at or
// before it. Every one of the n! orderings is equally likely, provided
// randomInt itself is unbiased (see above) - the loop structure alone
// introduces no bias.
export function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}
