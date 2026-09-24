import test from 'node:test';
import assert from 'node:assert/strict';
import { rebaseRectsForScroll } from './tableau-scroll.js';

test('a destination measured while #tableau was scrolled lands where the card really is after a collapse', () => {
  // The reproduced iPad case: an expanded column scrolled 324px, a drop
  // into it measured there, then commitMove collapses it and #tableau's
  // scroll snaps to 0 - every tableau card is now 324px lower on screen.
  const measured = [{ left: 500, top: -120 }, { left: 500, top: -96 }];
  const landing = rebaseRectsForScroll(measured, 324, 0);
  assert.deepEqual(landing, [{ left: 500, top: 204 }, { left: 500, top: 228 }]);
});

test('no scroll change means the same rects come back untouched', () => {
  const measured = [{ left: 10, top: 20 }];
  assert.equal(rebaseRectsForScroll(measured, 0, 0), measured);
  assert.equal(rebaseRectsForScroll(measured, 150, 150), measured);
});

test('scrolling the other way shifts the other way', () => {
  assert.deepEqual(rebaseRectsForScroll([{ left: 0, top: 300 }], 0, 80), [{ left: 0, top: 220 }]);
});

test('never mutates the measured rects, and never moves anything horizontally', () => {
  const measured = [{ left: 42, top: 7 }];
  const landing = rebaseRectsForScroll(measured, 100, 0);
  assert.deepEqual(measured, [{ left: 42, top: 7 }]);
  assert.equal(landing[0].left, 42);
});

test('accepts DOMRect-like objects whose fields are getters, not own properties', () => {
  // getBoundingClientRect() returns a DOMRect: spreading one copies
  // nothing, so the helper has to read left/top explicitly.
  class FakeDOMRect {
    get left() { return 5; }
    get top() { return 10; }
  }
  assert.deepEqual(rebaseRectsForScroll([new FakeDOMRect()], 30, 0), [{ left: 5, top: 40 }]);
});
