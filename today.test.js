import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  todayKey, emptyDay, sanitizeToday, readDay, addGame, addWin, dayTotals,
  formatTodayWinLine, formatTodayStatus,
} from './today.js';

// Pure-logic tests only (no localStorage under plain node), same policy as
// stats.test.js. The counting sequence itself is in deal-tally.test.js.

test('todayKey: local date, zero-padded', () => {
  assert.equal(todayKey(new Date(2026, 0, 5, 12, 0)), '2026-01-05');
  assert.equal(todayKey(new Date(2026, 11, 31, 23, 59, 59)), '2026-12-31');
  assert.equal(todayKey(new Date(2027, 0, 1, 0, 0, 0)), '2027-01-01');
});

test('readDay: a record for another day reads as an empty day (lazy reset)', () => {
  const yesterday = { date: '2026-11-07', draw1: { games: 6, wins: 2 }, draw3: { games: 1, wins: 0 } };
  assert.deepEqual(readDay(yesterday, '2026-11-08'), emptyDay('2026-11-08'));
});

test('readDay: today\'s record reads back unchanged', () => {
  const rec = { date: '2026-11-08', draw1: { games: 4, wins: 1 }, draw3: { games: 5, wins: 0 } };
  assert.deepEqual(readDay(rec, '2026-11-08'), rec);
});

test('addGame on a new day replaces the old day', () => {
  const yesterday = { date: '2026-11-07', draw1: { games: 6, wins: 2 }, draw3: { games: 1, wins: 0 } };
  assert.deepEqual(addGame(yesterday, '2026-11-08', 'draw3'),
    { date: '2026-11-08', draw1: { games: 0, wins: 0 }, draw3: { games: 1, wins: 0 } });
});

test('Draw 1 and Draw 3 count separately; totals combine them', () => {
  let rec = null;
  rec = addGame(rec, '2026-11-08', 'draw1');
  rec = addGame(rec, '2026-11-08', 'draw3');
  rec = addGame(rec, '2026-11-08', 'draw3');
  rec = addWin(rec, '2026-11-08', 'draw3');
  assert.deepEqual(rec.draw1, { games: 1, wins: 0 });
  assert.deepEqual(rec.draw3, { games: 2, wins: 1 });
  assert.deepEqual(dayTotals(rec), { games: 3, wins: 1 });
});

test('addWin backstop: never leaves wins above games', () => {
  const rec = addWin(null, '2026-11-08', 'draw1');
  assert.deepEqual(rec.draw1, { games: 1, wins: 1 });
});

test('unknown mode is ignored rather than corrupting the record', () => {
  assert.deepEqual(addGame(null, '2026-11-08', 'draw2'), emptyDay('2026-11-08'));
  assert.deepEqual(addWin(null, '2026-11-08', undefined), emptyDay('2026-11-08'));
});

test('sanitizeToday: missing or foreign values recover to an empty, dateless record', () => {
  for (const raw of [null, undefined, 'garbage', 42, [], {}]) {
    assert.deepEqual(sanitizeToday(raw), { date: null, draw1: { games: 0, wins: 0 }, draw3: { games: 0, wins: 0 } });
  }
});

test('sanitizeToday: repairs field by field and restores wins <= games', () => {
  const raw = { date: '2026-11-08', draw1: { games: -3, wins: 2 }, draw3: { games: 'x', wins: 1.5 } };
  assert.deepEqual(sanitizeToday(raw), { date: '2026-11-08', draw1: { games: 2, wins: 2 }, draw3: { games: 0, wins: 0 } });
  assert.equal(sanitizeToday({ date: 'Nov 8' }).date, null);
});

test('formatTodayWinLine: first try, on game N, then a running tally', () => {
  assert.equal(formatTodayWinLine({ games: 1, wins: 1 }), 'First win today, first try');
  assert.equal(formatTodayWinLine({ games: 5, wins: 1 }), 'First win today, on game 5');
  assert.equal(formatTodayWinLine({ games: 9, wins: 3 }), '3 wins today from 9 games');
  assert.equal(formatTodayWinLine({ games: 2, wins: 2 }), '2 wins today from 2 games');
  assert.equal(formatTodayWinLine({ games: 4, wins: 0 }), '');
});

test('formatTodayStatus', () => {
  assert.equal(formatTodayStatus({ games: 0, wins: 0 }), 'No games yet today');
  assert.equal(formatTodayStatus({ games: 3, wins: 0 }), 'No win yet today');
  assert.equal(formatTodayStatus({ games: 3, wins: 1 }), 'Won today');
});
