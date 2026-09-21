// MIKE GAMES DOMAIN MIGRATION (temporary) - tests for the one piece of this
// system that must not be wrong: the hostname + date decision itself.
//
// This does NOT re-implement the gate and test the copy. It EXTRACTS the
// real inline <script> from index.html and runs that exact shipped source in
// a sandbox against a table of hostnames and clocks - the same
// assert-the-actual-source technique mike-games-system/SYSTEM.md §16 records
// from Word Flower's settings/icon tests, and the only way to test a gate
// that deliberately lives inline in the document (see that block's comment).
//
// What it is really defending:
//   - the cutoff is October 1, 2026 local midnight, and nothing else;
//   - the old-hostname match has a real dot boundary, so a lookalike domain
//     ("notmikestrassburger.com", "mikestrassburger.com.example") can never
//     trip it, and the NEW mikesgames.app hostnames never can either;
//   - ?migrationDate can only ever move the clock FORWARD, so no query
//     string can get a player back past a cutoff that has genuinely arrived.
// That last one is the property that makes shipping a test hook safe at all.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');

// The inline gate is the one <script> block that defines window.MIKE_MIGRATION.
const gateSource = (() => {
  const blocks = html.match(/<script>([\s\S]*?)<\/script>/g) || [];
  const match = blocks.filter(b => b.includes('window.MIKE_MIGRATION = api'));
  assert.equal(match.length, 1, 'expected exactly one inline MIKE_MIGRATION gate in index.html');
  return match[0].replace(/^<script>/, '').replace(/<\/script>$/, '');
})();

const CUTOFF = new Date(2026, 9, 1, 0, 0, 0, 0).getTime();

// Runs the real gate source with a stubbed location/document at a given
// wall-clock instant, and hands back whatever it put on window.
function runGate({ hostname, search = '', nowMs }) {
  class FakeDate extends Date {
    constructor(...args) {
      if (args.length === 0) super(nowMs);
      else super(...args);
    }
    static now() { return nowMs; }
  }

  const injectedStyles = [];
  const htmlAttrs = {};
  const documentStub = {
    documentElement: {
      setAttribute(name, value) { htmlAttrs[name] = value; },
      getAttribute(name) { return name in htmlAttrs ? htmlAttrs[name] : null; },
    },
    createElement: () => ({ textContent: '' }),
    head: { appendChild(node) { injectedStyles.push(node.textContent); } },
  };

  const sandbox = {
    location: { hostname, search },
    document: documentStub,
    Date: FakeDate,
    RegExp,
    decodeURIComponent,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(gateSource, sandbox);
  return { api: sandbox.MIKE_MIGRATION, htmlAttrs, injectedStyles };
}

const BEFORE = CUTOFF - 1;            // Sept 30, 2026, 23:59:59.999 local
const AFTER = CUTOFF;                 // the cutoff instant itself
const WELL_AFTER = CUTOFF + 86400000; // Oct 2, 2026

test('the cutoff constant is October 1 2026 local midnight, not deploy timing', () => {
  const { api } = runGate({ hostname: 'solitaire.mikestrassburger.com', nowMs: BEFORE });
  const d = new Date(api.cutoffMs);
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 9); // 0-indexed: October
  assert.equal(d.getDate(), 1);
  assert.equal(d.getHours(), 0);
  assert.equal(d.getMinutes(), 0);
  assert.equal(d.getSeconds(), 0);
  assert.equal(d.getMilliseconds(), 0);
});

test('the OLD hostname shows the notice before the cutoff', () => {
  for (const hostname of [
    'solitaire.mikestrassburger.com',
    'mikestrassburger.com',
    'www.solitaire.mikestrassburger.com',
  ]) {
    const { api } = runGate({ hostname, nowMs: BEFORE });
    assert.equal(api.phase, 'notice', hostname);
    assert.equal(api.blocked, false, hostname);
  }
});

test('the OLD hostname is blocked from the cutoff instant onward', () => {
  for (const nowMs of [AFTER, WELL_AFTER]) {
    const { api, htmlAttrs, injectedStyles } = runGate({
      hostname: 'solitaire.mikestrassburger.com',
      nowMs,
    });
    assert.equal(api.phase, 'blocked');
    assert.equal(api.blocked, true);
    // The blackout must not depend on style.css having been refetched -
    // the gate injects it itself. See index.html's own comment.
    assert.equal(htmlAttrs['data-mike-migration'], 'blocked');
    assert.equal(injectedStyles.length, 1);
    assert.match(injectedStyles[0], /body > \* \{ display: none !important; \}/);
    assert.match(injectedStyles[0], /#migration-screen \{ display: flex !important; \}/);
  }
});

test('no migration UI on the new hostnames, localhost, or a preview deploy - ever', () => {
  const neverHosts = [
    'solitaire.mikesgames.app',
    'mahjong.mikesgames.app',
    'mikesgames.app',
    'localhost',
    '127.0.0.1',
    'deploy-preview-12--mikes-solitaire.netlify.app',
    // Lookalikes: the match needs a real dot boundary in both directions,
    // or a domain someone else controls could either trip this or, worse,
    // read as "not old" when it is.
    'notmikestrassburger.com',
    'mikestrassburger.com.example.com',
  ];
  for (const hostname of neverHosts) {
    for (const nowMs of [BEFORE, AFTER, WELL_AFTER]) {
      const { api, htmlAttrs } = runGate({ hostname, nowMs });
      assert.equal(api.phase, 'none', `${hostname} @ ${nowMs}`);
      assert.equal(api.active, false, hostname);
      assert.equal(api.blocked, false, hostname);
      assert.equal(htmlAttrs['data-mike-migration'], undefined, hostname);
    }
  }
});

test('?migrationHost=1 is the only way to see this anywhere else', () => {
  const { api } = runGate({ hostname: 'localhost', search: '?migrationHost=1', nowMs: BEFORE });
  assert.equal(api.phase, 'notice');

  const blocked = runGate({
    hostname: 'localhost',
    search: '?migrationHost=1&migrationDate=2026-10-01',
    nowMs: BEFORE,
  });
  assert.equal(blocked.api.phase, 'blocked');
});

test('?migrationDate only ever moves the clock FORWARD - it can never unblock', () => {
  // A past date on a genuinely-past-cutoff old host stays blocked. This is
  // the property that makes leaving the hook in production safe.
  for (const sim of ['2020-01-01', '2026-09-01', '1999-12-31']) {
    const { api } = runGate({
      hostname: 'solitaire.mikestrassburger.com',
      search: `?migrationDate=${sim}`,
      nowMs: WELL_AFTER,
    });
    assert.equal(api.phase, 'blocked', sim);
    assert.equal(api.dateOffsetMs, 0, sim);
  }
  // A malformed value is ignored outright rather than parsed loosely.
  const garbage = runGate({
    hostname: 'solitaire.mikestrassburger.com',
    search: '?migrationDate=tomorrow',
    nowMs: BEFORE,
  });
  assert.equal(garbage.api.phase, 'notice');
  assert.equal(garbage.api.dateOffsetMs, 0);
});

test('the URLs the buttons go to are this game s own, and the family home', () => {
  const { api } = runGate({ hostname: 'solitaire.mikestrassburger.com', nowMs: BEFORE });
  assert.equal(api.newGameUrl, 'https://solitaire.mikesgames.app');
  assert.equal(api.homeUrl, 'https://mikesgames.app');
});

// --- Shipped copy and wiring -------------------------------------------
// Cheap structural guards, in the spirit of SYSTEM.md §16's note on
// asserting source structure: these strings are the whole product here, and
// a silent edit to one of them is exactly the kind of drift nothing else
// would catch.

test('index.html carries the agreed migration copy verbatim', () => {
  for (const phrase of [
    '>Mike\'s Games has moved<',
    'This game has a new home at <strong>mikesgames.app</strong>.',
    'This old version will be available through <strong>September 30</strong>.',
    'You can move this game to its new home now, or simply delete this version and visit mikesgames.app to start fresh.',
    '>Go to the New Version</a>',
    '>Remind Me Later</button>',
    '>This game has moved<',
    'Mike\'s Games now lives at <strong>mikesgames.app</strong>.',
    'This old version is no longer available. You can install the new version of this game, or delete this one and visit mikesgames.app to start fresh.',
    '>Visit Mike\'s Games</a>',
  ]) {
    assert.ok(html.includes(phrase), `missing migration copy: ${phrase}`);
  }
});

test('the post-cutoff screen needs no JavaScript: both actions are real anchors', () => {
  const screen = html.slice(
    html.indexOf('<div id="migration-screen"'),
    html.indexOf('<div id="drag-layer">')
  );
  assert.ok(screen.includes('href="https://solitaire.mikesgames.app"'));
  assert.ok(screen.includes('href="https://mikesgames.app"'));
  assert.ok(!screen.includes('<button'), 'the cutoff screen must not depend on a JS-wired button');
});

test('there is no permanent dismissal anywhere in the migration system', () => {
  const js = readFileSync(new URL('./domain-migration.js', import.meta.url), 'utf8');
  assert.ok(!/never|forever|permanent|dontShowAgain|neverAskAgain/i.test(
    js.replace(/^\s*\/\/.*$/gm, '')  // comments may say the word; code may not
  ), 'domain-migration.js must not carry a permanent-dismissal path');
  assert.ok(!html.includes('migrationDontShow'));
});

test('no game code runs past the cutoff - all three entry points are guarded', () => {
  const script = readFileSync(new URL('./script.js', import.meta.url), 'utf8');
  // The two IIFEs (game, update-checker) return early...
  const returns = script.match(/if \(window\.MIKE_MIGRATION && window\.MIKE_MIGRATION\.blocked\) return;/g) || [];
  assert.equal(returns.length, 2, 'expected the game IIFE and the update-checker IIFE to both be guarded');
  // ...and the module-level startup calls, which are outside both, are
  // wrapped rather than left to run on a retired origin.
  assert.match(
    script,
    /if \(!\(window\.MIKE_MIGRATION && window\.MIKE_MIGRATION\.blocked\)\) \{\s*\/\/[\s\S]{0,400}?ensureIconGenerationMarker\(\);/,
    'the module-level startup calls must be inside the migration guard'
  );
});
