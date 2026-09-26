// Anonymous game metrics: routing, seam placement in script.js, and the standard's scenarios.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { routeFor, createSolitaireMetrics, COLLECTOR } from './metrics.js';
import { createMetrics } from './mike-metrics.js';

const js = readFileSync(new URL('./script.js', import.meta.url), 'utf8');

// The body of a top-level (two-space-indented) function in script.js.
function body(name) {
  const start = js.search(new RegExp(`\\n  (async )?function ${name}\\(`));
  assert.ok(start >= 0, `${name} exists`);
  const end = js.indexOf('\n  }\n', start);
  return js.slice(start, end);
}

test('routing: production sends, local logs, everything else is silent unless ?metrics=test', () => {
  assert.deepEqual(routeFor('solitaire.mikesgames.app', ''), { endpoint: COLLECTOR, log: false });
  assert.deepEqual(routeFor('solitaire.mikestrassburger.com', ''), { endpoint: COLLECTOR, log: false });
  assert.deepEqual(routeFor('localhost', ''), { endpoint: null, log: true });
  assert.deepEqual(routeFor('127.0.0.1', '?metrics=test'), { endpoint: COLLECTOR, log: false });
  assert.deepEqual(routeFor('deploy-preview-4--site.netlify.app', ''), { endpoint: null, log: false });
  assert.deepEqual(routeFor('deploy-preview-4--site.netlify.app', '?metrics=test'), { endpoint: COLLECTOR, log: false });
  assert.deepEqual(routeFor('192.168.1.20', ''), { endpoint: null, log: false });
});

test('the adapter creates the helper for game solitaire with the Settings version', () => {
  let opts;
  createSolitaireMetrics({ hostname: 'solitaire.mikesgames.app', search: '', appVersion: '2026.09.24.0048', create: o => (opts = o) });
  assert.equal(opts.game, 'solitaire');
  assert.equal(opts.appVersion, '2026.09.24.0048');
  assert.equal(opts.endpoint, COLLECTOR);
  assert.equal(opts.log, null);
});

test('script.js loads metrics lazily, never statically', () => {
  assert.doesNotMatch(js, /import[^;]*from\s*['"]\.\/(metrics|mike-metrics)\.js['"]/);
  assert.match(js, /import\(\s*'\.\/metrics\.js'\s*\)/);
  assert.match(js, /\.catch\(\(\) => \{\}\)/);
});

test('start is sent only from pushHistory, completion only from a genuine win in checkWin', () => {
  assert.equal(js.match(/metrics\?\.started\(/g).length, 1);
  assert.equal(js.match(/metrics\?\.completed\(/g).length, 1);
  assert.equal((js.match(/metrics\?\.[a-z]/g) || []).length, 2, 'no other metrics calls');
  assert.match(body('pushHistory'), /metrics\?\.started\(metricsDealId, \{ mode: metricsDealMode \}\)/);
  assert.match(body('checkWin'), /if \(justWonGenuinely\) metrics\?\.completed\(metricsDealId, \{ mode: metricsDealMode \}\)/);
});

test('a new instance begins only in newGame; restart keeps the deal and its mode', () => {
  assert.equal(js.match(/metricsDealId \+= 1/g).length, 1);
  assert.match(body('newGame'), /metricsDealId \+= 1/);
  assert.match(body('newGame'), /metricsDealMode = currentDrawModeKey\(\)/);
  assert.doesNotMatch(body('restart'), /metricsDeal/);
  assert.doesNotMatch(body('undo'), /metricsDeal|metrics\?/);
});

test('Force Win never reaches a start and is excluded from completion', () => {
  const force = body('forceWinForTesting');
  assert.doesNotMatch(force, /pushHistory|metrics/);
  assert.match(force, /skipNextStatsRecord = true/);
});

// Scenario walk at the seams (METRICS §5), with the real helper and a capturing sender.
function page() {
  const sent = [];
  const m = createMetrics({ game: 'solitaire', appVersion: 'x', endpoint: 'https://c/e', send: (u, b) => sent.push(JSON.parse(b).event) });
  let dealId = 0, mode = null;
  return {
    sent,
    newGame(drawMode = 'draw1') { dealId += 1; mode = drawMode; },
    move() { m.started(dealId, { mode }); },
    win(genuine = true) { if (genuine) m.completed(dealId, { mode }); },
  };
}
const count = sent => [sent.filter(e => e === 'game_started').length, sent.filter(e => e === 'game_completed').length];

test('scenario: launch, look, leave -> 0 / 0', () => {
  const p = page(); p.newGame();
  assert.deepEqual(count(p.sent), [0, 0]);
});

test('scenario: one meaningful action -> 1 / 0; more actions add nothing', () => {
  const p = page(); p.newGame(); p.move(); p.move(); p.move();
  assert.deepEqual(count(p.sent), [1, 0]);
});

test('scenario: play to a win -> 1 / 1; then a new game and one action -> 2 / 1', () => {
  const p = page(); p.newGame(); p.move(); p.win();
  assert.deepEqual(count(p.sent), [1, 1]);
  p.newGame(); p.move();
  assert.deepEqual(count(p.sent), [2, 1]);
});

test('scenario: restart then win -> 1 / 1 for the deal; a repeated win adds nothing', () => {
  const p = page(); p.newGame(); p.move(); /* restart keeps the deal */ p.move(); p.win(); p.win();
  assert.deepEqual(count(p.sent), [1, 1]);
});

test('scenario: reload mid-game (non-resumable) -> +0 until the new deal is played', () => {
  const before = page(); before.newGame(); before.move();
  const after = page(); after.newGame(); // a reload is a fresh page with a fresh deal
  assert.deepEqual(count(after.sent), [0, 0]);
  after.move();
  assert.deepEqual(count(after.sent), [1, 0]);
});

test('scenario: Force Win -> 0 completions', () => {
  const p = page(); p.newGame(); p.win(false);
  assert.deepEqual(count(p.sent), [0, 0]);
});

test('scenario: change mode mid-deal, then win -> completion carries the deal-time mode', () => {
  const sent = [];
  const m = createMetrics({ game: 'solitaire', endpoint: 'https://c/e', send: (u, b) => sent.push(JSON.parse(b)) });
  m.started(1, { mode: 'draw3' });
  m.completed(1, { mode: 'draw1' });
  assert.equal(sent[1].mode, 'draw3');
});

test('installation ID: one per Solitaire installation, stored under its own key, sent with both events', () => {
  const m = new Map();
  const storage = { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
  const sent = [];
  const metrics = createMetrics({ game: 'solitaire', endpoint: 'https://c/e', storage, send: (u, b) => sent.push(JSON.parse(b)) });
  metrics.started(1, { mode: 'draw1' }); metrics.completed(1);
  assert.deepEqual([...m.keys()], ['mike-metrics:install-id:solitaire']);
  assert.equal(sent[0].install_id, m.get('mike-metrics:install-id:solitaire'));
  assert.equal(sent[1].install_id, sent[0].install_id);
});

test('installation ID never enters a backup', () => {
  const backup = readFileSync(new URL('./backup.js', import.meta.url), 'utf8');
  assert.doesNotMatch(backup, /mike-metrics|install-id/);
});

test('installation ID: a new deal, a restart or a reload never changes it; only one key is ever stored', () => {
  const m = new Map();
  const storage = { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
  const ids = [];
  const page = () => createMetrics({ game: 'solitaire', endpoint: 'https://c/e', storage, send: (u, b) => ids.push(JSON.parse(b).install_id) });
  const first = page();
  first.started(1, { mode: 'draw1' });            // first deal
  first.started(1, { mode: 'draw1' });            // restart keeps the deal: no new event
  first.started(2, { mode: 'draw1' }); first.completed(2); // a new deal, won
  const afterReload = page();                     // a reload is a fresh page on the same installation
  afterReload.started(1, { mode: 'draw3' });
  assert.equal(ids.length, 4);
  assert.equal(new Set(ids).size, 1);
  assert.equal(m.size, 1);
});
