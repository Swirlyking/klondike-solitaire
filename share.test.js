import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  shareMode, isUserCancel, copyResult, shareCelebration,
  formatRecordLine, buildShareText, CANONICAL_SHARE_URL,
} from './share.js';

// Pure-logic tests only, same split as backup.test.js/victory.test.js/
// stats.test.js - shareCelebration/copyResult never touch a real DOM; every
// browser object they need (navigator, clipboard) is injected.

const abortError = () => Object.assign(new Error('Share canceled'), { name: 'AbortError' });
const fakeClipboard = (behaviour = 'ok') => {
  const c = {
    writes: [],
    writeText: async (text) => {
      if (behaviour === 'fail') throw Object.assign(new Error('Write permission denied.'), { name: 'NotAllowedError' });
      c.writes.push(text);
    },
  };
  return c;
};

// The real, current win payload (not a placeholder) - this file is the
// actual invocation boundary (the one place shareCelebration() itself gets
// exercised), so what it tests should be the exact multi-line, multi-section
// string a player's tap really produces.
const TEXT = buildShareText({
  emoji: '🎉',
  drawCount: 3,
  winNumber: 12,
  timeLabel: '2:11',
  moveCount: 87,
  showRecords: true,
  isNewFastest: true,
  isNewFewestMoves: false,
  fastestTimeLabel: '2:11',
  fewestMoves: 74,
});

// ---------- shareMode ----------

test('shareMode: native is chosen exactly when navigator.share exists', () => {
  assert.equal(shareMode({ share: async () => {} }), 'native');
  assert.equal(shareMode({}), 'copy');
  assert.equal(shareMode(undefined), 'copy'); // no navigator at all (tests, workers)
});

// ---------- native share ----------

test('native share: the share sheet receives one text field - real newlines intact, no separate title or url', async () => {
  const calls = [];
  const nav = { share: async (data) => { calls.push(data); } };
  const clipboard = fakeClipboard();
  const result = await shareCelebration({ text: TEXT, nav, clipboard });
  assert.deepEqual(result, { outcome: 'shared' });
  // Exactly one key - `text` - reaches navigator.share(). Never `title`,
  // never `url`: those would hand iOS a second, independent share item that
  // "Copy" and some destinations join with no separator, indistinguishable
  // from newlines having been silently dropped.
  assert.deepEqual(calls, [{ text: TEXT }]);
  assert.deepEqual(Object.keys(calls[0]), ['text']);
  assert.ok(calls[0].text.includes('\n\n')); // blank-line separators survive
  assert.ok(calls[0].text.endsWith(CANONICAL_SHARE_URL));
  assert.equal(clipboard.writes.length, 0);
});

test('native share: navigator.share is invoked synchronously - no await in front of it', () => {
  // Browsers only allow share() during the user's transient activation. If
  // anything were awaited first, share() would run in a later task and be
  // refused. So it must already have been called by the time
  // shareCelebration() returns its promise.
  let called = false;
  const nav = { share: () => { called = true; return new Promise(() => {}); } };
  shareCelebration({ text: TEXT, nav });
  assert.equal(called, true);
});

test('native share: a user-cancelled share is silent - no error, no copy, no fallback', async () => {
  const nav = { share: async () => { throw abortError(); } };
  const clipboard = fakeClipboard();
  const result = await shareCelebration({ text: TEXT, nav, clipboard });
  assert.deepEqual(result, { outcome: 'cancelled' });
  assert.equal(clipboard.writes.length, 0);
  assert.equal(isUserCancel(abortError()), true);
  assert.equal(isUserCancel(new Error('boom')), false);
});

test('native share: a genuine share failure falls back to copying, and says so', async () => {
  const nav = { share: async () => { throw Object.assign(new Error('Share not allowed'), { name: 'NotAllowedError' }); } };
  const clipboard = fakeClipboard();
  const result = await shareCelebration({ text: TEXT, nav, clipboard });
  assert.equal(result.outcome, 'copied');
  assert.equal(result.via, 'clipboard');
  assert.equal(result.shareError, 'Share not allowed');
  assert.deepEqual(clipboard.writes, [TEXT]);
});

test('native share: share failure with no working copy path ends in manual, never a throw', async () => {
  const nav = { share: async () => { throw new Error('nope'); } };
  const result = await shareCelebration({ text: TEXT, nav, clipboard: fakeClipboard('fail') });
  assert.equal(result.outcome, 'manual');
  assert.equal(result.shareError, 'nope');
});

// ---------- clipboard fallback ----------

test('clipboard fallback: with no navigator.share, the text goes to the clipboard', async () => {
  const clipboard = fakeClipboard();
  const result = await shareCelebration({ text: TEXT, nav: { clipboard }, clipboard });
  assert.deepEqual(result, { outcome: 'copied', via: 'clipboard' });
  assert.deepEqual(clipboard.writes, [TEXT]);
});

test('clipboard fallback: clipboard success is reported as copied', async () => {
  assert.deepEqual(await copyResult({ text: TEXT, clipboard: fakeClipboard() }), { outcome: 'copied', via: 'clipboard' });
});

test('clipboard fallback: a refused clipboard falls back to the legacy copier when one is supplied', async () => {
  const legacy = [];
  const result = await copyResult({
    text: TEXT,
    clipboard: fakeClipboard('fail'),
    legacyCopy: (t) => { legacy.push(t); return true; },
  });
  assert.deepEqual(result, { outcome: 'copied', via: 'legacy' });
  assert.deepEqual(legacy, [TEXT]);
});

test('clipboard fallback: an insecure context (no navigator.clipboard at all) goes straight to the legacy copier', async () => {
  // What a plain-http page looks like: navigator.share and navigator.clipboard are absent.
  const nav = {};
  const result = await shareCelebration({ text: TEXT, nav, legacyCopy: () => true });
  assert.deepEqual(result, { outcome: 'copied', via: 'legacy' });
});

test('clipboard fallback: when every copy path fails the outcome is manual, and nothing throws', async () => {
  assert.deepEqual(
    await copyResult({ text: TEXT, clipboard: fakeClipboard('fail'), legacyCopy: () => { throw new Error('execCommand gone'); } }),
    { outcome: 'manual' },
  );
  assert.deepEqual(await copyResult({ text: TEXT, clipboard: undefined }), { outcome: 'manual' });
});

// ---------- formatRecordLine ----------

test('formatRecordLine: a new record shows the trophy text, ignoring the formatted value', () => {
  assert.equal(formatRecordLine(true, '🏆 NEW FASTEST TIME', 'Fastest', '2:11'), '🏆 NEW FASTEST TIME');
});

test('formatRecordLine: an ordinary result shows "label: value"', () => {
  assert.equal(formatRecordLine(false, '🏆 NEW FASTEST TIME', 'Fastest', '2:11'), 'Fastest: 2:11');
  assert.equal(formatRecordLine(false, '🏆 NEW FEWEST MOVES', 'Fewest moves', 74), 'Fewest moves: 74');
});

// ---------- buildShareText ----------

test('buildShareText: win #1 omits the records section entirely - no redundant echo of the result line', () => {
  const text = buildShareText({
    emoji: '🎉', drawCount: 1, winNumber: 1, timeLabel: '3:45', moveCount: 60,
    showRecords: false, isNewFastest: false, isNewFewestMoves: false,
    fastestTimeLabel: null, fewestMoves: null,
  });
  assert.equal(text, [
    'MIKE’S SOLITAIRE',
    'Draw 1',
    '',
    '🎉 WIN #1',
    '3:45 · 60 moves',
    '',
    CANONICAL_SHARE_URL,
  ].join('\n'));
  assert.ok(!text.includes('Fastest'));
  assert.ok(!text.includes('Fewest'));
});

test('buildShareText: win #2+ includes both record lines, each independently new-record or ordinary', () => {
  const text = buildShareText({
    emoji: '🎉', drawCount: 3, winNumber: 12, timeLabel: '2:11', moveCount: 87,
    showRecords: true, isNewFastest: true, isNewFewestMoves: false,
    fastestTimeLabel: '2:11', fewestMoves: 74,
  });
  assert.equal(text, [
    'MIKE’S SOLITAIRE',
    'Draw 3',
    '',
    '🎉 WIN #12',
    '2:11 · 87 moves',
    '',
    '🏆 NEW FASTEST TIME',
    'Fewest moves: 74',
    '',
    CANONICAL_SHARE_URL,
  ].join('\n'));
});

test('buildShareText: always ends with the canonical URL on its own trailing line, never window.location', () => {
  const text = buildShareText({
    emoji: '🎉', drawCount: 1, winNumber: 5, timeLabel: '1:00', moveCount: 40,
    showRecords: false, isNewFastest: false, isNewFewestMoves: false,
    fastestTimeLabel: null, fewestMoves: null,
  });
  assert.ok(text.endsWith(`\n${CANONICAL_SHARE_URL}`));
});

// Every existing assertion above compares against the CANONICAL_SHARE_URL
// symbol, so the share text stays self-consistent no matter what the
// constant says - which is exactly why none of them noticed when the
// constant went stale. The game moved to solitaire.mikesgames.app while
// this still read solitaire.mikestrassburger.com, and every shared win
// kept pointing at the old host. This is the one test that asserts the
// literal value, so a future domain move has to be deliberate.
test('the canonical share URL is the live production host, spelled exactly', () => {
  assert.equal(CANONICAL_SHARE_URL, 'https://solitaire.mikesgames.app');
});

test('the canonical share URL is an absolute https origin with no path or trailing slash', () => {
  // A recipient has to be able to paste it anywhere: no scheme-relative
  // form, no localhost/deploy-preview leakage, nothing to strip.
  const u = new URL(CANONICAL_SHARE_URL);
  assert.equal(u.protocol, 'https:');
  assert.equal(u.pathname, '/');
  assert.equal(u.search, '');
  assert.ok(!CANONICAL_SHARE_URL.endsWith('/'), 'no trailing slash - it is appended to share text verbatim');
});
