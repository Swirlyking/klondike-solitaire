import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { whatsNewDecision, CURRENT_NOTE } from './whats-new.js';

// The one-time "what's new" notice. Pure decision only - the three
// wrappers around it need real localStorage and are not testable here, the
// same split stats.js/preferences.js already use. The structural checks at
// the bottom cover the parts of the wiring that are easy to get wrong and
// invisible until a real player hits them.

const SCRIPT = readFileSync(new URL('./script.js', import.meta.url), 'utf8');
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

test('a device already told about this note is never told again', () => {
  assert.equal(whatsNewDecision({ seen: CURRENT_NOTE, hadPriorActivity: true }), 'already-seen');
  assert.equal(whatsNewDecision({ seen: CURRENT_NOTE, hadPriorActivity: false }), 'already-seen');
});

test('a genuinely fresh install is stamped, and never sees the notice', () => {
  // Nothing is "new" to a device that shipped with the feature in it.
  assert.equal(whatsNewDecision({ seen: null, hadPriorActivity: false }), 'fresh-install');
  assert.equal(whatsNewDecision({ seen: undefined, hadPriorActivity: false }), 'fresh-install');
});

test('a returning player who has played before is shown it exactly once', () => {
  assert.equal(whatsNewDecision({ seen: null, hadPriorActivity: true }), 'show');
});

test('a player stamped with an OLDER note id is eligible again', () => {
  // This is what makes a future update able to say something: bumping
  // CURRENT_NOTE makes every previously-stamped device "not seen yet".
  assert.equal(whatsNewDecision({ seen: 'some-earlier-note', hadPriorActivity: true }), 'show');
  // ...but a fresh install stamped with an older id is still a real
  // device that has been told something once; prior activity is what
  // separates the two, and a stamped-but-idle device still counts as told
  // about THAT note, not this one.
  assert.equal(whatsNewDecision({ seen: 'some-earlier-note', hadPriorActivity: false }), 'show');
});

test('the decision depends on nothing but its two inputs', () => {
  // No dates, no version parsing, no build metadata - a notice that
  // depends on the clock is a notice that fires on the wrong device.
  const src = strip(readFileSync(new URL('./whats-new.js', import.meta.url), 'utf8'));
  assert.ok(!/Date|now\(\)|APP_VERSION|ASSET_VERSION/.test(src),
    'whats-new.js must not consult the clock or a build version');
});

// ---------- wiring ----------

test('the seen marker is written when the sheet OPENS, not when its button is pressed', () => {
  // Otherwise a player who reads it and switches away is told again next
  // launch - which is the nagging this is meant to avoid.
  const src = strip(SCRIPT);
  assert.match(src, /markWhatsNewSeen\(\);[\s\S]{0,160}whatsNewOverlay\.classList\.remove\('hidden'\)/,
    'mark-as-seen must precede the reveal');
  const btn = src.slice(src.indexOf("whatsNewGotItBtn.addEventListener"));
  assert.ok(!/markWhatsNewSeen/.test(btn.slice(0, 200)),
    'the button only closes the sheet - it has nothing left to persist');
});

test('the marker is stamped before anything in the session writes preferences', () => {
  // stats.recordPlay() runs on every newGame() and would make a brand-new
  // device look like a returning player by the time anything checked.
  const src = strip(SCRIPT);
  assert.ok(src.indexOf('ensureWhatsNewMarker()') < src.indexOf('recordPlay('),
    'ensureWhatsNewMarker must run before recordPlay');
  assert.ok(Math.abs(src.indexOf('ensureWhatsNewMarker()') - src.indexOf('ensureIconGenerationMarker()')) < 200,
    'it belongs beside the icon marker, which has the identical constraint');
});

test('at most one launch sheet, with this one last in line', () => {
  const src = strip(SCRIPT);
  assert.match(src, /if \(shouldShowIconNotice\(\) && !migrationActive\)[\s\S]{0,200}\} else if \(shouldShowWhatsNew\(\) && !migrationActive\)/,
    'the two sheets must be mutually exclusive, and both must yield to migration');
});

test('the shipped copy says the three things it needs to', () => {
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const start = html.indexOf('id="whats-new-overlay"');
  assert.notEqual(start, -1);
  const sheet = html.slice(start, html.indexOf('id="confirm-overlay"'));
  const text = sheet.replace(/<[^>]+>/g, ' ').replace(/&rsquo;/g, '’').replace(/\s+/g, ' ');
  assert.match(text, /Flick ’em\./);                       // what it is
  assert.match(text, /flick any playable single card/);         // what you can do
  assert.match(text, /any direction/);                          // no aiming
  assert.match(text, /No aiming required\./);
  assert.match(text, /Multi-card runs still drag normally\./);   // what did NOT change
  assert.match(sheet, /id="whatsNewGotItBtn"[^>]*>Got it</);
});

test('release metadata: APP_VERSION advanced, ASSET_VERSION untouched', () => {
  // APP_VERSION is what lets you glance at Settings and tell a fresh build
  // from a stale cached one. ASSET_VERSION is the card-art cache-buster and
  // must NOT move for a release that changes no art: bumping it would dump
  // a year-immutable art cache for every player and buy nothing.
  const app = SCRIPT.match(/const APP_VERSION = '([\d.]+)'/);
  assert.ok(app, 'APP_VERSION must exist');
  assert.notEqual(app[1], '2026.08.12.1129', 'APP_VERSION must be bumped for this release');
  assert.match(app[1], /^\d{4}\.\d{2}\.\d{2}\.\d{4}$/, 'same YYYY.MM.DD.HHmm convention');
  assert.match(SCRIPT, /const ASSET_VERSION = 'v8'/, 'no card art changed, so this must not move');
});
