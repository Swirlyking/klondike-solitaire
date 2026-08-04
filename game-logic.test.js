import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canPlaceOnFoundation,
  anyFoundationFor,
  canPlaceOnTableau,
  getStackFrom,
  findAnyLegalTableau,
  findAllLegalTableau,
  nextCycleIndex,
  resolveClickDestination,
  flipNewTopIfNeeded,
  applyMove,
  cloneState,
} from './game-logic.js';

let nextId = 0;
function card(suit, rank, faceUp = true) {
  const color = suit === 'hearts' || suit === 'diamonds' ? 'red' : 'black';
  return { id: nextId++, suit, color, rank, faceUp };
}

// Empty 7-column, empty-foundation state; tests fill in only what they need.
function emptyState() {
  return {
    stock: [],
    waste: [],
    foundations: [[], [], [], []],
    tableau: [[], [], [], [], [], [], []],
  };
}

test('1. waste card with two legal tableau destinations moves to the leftmost', () => {
  const s = emptyState();
  const seven = card('hearts', 7); // red 7 — legal on any black 8
  s.waste = [seven];
  s.tableau[2] = [card('spades', 8)];  // black 8, column 2
  s.tableau[5] = [card('clubs', 8)];   // black 8, column 5
  const dest = resolveClickDestination(s, seven, 'waste', null, 1);
  assert.deepEqual(dest, { type: 'tableau', index: 2 });
});

test('2. clicking again cycles to the next legal tableau destination, including leftward', () => {
  // A non-Ace card sitting in the tableau with its only next destination to
  // its LEFT must still be reachable by clicking, not skipped just because
  // it isn't to the right.
  const s = emptyState();
  const nineHearts = card('hearts', 9); // red 9
  s.tableau[2] = [nineHearts]; // sitting in column 2 (e.g. dealt there)
  s.tableau[0] = [card('spades', 10)]; // black 10, to the LEFT
  s.tableau[5] = [card('clubs', 10)];  // black 10, to the right

  // First click: no memory yet, so it takes the leftmost legal destination
  // even though that's behind where it started.
  const dest1 = resolveClickDestination(s, nineHearts, 'tableau', 2, 1, null);
  assert.deepEqual(dest1, { type: 'tableau', index: 0 });

  // Simulate the move landing, then click again: remembering it was last
  // sent to column 0, the next click should advance to column 5, not back
  // to column 2 (empty, illegal for a non-King anyway) or stay at 0.
  s.tableau[2] = [];
  s.tableau[0] = [card('spades', 10), nineHearts];
  const dest2 = resolveClickDestination(s, nineHearts, 'tableau', 0, 1, 0);
  assert.deepEqual(dest2, { type: 'tableau', index: 5 });

  // One more click: no legal destination greater than 5 remains, so the
  // cycle wraps back around to the leftmost (column 0), not the foundation.
  s.tableau[0] = [card('spades', 10)];
  s.tableau[5] = [card('clubs', 10), nineHearts];
  const dest3 = resolveClickDestination(s, nineHearts, 'tableau', 5, 1, 5);
  assert.deepEqual(dest3, { type: 'tableau', index: 0 });
});

test('2b. an Ace always clicks to the foundation, even when a legal tableau spot exists', () => {
  const s = emptyState();
  const aceHearts = card('hearts', 1);

  // From the waste, with BOTH a legal tableau destination and an empty
  // foundation available — foundation wins outright, unlike a normal card.
  s.waste = [aceHearts];
  s.tableau[3] = [card('clubs', 2)]; // black 2 would legally accept this ace
  const destFromWaste = resolveClickDestination(s, aceHearts, 'waste', null, 1);
  assert.deepEqual(destFromWaste, { type: 'foundation', index: 0 });

  // From the tableau too — cycling never applies to an Ace.
  s.waste = [];
  s.tableau[2] = [aceHearts];
  const destFromTableau = resolveClickDestination(s, aceHearts, 'tableau', 2, 1);
  assert.deepEqual(destFromTableau, { type: 'foundation', index: 0 });
});

test('2c. an Ace already resting in a foundation has no click destination', () => {
  const s = emptyState();
  const aceHearts = card('hearts', 1);
  s.foundations[0] = [aceHearts];
  s.tableau[3] = [card('clubs', 2)]; // even with a legal tableau spot available
  const dest = resolveClickDestination(s, aceHearts, 'foundation', 0, 1);
  assert.equal(dest, null);
});

test('3. no legal tableau destination -> moves to a foundation', () => {
  const s = emptyState();
  const two = card('hearts', 2);
  s.tableau[4] = [two];
  s.foundations[1] = [card('hearts', 1)]; // ace of hearts already down, ready for the 2
  const dest = resolveClickDestination(s, two, 'tableau', 4, 1, null);
  assert.deepEqual(dest, { type: 'foundation', index: 1 });
});

test('4. foundation is not preferred over an available tableau move', () => {
  const s = emptyState();
  const two = card('hearts', 2);
  s.waste = [two];
  s.tableau[3] = [card('clubs', 3)]; // black 3 accepts red 2
  s.foundations[1] = [card('hearts', 1)]; // a foundation move IS also legal here
  const dest = resolveClickDestination(s, two, 'waste', null, 1);
  assert.deepEqual(dest, { type: 'tableau', index: 3 });
});

test('5a. a tableau sequence moves together when its first card is clicked', () => {
  const s = emptyState();
  const black8 = card('spades', 8);
  const redSeven = card('hearts', 7);
  s.tableau[0] = [black8, redSeven]; // valid built sequence: 8♠, 7♥
  s.tableau[3] = [card('diamonds', 9)]; // red 9 accepts the whole 8♠-7♥ sequence
  const stack = getStackFrom(s, 'tableau', 0, black8);
  assert.deepEqual(stack.map(c => c.id), [black8.id, redSeven.id]);
  const dest = resolveClickDestination(s, stack[0], 'tableau', 0, stack.length);
  assert.deepEqual(dest, { type: 'tableau', index: 3 });
});

test('5b. foundations are never offered for a multi-card sequence', () => {
  const s = emptyState();
  const black8 = card('spades', 8);
  const redSeven = card('hearts', 7);
  s.tableau[0] = [black8, redSeven];
  // No rightward tableau destination exists, but an ace-started foundation
  // would happily accept the black8 alone — it must still be refused
  // because this is a 2-card sequence.
  s.foundations[3] = [card('spades', 1)];
  const dest = resolveClickDestination(s, black8, 'tableau', 0, 2);
  assert.equal(dest, null);
});

test('6. an illegal click does nothing', () => {
  const s = emptyState();
  // A 7 has no legal home here: empty columns only accept a King, and no
  // foundation accepts anything but an Ace when empty.
  const seven = card('hearts', 7);
  s.tableau[0] = [seven];
  const dest = resolveClickDestination(s, seven, 'tableau', 0, 1);
  assert.equal(dest, null);
});

test('8. any Ace can occupy any empty foundation slot, leftmost first', () => {
  const s = emptyState();
  const aceOfSpades = card('spades', 1);
  assert.equal(anyFoundationFor(s, aceOfSpades), 0);
  assert.ok(canPlaceOnFoundation(s, aceOfSpades, 0));
  assert.ok(canPlaceOnFoundation(s, aceOfSpades, 3));

  s.foundations[0] = [card('hearts', 1)]; // slot 0 now taken by hearts
  assert.equal(anyFoundationFor(s, aceOfSpades), 1); // next ace still finds the next empty slot, any suit
});

test('9. an occupied foundation stays locked to its starting suit', () => {
  const s = emptyState();
  s.foundations[0] = [card('hearts', 1)]; // slot 0 locked to hearts by its ace
  const twoHearts = card('hearts', 2);
  const twoSpades = card('spades', 2);
  assert.ok(canPlaceOnFoundation(s, twoHearts, 0));
  assert.equal(canPlaceOnFoundation(s, twoSpades, 0), false);
});

test('empty tableau columns only accept a King (or a sequence starting with one)', () => {
  const s = emptyState();
  assert.equal(canPlaceOnTableau(s, card('hearts', 12), 0), false); // queen
  assert.ok(canPlaceOnTableau(s, card('hearts', 13), 0)); // king
});

test('a King relocating between tableau columns only ever targets an empty column to its right, never its left', () => {
  const s = emptyState();
  const king = card('spades', 13);
  s.tableau[3] = [king]; // King's own column
  s.tableau[0] = [card('hearts', 5)]; // occupied
  s.tableau[2] = [card('hearts', 5)]; // occupied
  s.tableau[4] = [card('hearts', 5)]; // occupied
  s.tableau[6] = [card('hearts', 5)]; // occupied
  // column 1 is empty and to the LEFT - must never be offered by click
  // column 5 is empty and to the RIGHT - the only legal click destination
  const dest = resolveClickDestination(s, king, 'tableau', 3, 1, null);
  assert.deepEqual(dest, { type: 'tableau', index: 5 });
});

test('a King with no empty column to its right has no click destination, even with one to its left', () => {
  const s = emptyState();
  const king = card('hearts', 13);
  s.tableau[5] = [king]; // King's own column
  s.tableau[0] = [card('clubs', 5)];
  s.tableau[2] = [card('clubs', 5)];
  s.tableau[3] = [card('clubs', 5)];
  s.tableau[4] = [card('clubs', 5)];
  s.tableau[6] = [card('clubs', 5)];
  // column 1 is empty but to the LEFT of column 5 - not a legal click target
  const dest = resolveClickDestination(s, king, 'tableau', 5, 1, null);
  assert.equal(dest, null);
});

test('a King cycles through multiple empty columns to its right, in order', () => {
  const s = emptyState();
  const king = card('diamonds', 13);
  s.tableau[0] = [king]; // King's own column
  s.tableau[1] = [card('clubs', 5)]; // occupied
  s.tableau[3] = [card('clubs', 5)]; // occupied
  // columns 2, 4, 5, 6 are empty and to the right
  const dest1 = resolveClickDestination(s, king, 'tableau', 0, 1, null);
  assert.deepEqual(dest1, { type: 'tableau', index: 2 });
  const dest2 = resolveClickDestination(s, king, 'tableau', 0, 1, 2);
  assert.deepEqual(dest2, { type: 'tableau', index: 4 });
});

test('empty tableau columns participate in normal left-to-right priority', () => {
  const s = emptyState();
  const king = card('clubs', 13);
  s.tableau[1] = [card('spades', 5)]; // occupied, illegal for a king
  // column 0 is empty and therefore the leftmost legal destination
  assert.equal(findAnyLegalTableau(s, king), 0);
});

test('findAllLegalTableau finds every legal column, both sides, excluding the source', () => {
  const s = emptyState();
  const redSeven = card('diamonds', 7);
  s.tableau[0] = [card('clubs', 8)];   // legal, to the left of column 3
  s.tableau[3] = [redSeven];           // the card's own column — must be excluded
  s.tableau[5] = [card('spades', 8)];  // legal, to the right
  assert.deepEqual(findAllLegalTableau(s, redSeven, 3), [0, 5]);
});

test('nextCycleIndex advances past the remembered destination and wraps at the end', () => {
  const legal = [0, 3, 5];
  assert.equal(nextCycleIndex(legal, null), 0);  // no memory yet: leftmost
  assert.equal(nextCycleIndex(legal, 0), 3);     // advance
  assert.equal(nextCycleIndex(legal, 3), 5);     // advance
  assert.equal(nextCycleIndex(legal, 5), 0);     // past the end: wrap to leftmost
  assert.equal(nextCycleIndex(legal, 4), 5);     // stale/unrelated value still works as a threshold
  assert.equal(nextCycleIndex([], 0), -1);       // nothing legal at all
});

test('applyMove + flipNewTopIfNeeded exposes and flips the newly uncovered tableau card', () => {
  const s = emptyState();
  const buried = card('clubs', 9, false); // face-down
  const mover = card('hearts', 8);
  s.tableau[0] = [buried, mover];
  s.tableau[1] = [card('spades', 9)];

  const stack = getStackFrom(s, 'tableau', 0, mover);
  applyMove(s, stack, 'tableau', 0, 'tableau', 1);

  assert.deepEqual(s.tableau[0].map(c => c.id), [buried.id]);
  assert.equal(s.tableau[0][0].faceUp, true); // exposed and flipped by applyMove -> removeFromSource
  assert.deepEqual(s.tableau[1].map(c => c.id), [s.tableau[1][0].id, mover.id]);
});

test('applyMove preserves order for a multi-card sequence', () => {
  const s = emptyState();
  const black8 = card('spades', 8);
  const redSeven = card('hearts', 7);
  s.tableau[0] = [black8, redSeven];
  s.tableau[1] = [card('clubs', 9)];

  const stack = getStackFrom(s, 'tableau', 0, black8);
  applyMove(s, stack, 'tableau', 0, 'tableau', 1);

  assert.deepEqual(s.tableau[1].slice(1).map(c => c.id), [black8.id, redSeven.id]);
});

test('cloneState + applyMove round-trip supports undo (deep, independent copies)', () => {
  const s = emptyState();
  const ace = card('hearts', 1);
  s.waste = [ace];
  const before = cloneState(s);

  applyMove(s, [ace], 'waste', null, 'foundation', 0);
  assert.equal(s.waste.length, 0);
  assert.equal(s.foundations[0].length, 1);

  // Undo = restore the pre-move snapshot; the snapshot must be unaffected
  // by the mutation that happened after it was taken.
  assert.equal(before.waste.length, 1);
  assert.equal(before.foundations[0].length, 0);

  const restored = before;
  assert.deepEqual(restored.waste.map(c => c.id), [ace.id]);
  assert.equal(restored.foundations[0].length, 0);
});

test('a foundation-sourced card only ever considers tableau destinations', () => {
  const s = emptyState();
  const two = card('hearts', 2);
  s.foundations[0] = [card('hearts', 1), two];
  // No legal tableau destination exists for this red 2 (no black 3 exposed) —
  // resolveClickDestination must NOT fall back to trying another foundation.
  const dest = resolveClickDestination(s, two, 'foundation', 0, 1);
  assert.equal(dest, null);

  s.tableau[4] = [card('clubs', 3)]; // now a legal tableau destination exists
  const dest2 = resolveClickDestination(s, two, 'foundation', 0, 1);
  assert.deepEqual(dest2, { type: 'tableau', index: 4 });
});
