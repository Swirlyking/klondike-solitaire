// THE UPDATE CHECK WATCHES EVERYTHING THE PAGE IS BUILT FROM, AND ONLY
// PROMPTS WHEN A RELOAD WOULD LOSE NOTHING - tests for update-check.js plus
// structural checks over script.js's wiring (the same assert-the-actual-
// source technique viewport-lock.test.js and domain-migration.test.js use,
// since script.js itself isn't unit-tested).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { CHECK_FILES, fingerprint, isNewer, shouldShowUpdateBar } from './update-check.js';

const read = f => readFileSync(new URL('./' + f, import.meta.url), 'utf8');
const html = read('index.html');
const js = read('script.js');

// Everything index.html loads (stylesheet, manifest, classic and module
// scripts) plus every module reachable from those through static imports.
function pageFiles() {
  const roots = [...html.matchAll(/<(?:link|script)\b[^>]*\b(?:href|src)="([^"#?:]+)"/g)]
    .map(m => m[1]).filter(f => /\.(js|css|json)$/.test(f));
  const seen = new Set(['index.html']);
  const queue = [...roots];
  while (queue.length) {
    const f = queue.shift();
    if (seen.has(f)) continue;
    seen.add(f);
    if (!f.endsWith('.js')) continue;
    for (const m of read(f).matchAll(/(?:import|export)\s[^;]*?from\s*['"]\.\/([^'"]+)['"]/g)) queue.push(m[1]);
    for (const m of read(f).matchAll(/import\(\s*['"]\.\/([^'"]+)['"]\s*\)/g)) queue.push(m[1]);
  }
  return seen;
}

test('every file the page is built from is watched, and nothing else', () => {
  const page = [...pageFiles()].sort();
  assert.deepEqual([...CHECK_FILES].sort(), page);
  for (const f of CHECK_FILES) assert.ok(existsSync(new URL('./' + f, import.meta.url)), f + ' exists');
});

// ---- fingerprinting --------------------------------------------------------
const ok = (etag, lastModified) => ({ ok: true, etag, lastModified });
const all = fn => CHECK_FILES.map((f, i) => fn(f, i));

test('fingerprint joins every file tag, in order; Last-Modified stands in for a missing ETag', () => {
  assert.equal(fingerprint(all((f, i) => ok(`"e${i}"`))).split('|').length, CHECK_FILES.length);
  assert.ok(fingerprint(all(() => ok(null, 'Thu, 24 Sep 2026 07:00:00 GMT'))).includes('2026'));
});

test('a failed, missing or tagless response is "no answer", never "changed"', () => {
  assert.equal(fingerprint(all((f, i) => (i === 3 ? { ok: false, etag: '"x"' } : ok('"a"')))), null);
  assert.equal(fingerprint(all((f, i) => (i === 0 ? ok(null, null) : ok('"a"')))), null);
  assert.equal(fingerprint([ok('"a"')]), null);
  assert.equal(fingerprint(null), null);
});

test('only a different fingerprint after the baseline is an update', () => {
  const a = fingerprint(all(() => ok('"a"')));
  const b = fingerprint(all(f => ok(f === 'game-logic.js' ? '"new"' : '"a"'))); // one module changed
  assert.equal(isNewer(a, a), false);
  assert.equal(isNewer(a, b), true);
  assert.equal(isNewer(null, b), false, 'no baseline yet - that check only sets it');
  assert.equal(isNewer(a, null), false, 'a failed check is not an update');
});

// ---- only when a reload loses nothing ---------------------------------------
test('the bar shows only with an update, between games, until dismissed', () => {
  const base = { updateAvailable: true, dismissed: false, betweenGames: true };
  assert.equal(shouldShowUpdateBar(base), true);
  assert.equal(shouldShowUpdateBar({ ...base, betweenGames: false }), false, 'deal in progress');
  assert.equal(shouldShowUpdateBar({ ...base, updateAvailable: false }), false);
  assert.equal(shouldShowUpdateBar({ ...base, dismissed: true }), false);
  assert.equal(shouldShowUpdateBar(), false);
});

// ---- wiring in script.js -----------------------------------------------------
test('between-games uses the same judgement as guardAbandon()', () => {
  assert.match(js, /isBetweenGames = \(\) => !needsAbandonConfirmation\(state, history\.length, won, getDrawCount\(\)\);/);
  assert.match(js, /if \(!needsAbandonConfirmation\(state, history\.length, won, getDrawCount\(\)\)\)/);
});

test('checks run on load, every minute, on visibility and on pageshow-from-memory', () => {
  assert.match(js, /setInterval\(checkForUpdate, CHECK_INTERVAL_MS\)/);
  assert.match(js, /addEventListener\('visibilitychange', \(\) => \{\s*if \(document\.visibilityState === 'visible'\) checkForUpdate\(\);/);
  assert.match(js, /addEventListener\('pageshow', \(e\) => \{\s*if \(e\.persisted\) checkForUpdate\(\);/);
  assert.match(js, /fetch\(f, \{ method: 'HEAD', cache: 'no-store' \}\)/);
});

test('it never reloads by itself - only the Reload button and Settings reach hardReload()', () => {
  const start = js.indexOf('// ---------- update checking ----------');
  const updateBlock = js.slice(start);
  const uses = updateBlock.split('\n').filter(l => /hardReload/.test(l) && !/^\s*\/\//.test(l));
  assert.deepEqual(uses.map(l => l.trim()), ["reloadBtn.addEventListener('click', hardReload);"]);
  assert.ok(!/location\.(reload|replace|assign)|location\.href\s*=/.test(updateBlock.replace(/^\s*\/\/.*$/gm, '')));
});
