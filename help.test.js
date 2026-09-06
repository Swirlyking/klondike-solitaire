import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HELP_CATALOG, helpConceptForTarget } from './help.js';
import { TIP_CATALOG } from './autoTips.js';

// Pure-logic tests only, same split as autoTips.test.js/game-logic.test.js:
// script.js supplies the actual mode toggle, DOM wiring, and rendering -
// everything decided here is expressible against these plain values/functions.

test('HELP_CATALOG has a headline and body for every supported concept', () => {
  for (const key of ['stock', 'waste', 'tableau', 'hidden_card', 'empty_column', 'foundation']) {
    const entry = HELP_CATALOG[key];
    assert.ok(entry, `missing catalog entry for ${key}`);
    assert.equal(typeof entry.headline, 'string');
    assert.ok(entry.headline.length > 0);
    assert.equal(typeof entry.body, 'string');
    assert.ok(entry.body.length > 0);
  }
});

test('empty_column reuses needs_king_on_empty\'s body rather than duplicating the string', () => {
  assert.equal(HELP_CATALOG.empty_column.body, TIP_CATALOG.needs_king_on_empty.body);
});

test('helpConceptForTarget: stock/waste/foundation map to themselves regardless of faceUp/isEmpty', () => {
  assert.equal(helpConceptForTarget('stock'), 'stock');
  assert.equal(helpConceptForTarget('waste'), 'waste');
  assert.equal(helpConceptForTarget('foundation'), 'foundation');
  assert.equal(helpConceptForTarget('waste', { isEmpty: true }), 'waste');
  assert.equal(helpConceptForTarget('foundation', { isEmpty: true }), 'foundation');
});

test('helpConceptForTarget: a face-up tableau card is the tableau concept', () => {
  assert.equal(helpConceptForTarget('tableau', { faceUp: true }), 'tableau');
});

test('helpConceptForTarget: a face-down tableau card is the hidden_card concept', () => {
  assert.equal(helpConceptForTarget('tableau', { faceUp: false }), 'hidden_card');
});

test('helpConceptForTarget: an empty tableau column is the empty_column concept regardless of faceUp', () => {
  assert.equal(helpConceptForTarget('tableau', { isEmpty: true }), 'empty_column');
  assert.equal(helpConceptForTarget('tableau', { isEmpty: true, faceUp: false }), 'empty_column');
});

test('helpConceptForTarget: an unrecognized source returns null rather than throwing', () => {
  assert.equal(helpConceptForTarget('drag-layer'), null);
  assert.equal(helpConceptForTarget(undefined), null);
});

test('every HELP_CATALOG key is reachable from helpConceptForTarget', () => {
  const reachable = new Set([
    helpConceptForTarget('stock'),
    helpConceptForTarget('waste'),
    helpConceptForTarget('foundation'),
    helpConceptForTarget('tableau', { faceUp: true }),
    helpConceptForTarget('tableau', { faceUp: false }),
    helpConceptForTarget('tableau', { isEmpty: true }),
  ]);
  for (const key of Object.keys(HELP_CATALOG)) {
    assert.ok(reachable.has(key), `${key} is never returned by helpConceptForTarget`);
  }
});
