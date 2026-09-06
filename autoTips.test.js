import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TIP_CATALOG,
  TIP_TRIGGER_THRESHOLD,
  createAutoTipState,
  recordTipTrigger,
  recordRuleDemonstrated,
} from './autoTips.js';

// Pure-logic tests only, same split as game-logic.test.js/stats.test.js:
// script.js supplies the actual persistence (none - see createAutoTipState's
// own comment) and rendering; everything decided here is expressible
// against these plain functions.

test('createAutoTipState: zeroed counts, nothing shown yet, one entry per catalog category', () => {
  const s = createAutoTipState();
  for (const category of Object.keys(TIP_CATALOG)) {
    assert.equal(s.counts[category], 0);
    assert.equal(s.shown[category], false);
  }
});

test('a single failed attempt does not trigger a tip', () => {
  const s = createAutoTipState();
  const { nextState, tipId } = recordTipTrigger(s, 'wrong_rank');
  assert.equal(tipId, null);
  assert.equal(nextState.counts.wrong_rank, 1);
  assert.equal(nextState.shown.wrong_rank, false);
});

test('a repeated same-category failure reaching the threshold triggers exactly that tip', () => {
  let s = createAutoTipState();
  for (let i = 1; i < TIP_TRIGGER_THRESHOLD; i++) {
    const r = recordTipTrigger(s, 'same_color');
    assert.equal(r.tipId, null);
    s = r.nextState;
  }
  const r = recordTipTrigger(s, 'same_color');
  assert.equal(r.tipId, 'same_color');
  assert.equal(r.nextState.shown.same_color, true);
  assert.equal(r.nextState.counts.same_color, 0); // consumed, not left sitting at the threshold
});

test('unrelated failure categories never combine into a single count', () => {
  let s = createAutoTipState();
  ({ nextState: s } = recordTipTrigger(s, 'wrong_rank'));
  ({ nextState: s } = recordTipTrigger(s, 'covered_card'));
  // One failure in each of two different categories - neither has reached
  // its own threshold, and they must not have been added together.
  assert.equal(s.counts.wrong_rank, 1);
  assert.equal(s.counts.covered_card, 1);
  const r = recordTipTrigger(s, 'needs_king_on_empty');
  assert.equal(r.tipId, null);
});

test('a tip already shown this deal does not fire again, no matter how many more times the category fails', () => {
  let s = createAutoTipState();
  for (let i = 0; i < TIP_TRIGGER_THRESHOLD; i++) {
    ({ nextState: s } = recordTipTrigger(s, 'needs_king_on_empty'));
  }
  assert.equal(s.shown.needs_king_on_empty, true);
  for (let i = 0; i < 5; i++) {
    const r = recordTipTrigger(s, 'needs_king_on_empty');
    assert.equal(r.tipId, null);
    s = r.nextState;
  }
});

test('recordRuleDemonstrated resets the given categories\' counts but never their shown flag', () => {
  let s = createAutoTipState();
  ({ nextState: s } = recordTipTrigger(s, 'same_color')); // count -> 1, not yet shown
  for (let i = 0; i < TIP_TRIGGER_THRESHOLD; i++) {
    ({ nextState: s } = recordTipTrigger(s, 'wrong_rank'));
  }
  assert.equal(s.shown.wrong_rank, true);

  s = recordRuleDemonstrated(s, ['same_color', 'wrong_rank']);
  assert.equal(s.counts.same_color, 0);
  assert.equal(s.counts.wrong_rank, 0);
  assert.equal(s.shown.wrong_rank, true); // still suppressed for the rest of this deal

  // A fresh miss after the reset needs the full threshold again, not just one more.
  const r = recordTipTrigger(s, 'same_color');
  assert.equal(r.tipId, null);
  assert.equal(r.nextState.counts.same_color, 1);
});

test('recordRuleDemonstrated with no categories is a harmless no-op', () => {
  const s = createAutoTipState();
  assert.deepEqual(recordRuleDemonstrated(s, []), s);
});

test('recordTipTrigger ignores an unknown category rather than throwing', () => {
  const s = createAutoTipState();
  const r = recordTipTrigger(s, 'not_a_real_category');
  assert.equal(r.tipId, null);
  assert.deepEqual(r.nextState, s);
});
