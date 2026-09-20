import { test } from 'node:test';
import assert from 'node:assert/strict';

// card-face-compositor.js only touches Image/document/canvas inside
// function bodies (see its own pure/impure header comment) - importing it
// doesn't need those to exist, but calling its impure functions does.
// This file installs minimal fakes before importing, narrowly scoped to
// proving exactly one thing: the async readiness CONTRACT that a real
// bug turned out to depend on - once ensureFacesReady(card) resolves,
// getComposedFaceSrc for that exact card can never return the
// placeholder again.
//
// That contract matters because a card's flip animation used to grab
// whatever getComposedFaceSrc returned before ever awaiting readiness -
// occasionally the placeholder, caught mid-flip (see script.js's
// animateTableauFlip/onStockClick, and ensureCardsFaceReady). These fakes
// don't simulate real decoding or pixel output; they exist only to make
// that ordering guarantee mechanically checkable under node --test,
// rather than relying on browser testing alone for something a fast,
// deterministic test can also lock in.

const pendingImages = [];

class FakeImage {
  constructor() {
    this._src = '';
    this.naturalWidth = 10;
    this.naturalHeight = 10;
    this._decodePromise = new Promise((resolve, reject) => {
      this._settle = resolve;
      this._fail = reject;
    });
    pendingImages.push(this);
  }
  set src(value) { this._src = value; }
  get src() { return this._src; }
  decode() { return this._decodePromise; }
}

// Settles every fake image constructed since the last call - standing in
// for "the network fetch + decode finished" without any real I/O.
function settleAllPendingImages() {
  pendingImages.splice(0, pendingImages.length).forEach(img => img._settle());
}

const fakeCanvasContext = { drawImage() {}, save() {}, restore() {}, translate() {}, scale() {} };
let dataUrlCounter = 0;
function makeFakeCanvas() {
  return { width: 0, height: 0, getContext: () => fakeCanvasContext, toDataURL: () => `data:image/png;fake,${dataUrlCounter++}` };
}

global.Image = FakeImage;
global.document = {
  createElement(tag) {
    if (tag === 'canvas') return makeFakeCanvas();
    throw new Error(`unexpected document.createElement(${tag}) in readiness test`);
  },
};

const { getComposedFaceSrc, ensureFacesReady } = await import('./card-face-compositor.js');

const DESIGN = { facesBase: 'fake/base', suffix: 'FAKE' };
const SIZE = { width: 10, height: 10 };
function cardId(key) {
  return { key, suitFile: 'heart', rankFile: '1' };
}

test('getComposedFaceSrc: returns the placeholder, not face art, before anything has loaded', () => {
  const src = getComposedFaceSrc(DESIGN, cardId('unready-card'), 'worn', SIZE, 'v1');
  assert.ok(!src.startsWith('data:'), 'must not be a real composite yet - nothing has been settled');
});

test('ensureFacesReady: does not resolve before the underlying images settle', async () => {
  const id = cardId('slow-card');
  const readyPromise = ensureFacesReady(DESIGN, [id], 'worn', SIZE, 'v1');
  let settledEarly = false;
  readyPromise.then(() => { settledEarly = true; });
  await Promise.resolve();
  assert.equal(settledEarly, false);
  settleAllPendingImages();
  await readyPromise; // drains the queued microtask flip above too
  assert.equal(settledEarly, true);
});

test('ensureFacesReady: once resolved, getComposedFaceSrc for that exact card never returns the placeholder again - the guarantee the flip-animation fix depends on', async () => {
  const id = cardId('ready-card');
  const readyPromise = ensureFacesReady(DESIGN, [id], 'worn', SIZE, 'v1');
  settleAllPendingImages();
  await readyPromise;

  const src = getComposedFaceSrc(DESIGN, id, 'worn', SIZE, 'v1');
  assert.ok(src.startsWith('data:'), 'must be a real composite immediately after ensureFacesReady resolves');
});

test('ensureFacesReady: a card whose composite is already cached resolves without loading anything new', async () => {
  const id = cardId('cached-card');
  const first = ensureFacesReady(DESIGN, [id], 'worn', SIZE, 'v1');
  settleAllPendingImages();
  await first;
  const beforeSrc = getComposedFaceSrc(DESIGN, id, 'worn', SIZE, 'v1');

  await ensureFacesReady(DESIGN, [id], 'worn', SIZE, 'v1');
  assert.equal(pendingImages.length, 0, 'an already-cached card must not kick off any new image load');
  assert.equal(getComposedFaceSrc(DESIGN, id, 'worn', SIZE, 'v1'), beforeSrc);
});
