import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyModeStats, sanitizeStats, applyWin } from './stats.js';

// Pure-logic tests only, same split as victory.test.js/game-logic.test.js:
// this project has no jsdom/Playwright, and loadStats/saveStats/recordWin
// are thin wrappers over preferences.js's real localStorage calls - not
// meaningfully testable under plain `node --test` (no localStorage global
// here), and every case below is fully expressible against the pure
// emptyModeStats/sanitizeStats/applyWin functions those wrappers are built
// from. Persistence itself (reload survival, corrupt real localStorage
// content, etc.) is verified live in the browser instead.

test('emptyModeStats: the zero/never-played shape', () => {
  const empty = emptyModeStats();
  assert.deepEqual(empty, { wins: 0, fastestTimeSeconds: null, fewestMoves: null, lastWin: null });
});

test('sanitizeStats: missing/empty input recovers to default empty stats for both modes', () => {
  for (const raw of [null, undefined, {}, 'garbage', 42, []]) {
    const stats = sanitizeStats(raw);
    assert.deepEqual(stats.draw1, emptyModeStats());
    assert.deepEqual(stats.draw3, emptyModeStats());
  }
});

test('sanitizeStats: a well-formed object round-trips unchanged', () => {
  const raw = {
    draw1: { wins: 14, fastestTimeSeconds: 131, fewestMoves: 77, lastWin: { timeSeconds: 163, moves: 87 } },
    draw3: { wins: 8, fastestTimeSeconds: 194, fewestMoves: 92, lastWin: { timeSeconds: 221, moves: 104 } },
  };
  assert.deepEqual(sanitizeStats(raw), raw);
});

test('sanitizeStats: a corrupted field falls back to its own default without discarding the rest of the mode', () => {
  const raw = {
    draw1: { wins: 14, fastestTimeSeconds: 'not a number', fewestMoves: -5, lastWin: { timeSeconds: 163, moves: 87 } },
    draw3: 'totally the wrong shape',
  };
  const stats = sanitizeStats(raw);
  assert.deepEqual(stats.draw1, {
    wins: 14, fastestTimeSeconds: null, fewestMoves: null,
    lastWin: { timeSeconds: 163, moves: 87 },
  });
  assert.deepEqual(stats.draw3, emptyModeStats());
});

test('sanitizeStats: a malformed lastWin falls back to null rather than a partial object', () => {
  const stats = sanitizeStats({ draw1: { wins: 1, fastestTimeSeconds: 100, fewestMoves: 50, lastWin: { timeSeconds: 100 } } });
  assert.equal(stats.draw1.lastWin, null);
});

test('applyWin: win #1 saves fastest/fewest as the baseline but flags neither as a new record', () => {
  const result = applyWin(emptyModeStats(), 131, 77);
  assert.equal(result.winNumber, 1);
  assert.equal(result.isNewFastest, false);
  assert.equal(result.isNewFewestMoves, false);
  assert.deepEqual(result.stats, {
    wins: 1, fastestTimeSeconds: 131, fewestMoves: 77,
    lastWin: { timeSeconds: 131, moves: 77 },
  });
});

test('applyWin: a strictly faster win with the same move count sets only the fastest flag', () => {
  const modeStats = { wins: 1, fastestTimeSeconds: 131, fewestMoves: 77, lastWin: { timeSeconds: 131, moves: 77 } };
  const result = applyWin(modeStats, 100, 77);
  assert.equal(result.winNumber, 2);
  assert.equal(result.isNewFastest, true);
  assert.equal(result.isNewFewestMoves, false);
  assert.equal(result.stats.fastestTimeSeconds, 100);
  assert.equal(result.stats.fewestMoves, 77);
});

test('applyWin: a strictly lower move count with the same time sets only the fewest-moves flag', () => {
  const modeStats = { wins: 1, fastestTimeSeconds: 131, fewestMoves: 77, lastWin: { timeSeconds: 131, moves: 77 } };
  const result = applyWin(modeStats, 131, 60);
  assert.equal(result.isNewFastest, false);
  assert.equal(result.isNewFewestMoves, true);
  assert.equal(result.stats.fastestTimeSeconds, 131);
  assert.equal(result.stats.fewestMoves, 60);
});

test('applyWin: a win beating both records sets both flags', () => {
  const modeStats = { wins: 1, fastestTimeSeconds: 131, fewestMoves: 77, lastWin: { timeSeconds: 131, moves: 77 } };
  const result = applyWin(modeStats, 90, 55);
  assert.equal(result.isNewFastest, true);
  assert.equal(result.isNewFewestMoves, true);
  assert.equal(result.stats.fastestTimeSeconds, 90);
  assert.equal(result.stats.fewestMoves, 55);
});

test('applyWin: a slower, higher-move win sets neither flag and leaves both records untouched', () => {
  const modeStats = { wins: 1, fastestTimeSeconds: 131, fewestMoves: 77, lastWin: { timeSeconds: 131, moves: 77 } };
  const result = applyWin(modeStats, 200, 120);
  assert.equal(result.isNewFastest, false);
  assert.equal(result.isNewFewestMoves, false);
  assert.equal(result.stats.fastestTimeSeconds, 131);
  assert.equal(result.stats.fewestMoves, 77);
});

test('applyWin: an exact tie on fastest time is not a new record', () => {
  const modeStats = { wins: 1, fastestTimeSeconds: 131, fewestMoves: 77, lastWin: { timeSeconds: 131, moves: 77 } };
  const result = applyWin(modeStats, 131, 90);
  assert.equal(result.isNewFastest, false);
  assert.equal(result.stats.fastestTimeSeconds, 131);
});

test('applyWin: an exact tie on fewest moves is not a new record', () => {
  const modeStats = { wins: 1, fastestTimeSeconds: 131, fewestMoves: 77, lastWin: { timeSeconds: 131, moves: 77 } };
  const result = applyWin(modeStats, 200, 77);
  assert.equal(result.isNewFewestMoves, false);
  assert.equal(result.stats.fewestMoves, 77);
});

test('applyWin: win count increments correctly and lastWin updates every time, across a sequence of wins', () => {
  let modeStats = emptyModeStats();
  const games = [
    { secs: 200, moves: 100 },
    { secs: 150, moves: 90 },
    { secs: 300, moves: 110 }, // a worse game - still increments wins and updates lastWin
  ];
  games.forEach((game, i) => {
    const result = applyWin(modeStats, game.secs, game.moves);
    assert.equal(result.winNumber, i + 1);
    assert.deepEqual(result.stats.lastWin, { timeSeconds: game.secs, moves: game.moves });
    modeStats = result.stats;
  });
  assert.equal(modeStats.wins, 3);
  assert.equal(modeStats.fastestTimeSeconds, 150);
  assert.equal(modeStats.fewestMoves, 90);
});

test('applyWin: recording a win for one mode never touches the other mode\'s stats', () => {
  const draw3Untouched = { wins: 8, fastestTimeSeconds: 194, fewestMoves: 92, lastWin: { timeSeconds: 221, moves: 104 } };
  const fullStats = {
    draw1: { wins: 13, fastestTimeSeconds: 140, fewestMoves: 80, lastWin: { timeSeconds: 160, moves: 85 } },
    draw3: draw3Untouched,
  };
  const before = JSON.parse(JSON.stringify(draw3Untouched));

  const result = applyWin(fullStats.draw1, 100, 70);
  fullStats.draw1 = result.stats;

  assert.deepEqual(fullStats.draw3, before);
  assert.equal(fullStats.draw1.wins, 14);
});
