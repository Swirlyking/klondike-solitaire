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
  needsAbandonConfirmation,
  getLegalMoves,
  classifyMove,
  MoveCategory,
  autoFinishAvailable,
  rankMoves,
  getProgressingMoves,
  nextAutoFinishMove,
  isKingColumnSwap,
  applyKingColumnSwap,
  isKingLedColumn,
  computeKingCascade,
} from './game-logic.js';

let nextId = 0;
function card(suit, rank, faceUp = true) {
  const color = suit === 'hearts' || suit === 'diamonds' ? 'red' : 'black';
  return { id: nextId++, suit, color, rank, faceUp };
}

// getProgressingMoves calls getLegalMoves internally, producing fresh move
// objects each time - never the same references a test's own getLegalMoves
// call returns. Compare by content, not by identity.
function sameMove(a, b) {
  return a.category === b.category && a.source === b.source && a.sourceIndex === b.sourceIndex
    && (a.card ? a.card.id : null) === (b.card ? b.card.id : null)
    && a.target === b.target && a.targetIndex === b.targetIndex;
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

test('1. waste card with two legal tableau destinations follows WASTE_TABLEAU_PRIORITY, not left-to-right', () => {
  const s = emptyState();
  const seven = card('hearts', 7); // red 7 — legal on any black 8
  s.waste = [seven];
  s.tableau[2] = [card('spades', 8)];  // black 8, column 2
  s.tableau[5] = [card('clubs', 8)];   // black 8, column 5
  // Column 2 comes before column 5 in the priority order [3,4,2,5,1,6,0],
  // so this happens to match plain left-to-right too - see the dedicated
  // priority-order tests below for cases where it doesn't.
  const dest = resolveClickDestination(s, seven, 'waste', null, 1);
  assert.deepEqual(dest, { type: 'tableau', index: 2 });
});

// ---------- waste click-to-move: WASTE_TABLEAU_PRIORITY (middle-out, not left-to-right) ----------

test('waste click-to-move searches tableau columns in exactly [3, 4, 2, 5, 1, 6, 0], then the foundation', () => {
  const s = emptyState();
  const eight = card('hearts', 8); // red 8 - legal on any black 9
  s.waste = [eight];
  s.foundations[1] = [
    card('hearts', 1), card('hearts', 2), card('hearts', 3), card('hearts', 4),
    card('hearts', 5), card('hearts', 6), card('hearts', 7),
  ]; // hearts foundation ready for this 8 too, once no tableau column works

  // Every column starts as a legal destination (alternating black suit so
  // each is independently a valid landing spot for the red 8).
  [0, 1, 2, 3, 4, 5, 6].forEach(i => {
    s.tableau[i] = [card(i % 2 === 0 ? 'spades' : 'clubs', 9)];
  });

  const expectedOrder = [3, 4, 2, 5, 1, 6, 0];
  for (const expectedIndex of expectedOrder) {
    const dest = resolveClickDestination(s, eight, 'waste', null, 1);
    assert.deepEqual(dest, { type: 'tableau', index: expectedIndex });
    s.tableau[expectedIndex] = []; // that column is no longer legal - the next call must move on to the next priority entry
  }

  // Every tableau column has now been exhausted - only the foundation is left.
  const finalDest = resolveClickDestination(s, eight, 'waste', null, 1);
  assert.deepEqual(finalDest, { type: 'foundation', index: 1 });
});

test('waste click-to-move: with only columns 0 and 6 legal, picks 6 (priority), not 0 (leftmost)', () => {
  const s = emptyState();
  const eight = card('hearts', 8);
  s.waste = [eight];
  s.tableau[0] = [card('spades', 9)];
  s.tableau[6] = [card('clubs', 9)];
  const dest = resolveClickDestination(s, eight, 'waste', null, 1);
  assert.deepEqual(dest, { type: 'tableau', index: 6 });
});

test('waste click-to-move: with only column 0 legal, still picks it (end of priority list, not skipped)', () => {
  const s = emptyState();
  const eight = card('hearts', 8);
  s.waste = [eight];
  s.tableau[0] = [card('spades', 9)];
  const dest = resolveClickDestination(s, eight, 'waste', null, 1);
  assert.deepEqual(dest, { type: 'tableau', index: 0 });
});

test('tableau-sourced and foundation-sourced click-to-move are unaffected by WASTE_TABLEAU_PRIORITY - both still pick the leftmost legal column', () => {
  const eight = card('hearts', 8);

  const sTableau = emptyState();
  sTableau.tableau[0] = [eight];
  sTableau.tableau[6] = [card('clubs', 9)];
  sTableau.tableau[3] = [card('spades', 9)];
  const fromTableau = resolveClickDestination(sTableau, eight, 'tableau', 0, 1, null);
  assert.deepEqual(fromTableau, { type: 'tableau', index: 3 }); // leftmost of {3, 6}, not priority-order

  const sFoundation = emptyState();
  sFoundation.foundations[1] = [card('hearts', 1), card('hearts', 2), card('hearts', 3), card('hearts', 4), card('hearts', 5), card('hearts', 6), eight];
  sFoundation.tableau[6] = [card('clubs', 9)];
  sFoundation.tableau[3] = [card('spades', 9)];
  const fromFoundation = resolveClickDestination(sFoundation, eight, 'foundation', 1, 1);
  assert.deepEqual(fromFoundation, { type: 'tableau', index: 3 }); // leftmost of {3, 6}, not priority-order
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

test('4. for most ranks, foundation is not preferred over an available tableau move', () => {
  const s = emptyState();
  const seven = card('hearts', 7);
  s.waste = [seven];
  s.tableau[3] = [card('spades', 8)]; // black 8 accepts red 7
  s.foundations[1] = [card('hearts', 1), card('hearts', 2), card('hearts', 3), card('hearts', 4), card('hearts', 5), card('hearts', 6)]; // a foundation move IS also legal here
  const dest = resolveClickDestination(s, seven, 'waste', null, 1);
  assert.deepEqual(dest, { type: 'tableau', index: 3 });
});

test('4b. a 2 clicks straight to the foundation from the waste, even when a legal tableau spot exists', () => {
  const s = emptyState();
  const two = card('hearts', 2);
  s.waste = [two];
  s.tableau[3] = [card('clubs', 3)]; // black 3 would also legally accept this red 2
  s.foundations[1] = [card('hearts', 1)]; // a foundation move IS also legal here
  const dest = resolveClickDestination(s, two, 'waste', null, 1);
  assert.deepEqual(dest, { type: 'foundation', index: 1 });
});

test('a waste card with no legal tableau destination falls back to the foundation', () => {
  const s = emptyState();
  const two = card('hearts', 2);
  s.waste = [two];
  s.foundations[1] = [card('hearts', 1)]; // ready for the 2
  // no black 3 exposed anywhere - no legal tableau destination
  const dest = resolveClickDestination(s, two, 'waste', null, 1);
  assert.deepEqual(dest, { type: 'foundation', index: 1 });
});

// ---------- tableau click priority: foundation first, tableau as fallback ----------

test('a single tableau card legal for both foundation and tableau goes to the foundation', () => {
  const s = emptyState();
  const two = card('hearts', 2);
  s.tableau[0] = [two];
  s.tableau[3] = [card('clubs', 3)]; // black 3 would also legally accept this red 2
  s.foundations[1] = [card('hearts', 1)]; // hearts foundation ready for the 2
  const dest = resolveClickDestination(s, two, 'tableau', 0, 1, null);
  assert.deepEqual(dest, { type: 'foundation', index: 1 });
});

test('a single tableau card with no legal foundation move falls back to a legal tableau column', () => {
  const s = emptyState();
  const two = card('hearts', 2);
  s.tableau[0] = [two];
  s.tableau[3] = [card('clubs', 3)]; // black 3 accepts the red 2
  s.foundations[1] = [card('clubs', 1)]; // present, but the wrong suit for this red 2 - not a legal foundation move
  const dest = resolveClickDestination(s, two, 'tableau', 0, 1, null);
  assert.deepEqual(dest, { type: 'tableau', index: 3 });
});

test('a multi-card cascade with a foundation-eligible lead card still only considers the tableau', () => {
  const s = emptyState();
  const black8 = card('spades', 8);
  const redSeven = card('hearts', 7);
  s.tableau[0] = [black8, redSeven]; // built sequence: 8♠, 7♥
  s.tableau[3] = [card('diamonds', 9)]; // red 9 accepts the whole sequence
  s.foundations[2] = [card('spades', 7)]; // spades foundation ready for the black 8 alone - must be ignored
  const stack = getStackFrom(s, 'tableau', 0, black8);
  const dest = resolveClickDestination(s, stack[0], 'tableau', 0, stack.length);
  assert.deepEqual(dest, { type: 'tableau', index: 3 });
});

test('a tableau click with no legal destination anywhere does nothing', () => {
  const s = emptyState();
  const seven = card('hearts', 7);
  s.tableau[0] = [seven];
  s.foundations[1] = [card('clubs', 1)]; // present, but wrong suit - no legal foundation move
  // no black 8 exposed anywhere - no legal tableau move either
  const dest = resolveClickDestination(s, seven, 'tableau', 0, 1);
  assert.equal(dest, null);
});

test('a foundation-bound tableau click round-trips cleanly through cloneState + applyMove (the undo pattern)', () => {
  const s = emptyState();
  const two = card('hearts', 2);
  s.tableau[0] = [two];
  s.foundations[1] = [card('hearts', 1)];
  const before = cloneState(s);
  applyMove(s, [two], 'tableau', 0, 'foundation', 1);
  assert.notDeepEqual(s, before);
  const restored = cloneState(before);
  assert.deepEqual(restored, before);
  assert.deepEqual(restored.tableau[0], [two]); // the 2 is back in the tableau
  assert.equal(restored.foundations[1].length, 1); // the foundation is back to just the ace
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

test('a King\'s first click prefers an empty column to its right over one to its left', () => {
  const s = emptyState();
  const king = card('spades', 13);
  s.tableau[3] = [king]; // King's own column
  s.tableau[0] = [card('hearts', 5)]; // occupied
  s.tableau[2] = [card('hearts', 5)]; // occupied
  s.tableau[4] = [card('hearts', 5)]; // occupied
  s.tableau[6] = [card('hearts', 5)]; // occupied
  // column 1 is empty and to the LEFT - available, but not preferred
  // column 5 is empty and to the RIGHT - preferred first
  const dest = resolveClickDestination(s, king, 'tableau', 3, 1, null);
  assert.deepEqual(dest, { type: 'tableau', index: 5 });
});

test('a King cycles rightward through multiple empty columns, in order', () => {
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

test('a King wraps from the rightmost legal destination back to the leftmost, even if that\'s to its left', () => {
  const s = emptyState();
  const king = card('clubs', 13);
  s.tableau[3] = [king]; // King's own column
  s.tableau[0] = [card('hearts', 5)]; // occupied
  s.tableau[2] = [card('hearts', 5)]; // occupied
  s.tableau[4] = [card('hearts', 5)]; // occupied
  s.tableau[6] = [card('hearts', 5)]; // occupied
  // column 1 is empty and to the LEFT; column 5 is empty and to the RIGHT -
  // the only two legal destinations. Already cycled to column 5 (the only
  // right-side option) - the next click has nowhere further right to go,
  // so it wraps all the way around to column 1.
  const dest = resolveClickDestination(s, king, 'tableau', 3, 1, 5);
  assert.deepEqual(dest, { type: 'tableau', index: 1 });
});

test('a King has no click destination when no other legal column exists at all', () => {
  const s = emptyState();
  const king = card('hearts', 13);
  s.tableau[5] = [king]; // King's own column
  // every other column occupied - genuinely nowhere legal to go
  s.tableau[0] = [card('clubs', 5)];
  s.tableau[1] = [card('clubs', 5)];
  s.tableau[2] = [card('clubs', 5)];
  s.tableau[3] = [card('clubs', 5)];
  s.tableau[4] = [card('clubs', 5)];
  s.tableau[6] = [card('clubs', 5)];
  const dest = resolveClickDestination(s, king, 'tableau', 5, 1, null);
  assert.equal(dest, null);
});

test('a King-to-empty-column move round-trips cleanly through cloneState + applyMove (the undo pattern)', () => {
  const s = emptyState();
  const king = card('spades', 13);
  s.tableau[0] = [king];
  const before = cloneState(s);
  applyMove(s, [king], 'tableau', 0, 'tableau', 3);
  assert.notDeepEqual(s, before); // the move actually changed something
  const restored = cloneState(before); // exactly what undo() does: hand back the pre-move snapshot
  assert.deepEqual(restored, before);
  assert.deepEqual(restored.tableau[0], [king]); // King is back in its original column
  assert.deepEqual(restored.tableau[3], []); // the destination column is empty again
});

test('a King-cycling click never affects tableau placement legality, so dragging still reaches columns on either side', () => {
  const s = emptyState();
  const king = card('diamonds', 13);
  s.tableau[3] = [king];
  // canPlaceOnTableau is what drag-and-drop's drop-target check uses
  // directly (script.js's isValidDropTarget) - resolveClickDestination's
  // King-specific ordering never touches it, so both a left-side and a
  // right-side empty column must still be legal *drop* targets regardless
  // of what click-cycling would currently prefer.
  assert.ok(canPlaceOnTableau(s, king, 0)); // left of the King
  assert.ok(canPlaceOnTableau(s, king, 5)); // right of the King
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

// ---------- getLegalMoves: the shared, objective enumeration ----------

test('getLegalMoves enumerates tableau, waste, foundation, and stock moves with correct categories', () => {
  const s = emptyState();
  const redFive = card('hearts', 5);
  s.tableau[0] = [card('spades', 6), redFive]; // black6, red5 on top
  s.tableau[2] = [card('clubs', 6)]; // black6 - a second legal destination for the red5
  const wasteAce = card('spades', 1);
  s.waste = [wasteAce]; // ace -> empty foundation
  s.stock = [card('diamonds', 9)];

  const moves = getLegalMoves(s);

  assert.ok(moves.some(m =>
    m.category === MoveCategory.TABLEAU_MOVE && m.source === 'tableau' && m.sourceIndex === 0 &&
    m.card.id === redFive.id && m.target === 'tableau' && m.targetIndex === 2
  ));
  assert.ok(moves.some(m =>
    m.category === MoveCategory.FOUNDATION_MOVE && m.source === 'waste' &&
    m.card.id === wasteAce.id && m.target === 'foundation' && m.targetIndex === 0
  ));
  assert.ok(moves.some(m => m.category === MoveCategory.DRAW_STOCK));
  assert.ok(!moves.some(m => m.category === MoveCategory.RECYCLE_STOCK));
});

test('getLegalMoves lists tableau-sourced moves in left-to-right column order', () => {
  const s = emptyState();
  s.tableau[1] = [card('diamonds', 5)]; // red5 -> needs a black6
  s.tableau[4] = [card('hearts', 5)];   // red5 -> needs a black6
  s.tableau[0] = [card('clubs', 6)];
  s.tableau[6] = [card('spades', 6)];
  const sourceOrder = getLegalMoves(s)
    .filter(m => m.category === MoveCategory.TABLEAU_MOVE && m.source === 'tableau')
    .map(m => m.sourceIndex);
  assert.ok(sourceOrder.indexOf(1) < sourceOrder.indexOf(4));
});

// Regression: Hint once suggested moving a "sequence" that wasn't actually
// a legal, well-formed run - a face-up card can rest directly above an
// unrelated face-up card (its own run's base, or a card dealt face-up)
// without the two forming a legal build, so getLegalMoves must not assume
// "face-up all the way to the top" means "one movable unit."
test('getLegalMoves: a buried card whose run is broken by a non-continuing card above it is never offered as a move (regression for the buried-sequence hint bug)', () => {
  const s = emptyState();
  const eight = card('spades', 8);
  const four = card('diamonds', 4); // rests directly on the 8♠ but does NOT continue it (needs a red 7, not a red 4)
  s.tableau[0] = [eight, four];
  s.tableau[1] = [card('hearts', 9)]; // would legally accept an 8♠-led sequence, if one were (wrongly) offered
  s.foundations[1] = [card('diamonds', 3)]; // ready for the 4♦, so its own top-card moves are provably still evaluated

  const moves = getLegalMoves(s);

  // The broken "8♠ + 4♦" pairing must never be offered as a 2-card sequence.
  assert.ok(!moves.some(m => m.category === MoveCategory.TABLEAU_MOVE && m.card && m.card.id === eight.id && m.stackLength === 2));
  // 8♠ isn't the column's actual top, so it has no legal move of its own either - genuinely buried, not just excluded as a sequence base.
  assert.ok(!moves.some(m => m.card && m.card.id === eight.id));
  // The real top card (4♦) is unaffected - still finds its own foundation move.
  assert.ok(moves.some(m => m.category === MoveCategory.FOUNDATION_MOVE && m.card.id === four.id));
});

test('getLegalMoves: a genuinely well-formed multi-card run is still offered as one unit (the broken-run check does not over-trigger)', () => {
  const s = emptyState();
  const black8 = card('spades', 8);
  const redSeven = card('hearts', 7);
  const black6 = card('clubs', 6);
  s.tableau[0] = [black8, redSeven, black6]; // a genuinely valid alternating run
  s.tableau[1] = [card('diamonds', 9)]; // accepts the whole 3-card sequence
  const moves = getLegalMoves(s);
  assert.ok(moves.some(m =>
    m.category === MoveCategory.TABLEAU_MOVE && m.card.id === black8.id && m.stackLength === 3 && m.targetIndex === 1
  ));
});

test('getLegalMoves includes a stock draw only when the stock has cards, and a recycle only when it is empty with waste remaining', () => {
  const s = emptyState();
  s.stock = [card('hearts', 2)];
  assert.ok(getLegalMoves(s).some(m => m.category === MoveCategory.DRAW_STOCK));
  assert.ok(!getLegalMoves(s).some(m => m.category === MoveCategory.RECYCLE_STOCK));

  s.stock = [];
  s.waste = [card('hearts', 2)];
  assert.ok(!getLegalMoves(s).some(m => m.category === MoveCategory.DRAW_STOCK));
  assert.ok(getLegalMoves(s).some(m => m.category === MoveCategory.RECYCLE_STOCK));

  s.waste = [];
  assert.ok(!getLegalMoves(s).some(m =>
    m.category === MoveCategory.DRAW_STOCK || m.category === MoveCategory.RECYCLE_STOCK
  ));
});

test('getLegalMoves is deterministic - repeated calls on an unchanged state return the same order (what Hint cycles through)', () => {
  const s = emptyState();
  s.tableau[0] = [card('hearts', 5)];
  s.tableau[2] = [card('clubs', 6)];
  s.waste = [card('spades', 1)];
  s.stock = [card('diamonds', 9)];
  const key = m => `${m.category}|${m.source}|${m.sourceIndex}|${m.card ? m.card.id : ''}|${m.target}|${m.targetIndex}`;
  assert.deepEqual(getLegalMoves(s).map(key), getLegalMoves(s).map(key));
});

test('getLegalMoves includes a foundation card moving back to the tableau when legal', () => {
  const s = emptyState();
  s.foundations[0] = [card('hearts', 1), card('hearts', 2)]; // red 2 on top
  s.tableau[0] = [card('clubs', 3)]; // black 3 accepts a red 2
  assert.ok(getLegalMoves(s).some(m => m.source === 'foundation' && m.target === 'tableau'));
});

test('getLegalMoves and classifyMove never mutate the state passed in', () => {
  const s = emptyState();
  s.tableau[0] = [card('clubs', 10), card('hearts', 5)];
  s.tableau[2] = [card('clubs', 6)];
  s.stock = [card('diamonds', 9)];
  const before = cloneState(s);
  const moves = getLegalMoves(s);
  moves.forEach(m => classifyMove(s, m));
  assert.deepEqual(s, before);
});

// ---------- classifyMove: meaningful vs. trivial reversible shuffle ----------

test('classifyMove: a tableau move that reveals a face-down card is meaningful', () => {
  const s = emptyState();
  const buried = card('clubs', 9, false); // face-down
  const mover = card('hearts', 8); // red 8
  s.tableau[0] = [buried, mover];
  s.tableau[1] = [card('spades', 9)]; // black9 accepts red8
  const move = { category: MoveCategory.TABLEAU_MOVE, source: 'tableau', sourceIndex: 0, card: mover, stackLength: 1, target: 'tableau', targetIndex: 1 };
  assert.deepEqual(classifyMove(s, move), { status: 'meaningful', reason: 'reveals_card' });
});

test('classifyMove: a King moving to an empty column when another empty column already exists is a trivial reversible shuffle', () => {
  const s = emptyState();
  const king = card('spades', 13);
  s.tableau[0] = [king]; // every other column is empty (emptyState default)
  const move = { category: MoveCategory.TABLEAU_MOVE, source: 'tableau', sourceIndex: 0, card: king, stackLength: 1, target: 'tableau', targetIndex: 1 };
  assert.deepEqual(classifyMove(s, move), { status: 'trivial', reason: 'reversible_shuffle' });
});

test('classifyMove: moving a card straight back to where it just came from is a trivial reversible shuffle', () => {
  const s = emptyState();
  const five = card('hearts', 5);
  s.tableau[0] = [card('spades', 6)]; // where the 5 would return to
  s.tableau[2] = [card('clubs', 10), five]; // the 5's current resting spot
  const move = { category: MoveCategory.TABLEAU_MOVE, source: 'tableau', sourceIndex: 2, card: five, stackLength: 1, target: 'tableau', targetIndex: 0 };
  assert.deepEqual(classifyMove(s, move), { status: 'trivial', reason: 'reversible_shuffle' });
});

test('classifyMove: cycling a card between two equivalent tableau destinations that unlock nothing is trivial either way', () => {
  const s = emptyState();
  const black10 = card('clubs', 10); // already face-up beneath the moving card - exposing it changes nothing else here
  const five = card('hearts', 5);
  s.tableau[0] = [black10, five];
  s.tableau[2] = [card('clubs', 6)];
  s.tableau[5] = [card('spades', 6)];
  const moveToCol2 = { category: MoveCategory.TABLEAU_MOVE, source: 'tableau', sourceIndex: 0, card: five, stackLength: 1, target: 'tableau', targetIndex: 2 };
  const moveToCol5 = { category: MoveCategory.TABLEAU_MOVE, source: 'tableau', sourceIndex: 0, card: five, stackLength: 1, target: 'tableau', targetIndex: 5 };
  assert.deepEqual(classifyMove(s, moveToCol2), { status: 'trivial', reason: 'reversible_shuffle' });
  assert.deepEqual(classifyMove(s, moveToCol5), { status: 'trivial', reason: 'reversible_shuffle' });
});

test('classifyMove: a tableau move that reveals nothing but changes what else is possible is meaningful (the exposed-new-top case)', () => {
  const s = emptyState();
  const black4 = card('clubs', 4); // already face-up, buried under an unrelated moving sequence
  const nine = card('spades', 9);
  const eight = card('hearts', 8);
  const seven = card('spades', 7);
  s.tableau[0] = [black4, nine, eight, seven];
  s.tableau[3] = [card('hearts', 10)]; // red 10 accepts the 9-8-7 sequence
  s.waste = [card('diamonds', 3)]; // red 3 has nowhere to go until black4 becomes a top
  const move = { category: MoveCategory.TABLEAU_MOVE, source: 'tableau', sourceIndex: 0, card: nine, stackLength: 3, target: 'tableau', targetIndex: 3 };
  assert.deepEqual(classifyMove(s, move), { status: 'meaningful', reason: 'changes_available_moves' });
});

test('classifyMove: a non-King move that empties its column is meaningful (net increase in empty columns), independent of whether anything currently benefits', () => {
  const s = emptyState();
  const lone7 = card('hearts', 7); // the column's only card - moving it away empties the column
  s.tableau[0] = [lone7];
  s.tableau[1] = [card('clubs', 8)]; // black8 accepts the red7
  s.tableau[3] = [card('spades', 13)]; // a King elsewhere - not required for this to count, just present here too
  const move = { category: MoveCategory.TABLEAU_MOVE, source: 'tableau', sourceIndex: 0, card: lone7, stackLength: 1, target: 'tableau', targetIndex: 1 };
  assert.deepEqual(classifyMove(s, move), { status: 'meaningful', reason: 'empties_column' });
});

test('classifyMove: foundation-bound moves and waste-to-tableau moves are always meaningful, independent of the tableau-shuffle check', () => {
  const s = emptyState();
  const foundationMove = { category: MoveCategory.FOUNDATION_MOVE, source: 'waste', sourceIndex: null, card: card('spades', 1), stackLength: 1, target: 'foundation', targetIndex: 0 };
  assert.equal(classifyMove(s, foundationMove).status, 'meaningful');

  const wasteMove = { category: MoveCategory.TABLEAU_MOVE, source: 'waste', sourceIndex: null, card: card('hearts', 5), stackLength: 1, target: 'tableau', targetIndex: 2 };
  assert.equal(classifyMove(s, wasteMove).status, 'meaningful');
});

test('classifyMove: drawing/recycling is meaningful as long as some card left in the stock or waste could still land somewhere', () => {
  const s = emptyState();
  s.stock = [card('hearts', 5)]; // buried in the stock, but reachable once it surfaces
  s.tableau[0] = [card('clubs', 6)]; // black6 accepts the red5 sitting in the stock
  const drawMove = { category: MoveCategory.DRAW_STOCK, source: 'stock', sourceIndex: null, card: null, stackLength: 0, target: 'waste', targetIndex: null };
  assert.deepEqual(classifyMove(s, drawMove), { status: 'meaningful', reason: 'draws_stock' });

  const s2 = emptyState();
  s2.waste = [card('hearts', 5)];
  s2.tableau[0] = [card('clubs', 6)];
  const recycleMove = { category: MoveCategory.RECYCLE_STOCK, source: 'waste', sourceIndex: null, card: null, stackLength: 0, target: 'stock', targetIndex: null };
  assert.deepEqual(classifyMove(s2, recycleMove), { status: 'meaningful', reason: 'recycles_waste' });
});

// Regression for the reported bug: Hint suggested "draw from the stock" (and
// the abandon dialog claimed moves remained) when every card still in the
// stock/waste was already dead - none of them matched any current tableau
// or foundation top, so no amount of drawing or recycling could ever help.
test('classifyMove: drawing/recycling is trivial once nothing left in the stock or waste can land anywhere', () => {
  const s = emptyState();
  s.stock = [card('hearts', 5), card('clubs', 9)]; // neither has a legal destination anywhere on this board
  s.waste = [card('spades', 2)]; // same - dead
  s.tableau[0] = [card('diamonds', 13)]; // an exposed King - nothing in stock/waste is a King, and it doesn't need one

  const drawMove = { category: MoveCategory.DRAW_STOCK, source: 'stock', sourceIndex: null, card: null, stackLength: 0, target: 'waste', targetIndex: null };
  assert.deepEqual(classifyMove(s, drawMove), { status: 'trivial', reason: 'stock_exhausted' });

  const s2 = emptyState();
  s2.waste = [card('hearts', 5), card('clubs', 9), card('spades', 2)]; // same dead cards, all already cycled into the waste
  s2.tableau[0] = [card('diamonds', 13)];
  const recycleMove = { category: MoveCategory.RECYCLE_STOCK, source: 'waste', sourceIndex: null, card: null, stackLength: 0, target: 'stock', targetIndex: null };
  assert.deepEqual(classifyMove(s2, recycleMove), { status: 'trivial', reason: 'stock_exhausted' });

  assert.equal(getProgressingMoves(s).length, 0);
  assert.equal(getProgressingMoves(s2).length, 0);
});

test('the abandon dialog does not show for a dead stock, even though drawing is still technically legal', () => {
  const s = emptyState();
  s.stock = [card('hearts', 5), card('clubs', 9)];
  s.tableau[0] = [card('diamonds', 13)]; // nothing in stock accepts onto a King, and no Kings are stuck in stock either

  assert.ok(getLegalMoves(s).some(m => m.category === MoveCategory.DRAW_STOCK));
  assert.equal(getProgressingMoves(s).length, 0);
  assert.equal(needsAbandonConfirmation(s, 5, false), false); // nothing meaningful would be lost, so no confirmation
});

// Regression for the follow-up report: recycling was still being offered at
// Draw 3 in a genuinely dead position. At Draw 1 every card in the stock
// eventually reaches the waste's top, but at Draw 3 onStockClick pops
// drawCount cards off the stock and pushes them onto the waste in that same
// order, so only the *last* card of each group of 3 (counting from the
// top) is ever individually exposed - the other two are buried underneath
// it in every single pass, forever, because recycling exactly restores the
// pre-pass order (see stockHasReachableCard). A card can have a perfectly
// good destination and still never matter, if it never lands in that
// last-of-group position.
test('classifyMove: at Draw 3, a card buried mid-group in the waste never counts, even though the same card would count at Draw 1', () => {
  const s = emptyState();
  // Current waste (bottom-to-top): A, B, C, D - so this pass's original
  // stock order (bottom-to-top) was D, C, B, A (draws pop off the end and
  // push in that order, which is what un-reversing the waste recovers).
  // Grouping from the top in 3s: {A,B,C} (reachable = C, the last one
  // drawn/pushed) then {D} alone (reachable = D). Verified numerically
  // against stockHasReachableCard's own algorithm: the two positions that
  // actually ever surface are C and D - never A or B.
  const A = card('hearts', 5); // HAS a legal destination (the black 6 below) - but never surfaces at Draw 3
  const B = card('clubs', 9);  // dead either way
  const C = card('spades', 8); // dead either way
  const D = card('diamonds', 9); // dead either way
  s.waste = [A, B, C, D];
  s.tableau[0] = [card('clubs', 6)]; // black6 - only A (red 5) matches it

  const recycleMove = getLegalMoves(s).find(m => m.category === MoveCategory.RECYCLE_STOCK);
  assert.ok(recycleMove, 'recycling must still be legal - stock is empty and waste is not');

  assert.deepEqual(classifyMove(s, recycleMove, 3), { status: 'trivial', reason: 'stock_exhausted' });
  assert.deepEqual(classifyMove(s, recycleMove, 1), { status: 'meaningful', reason: 'recycles_waste' });

  assert.equal(getProgressingMoves(s, 3).length, 0);
  assert.ok(getProgressingMoves(s, 1).some(m => sameMove(m, recycleMove)));
});

// Regression for the reported bug: Hint suggested "move the 2D onto the 3C"
// - legal (foundation-to-tableau is allowed Klondike), but a step backward,
// not progress. classifyMove must reject it outright, without running the
// tableau-shuffle reachability analysis at all (source === 'foundation' is
// checked before that logic even runs).
test('classifyMove: a foundation-to-tableau move is always trivial ("foundation_return"), never analyzed as a shuffle', () => {
  const s = emptyState();
  const twoDiamonds = card('diamonds', 2);
  s.foundations[1] = [card('diamonds', 1), twoDiamonds]; // 2D sitting on the foundation
  s.tableau[0] = [card('clubs', 3)]; // exposed 3C - legal, but wrong-direction, destination

  const moves = getLegalMoves(s);
  const move = moves.find(m => m.source === 'foundation' && m.card.suit === 'diamonds' && m.card.rank === 2);

  assert.ok(move, 'getLegalMoves must still contain the move - foundation-to-tableau is legal Klondike');
  assert.deepEqual(classifyMove(s, move), { status: 'trivial', reason: 'foundation_return' });

  const progressing = getProgressingMoves(s);
  assert.ok(!progressing.some(m => sameMove(m, move)));
  assert.equal(progressing.length, 0); // it's the only legal move on this board
});

test('classifyMove: an Ace moved from the foundation back to the tableau is trivial', () => {
  const s = emptyState();
  const aceSpades = card('spades', 1);
  s.foundations[0] = [aceSpades];
  s.tableau[0] = [card('hearts', 2)]; // red2 legally accepts the black Ace
  const move = getLegalMoves(s).find(m => m.source === 'foundation' && m.card.rank === 1);
  assert.ok(move);
  assert.equal(classifyMove(s, move).status, 'trivial');
  assert.ok(!getProgressingMoves(s).some(m => sameMove(m, move)));
});

test('classifyMove: a high-rank card moved from the foundation back to the tableau is trivial', () => {
  const s = emptyState();
  const sevenClubs = card('clubs', 7);
  s.foundations[3] = [sevenClubs]; // only the top card matters here, same convention as the other lone-foundation-card tests above
  s.tableau[0] = [card('hearts', 8)]; // red8 legally accepts the black 7
  const move = getLegalMoves(s).find(m => m.source === 'foundation' && m.card.rank === 7);
  assert.ok(move);
  assert.equal(classifyMove(s, move).status, 'trivial');
  assert.ok(!getProgressingMoves(s).some(m => sameMove(m, move)));
});

test('getProgressingMoves: excludes every foundation-to-tableau move when several are simultaneously legal', () => {
  const s = emptyState();
  s.foundations[0] = [card('spades', 5)];
  s.tableau[0] = [card('diamonds', 6)]; // red6 accepts the black 5
  s.foundations[1] = [card('hearts', 9)];
  s.tableau[1] = [card('clubs', 10)]; // black10 accepts the red9

  const moves = getLegalMoves(s);
  const foundationMoves = moves.filter(m => m.source === 'foundation');
  assert.equal(foundationMoves.length, 2); // both are legal

  const progressing = getProgressingMoves(s);
  assert.equal(progressing.length, 0); // neither counts as progress
});

test('the abandon dialog does not show when only a foundation-to-tableau move remains', () => {
  const s = emptyState();
  s.foundations[1] = [card('diamonds', 1), card('diamonds', 2)];
  s.tableau[0] = [card('clubs', 3)];

  assert.ok(getLegalMoves(s).length > 0);
  assert.equal(getProgressingMoves(s).length, 0);
  assert.equal(needsAbandonConfirmation(s, 5, false), false); // nothing meaningful would be lost, so no confirmation
});

// Regression for the reported bug: Hint suggested "move the 5S sequence
// onto the 6D" when the only other effect was that a 5C elsewhere could now
// reach the freshly-exposed 6H instead of the 6D it could already reach -
// a relabeled destination, not a new one. The decoy 5C is what actually
// exercises the bug: without another card able to reach *both* the source
// and destination columns, a raw-moveKey diff wouldn't show a false
// positive here at all.
test('classifyMove: relocating an exposed sequence between two equivalent tableau destinations is trivial, even when another card could land on either one', () => {
  const s = emptyState();
  const buried = card('spades', 11, false); // face-down; stays covered either way, so no reveal
  const six_h = card('hearts', 6);
  const five_s = card('spades', 5);
  const four_d = card('diamonds', 4);
  const three_c = card('clubs', 3);
  s.tableau[1] = [buried, six_h, five_s, four_d, three_c]; // the 5S-4D-3C run, sitting on 6H
  s.tableau[2] = [card('diamonds', 6)]; // 6D - an equally legal destination for the run
  s.tableau[3] = [card('spades', 8), card('clubs', 5)]; // 5C can reach whichever red 6 ends up exposed; the 8S under it means moving 5C alone doesn't itself empty column 3

  const moves = getLegalMoves(s);
  const move = moves.find(m => m.card.suit === 'spades' && m.card.rank === 5 && m.stackLength === 3 && m.targetIndex === 2);

  // 1. It's legal.
  assert.ok(move, 'getLegalMoves must still contain the move - it is legal Klondike');

  // 2. The classifier rejects it.
  assert.deepEqual(classifyMove(s, move), { status: 'trivial', reason: 'reversible_shuffle' });

  // 3. Hint (via getProgressingMoves) does not offer it.
  const progressing = getProgressingMoves(s);
  assert.ok(!progressing.some(m => sameMove(m, move)));

  // Sanity: this board has no foundation move, reveal, or empty-column
  // change available at all - every legal move here is this same class of
  // reversible relocation, so nothing progressing exists.
  assert.equal(progressing.length, 0);
});

// ---------- getProgressingMoves: the shared filter Hint and the abandon dialog both read from ----------

test('getProgressingMoves: drops non-progressing tableau shuffles but keeps a genuinely useful move alongside them', () => {
  const s = emptyState();
  const buried = card('hearts', 9, false);
  const eight = card('spades', 8);
  s.tableau[0] = [buried, eight]; // moving the 8 away reveals the buried 9
  s.tableau[1] = [card('diamonds', 9)]; // red9 accepts the black8 - the reveal move
  const king = card('clubs', 13);
  s.tableau[3] = [king]; // free to shuffle to any other empty column - not progress

  const moves = getLegalMoves(s);
  const revealMove = moves.find(m => m.card.rank === 8);
  const kingShuffle = moves.find(m => m.card.rank === 13);
  assert.ok(revealMove && kingShuffle);

  const progressing = getProgressingMoves(s);
  assert.ok(progressing.some(m => sameMove(m, revealMove)));
  assert.ok(!progressing.some(m => sameMove(m, kingShuffle)));
});

// ---------- abandon-confirmation ----------

test('an untouched game never needs confirmation, regardless of moves or won state', () => {
  const s = emptyState();
  s.tableau[0] = [card('hearts', 5)]; // a move would technically be available
  assert.equal(needsAbandonConfirmation(s, 0, false), false);
  assert.equal(needsAbandonConfirmation(s, 0, true), false); // won + untouched is a contradiction, but still: no history, no confirmation
});

test('an active game with a meaningful move needs confirmation', () => {
  const s = emptyState();
  s.stock = [card('hearts', 4)]; // red4 has a real destination below
  s.tableau[0] = [card('clubs', 5)]; // black5 accepts it once drawn
  assert.equal(needsAbandonConfirmation(s, 3, false), true);
});

test('a won game never needs confirmation, even with moves still technically available', () => {
  const s = emptyState();
  s.stock = [card('hearts', 4)];
  s.tableau[0] = [card('clubs', 5)];
  assert.equal(needsAbandonConfirmation(s, 10, true), false);
});

test('a dead game (no cards left to draw, nothing exposed can move) never needs confirmation', () => {
  const s = emptyState();
  // stock and waste both empty; every tableau top and foundation top is
  // stuck (nothing legally accepts it, and none of them are Kings sitting
  // on an empty column since every column is occupied).
  s.tableau[0] = [card('clubs', 7)];
  s.tableau[1] = [card('clubs', 6)];
  s.tableau[2] = [card('spades', 5)];
  s.foundations[0] = [card('hearts', 1)]; // a lone Ace: nothing in the tableau is a black 2, and no tableau column accepts an Ace back down
  assert.equal(getLegalMoves(s).length, 0);
  assert.equal(needsAbandonConfirmation(s, 5, false), false);
});

test('a board where only a trivial King shuffle remains does not need confirmation, even though moves are still legal', () => {
  const s = emptyState();
  const king = card('spades', 13);
  s.tableau[0] = [king]; // only legal moves: the King to any of the other 6 empty columns
  const moves = getLegalMoves(s);
  assert.ok(moves.length > 0);
  assert.ok(moves.every(m => classifyMove(s, m).status === 'trivial'));
  assert.equal(getProgressingMoves(s).length, 0);
  assert.equal(needsAbandonConfirmation(s, 5, false), false); // nothing meaningful would be lost, so no confirmation
});

test('the abandon dialog does not show when only a reversible sequence relocation (the reported 5S-onto-6D bug) remains', () => {
  const s = emptyState();
  const buried = card('spades', 11, false);
  s.tableau[1] = [buried, card('hearts', 6), card('spades', 5), card('diamonds', 4), card('clubs', 3)];
  s.tableau[2] = [card('diamonds', 6)];
  s.tableau[3] = [card('spades', 8), card('clubs', 5)]; // 8S under the 5C so moving it doesn't itself empty column 3

  assert.ok(getLegalMoves(s).length > 0);
  assert.equal(getProgressingMoves(s).length, 0);
  assert.equal(needsAbandonConfirmation(s, 5, false), false); // nothing meaningful would be lost, so no confirmation
});

// ---------- Auto Finish ----------
//
// The run loop itself lives in script.js (not importable/unit-testable,
// same limitation as Hint and the abandon dialog's live wording) - these
// tests target the pieces that actually decide its behavior: getLegalMoves'
// FOUNDATION_MOVE filtering/ordering (exactly what the loop consumes each
// tick) and autoFinishAvailable (the button's enabled state), both pure
// functions of state.

test('Auto Finish: a single exposed tableau card with a legal foundation move is found', () => {
  const s = emptyState();
  const ace = card('hearts', 1);
  s.tableau[0] = [ace];
  const move = getLegalMoves(s).find(m => m.category === MoveCategory.FOUNDATION_MOVE);
  assert.ok(move);
  assert.equal(move.source, 'tableau');
  assert.equal(move.sourceIndex, 0);
  assert.equal(move.card.id, ace.id);
  assert.equal(move.targetIndex, 0);
});

test('Auto Finish: when multiple tableau columns have a foundation-ready card, the leftmost is found first', () => {
  const s = emptyState();
  s.foundations[0] = [card('hearts', 1)];
  s.foundations[1] = [card('diamonds', 1)];
  const heartsTwo = card('hearts', 2);
  const diamondsTwo = card('diamonds', 2);
  s.tableau[4] = [heartsTwo];
  s.tableau[1] = [diamondsTwo];
  const move = getLegalMoves(s).find(m => m.category === MoveCategory.FOUNDATION_MOVE);
  assert.equal(move.sourceIndex, 1);
  assert.equal(move.card.id, diamondsTwo.id);
});

test('Auto Finish: re-evaluating after a move surfaces the next eligible card, without a stale list', () => {
  const s = emptyState();
  s.foundations[0] = [card('hearts', 1)];
  const heartsTwo = card('hearts', 2);
  const heartsThree = card('hearts', 3);
  s.tableau[0] = [heartsThree, heartsTwo]; // heartsThree isn't foundation-eligible yet (needs rank 2 down first)

  let move = getLegalMoves(s).find(m => m.category === MoveCategory.FOUNDATION_MOVE);
  assert.equal(move.card.id, heartsTwo.id);
  const stack = getStackFrom(s, move.source, move.sourceIndex, move.card);
  applyMove(s, stack, move.source, move.sourceIndex, move.target, move.targetIndex);

  move = getLegalMoves(s).find(m => m.category === MoveCategory.FOUNDATION_MOVE);
  assert.ok(move); // heartsThree is now eligible, only after the first move actually landed
  assert.equal(move.card.id, heartsThree.id);
});

test('Auto Finish: a waste-top foundation move is found, but a tableau one takes priority when both exist', () => {
  const s = emptyState();
  s.foundations[0] = [card('hearts', 1)];
  s.foundations[1] = [card('spades', 1)];
  const heartsTwo = card('hearts', 2);
  const spadesTwo = card('spades', 2);
  s.tableau[3] = [heartsTwo];
  s.waste = [spadesTwo];
  let move = getLegalMoves(s).find(m => m.category === MoveCategory.FOUNDATION_MOVE);
  assert.equal(move.source, 'tableau');
  assert.equal(move.card.id, heartsTwo.id);

  s.tableau[3] = [];
  move = getLegalMoves(s).find(m => m.category === MoveCategory.FOUNDATION_MOVE);
  assert.equal(move.source, 'waste');
  assert.equal(move.card.id, spadesTwo.id);
});

test('Auto Finish: a legal stock draw coexists with a foundation move without being selected by the FOUNDATION_MOVE filter', () => {
  const s = emptyState();
  s.foundations[0] = [card('hearts', 1)];
  const heartsTwo = card('hearts', 2);
  s.tableau[0] = [heartsTwo];
  s.stock = [card('clubs', 9)];
  const moves = getLegalMoves(s);
  assert.ok(moves.some(m => m.category === MoveCategory.DRAW_STOCK));
  const found = moves.find(m => m.category === MoveCategory.FOUNDATION_MOVE);
  assert.equal(found.card.id, heartsTwo.id);
});

test('Auto Finish: a legal recycle coexists with a foundation move without being selected by the FOUNDATION_MOVE filter', () => {
  const s = emptyState();
  s.foundations[0] = [card('hearts', 1)];
  const heartsTwo = card('hearts', 2);
  s.tableau[0] = [heartsTwo];
  s.stock = [];
  s.waste = [card('clubs', 9)];
  const moves = getLegalMoves(s);
  assert.ok(moves.some(m => m.category === MoveCategory.RECYCLE_STOCK));
  const found = moves.find(m => m.category === MoveCategory.FOUNDATION_MOVE);
  assert.equal(found.card.id, heartsTwo.id);
});

test('Auto Finish: FOUNDATION_MOVE entries are never tableau-targeted', () => {
  const s = emptyState();
  s.foundations[0] = [card('hearts', 1)];
  s.tableau[0] = [card('hearts', 2)];
  s.tableau[2] = [card('spades', 6)]; // an unrelated tableau destination elsewhere, irrelevant to this card
  const moves = getLegalMoves(s).filter(m => m.category === MoveCategory.FOUNDATION_MOVE);
  assert.ok(moves.length > 0);
  assert.ok(moves.every(m => m.target === 'foundation'));
});

test('Auto Finish: when nothing has a legal foundation move, the loop\'s stop condition is undefined', () => {
  const s = emptyState();
  s.tableau[0] = [card('clubs', 7)];
  s.tableau[1] = [card('spades', 9)];
  s.waste = [card('hearts', 5)];
  const move = getLegalMoves(s).find(m => m.category === MoveCategory.FOUNDATION_MOVE);
  assert.equal(move, undefined);
});

test('autoFinishAvailable: stock non-empty blocks availability even with a ready foundation move', () => {
  const s = emptyState();
  s.foundations[0] = [card('hearts', 1)];
  s.tableau[0] = [card('hearts', 2)];
  s.stock = [card('clubs', 9)];
  assert.equal(autoFinishAvailable(s), false);
});

test('autoFinishAvailable: a face-down tableau card blocks availability even with a ready foundation move', () => {
  const s = emptyState();
  s.foundations[0] = [card('hearts', 1)];
  s.tableau[0] = [card('hearts', 2)];
  s.tableau[1] = [card('clubs', 9, false)]; // face-down
  assert.equal(autoFinishAvailable(s), false);
});

test('autoFinishAvailable: available once stock is empty and everything is face-up, even with a harmless tableau shuffle also legal', () => {
  const s = emptyState();
  s.foundations[0] = [card('hearts', 1)];
  s.tableau[0] = [card('hearts', 2)];
  s.tableau[2] = [card('clubs', 6)]; // a black 6 - would also legally accept a red 5
  s.tableau[3] = [card('diamonds', 5)]; // a harmless shuffle destination that must not block availability
  assert.equal(autoFinishAvailable(s), true);
});

test('autoFinishAvailable: not available when stock is empty and everything is face-up but no foundation move exists anywhere', () => {
  const s = emptyState();
  s.tableau[0] = [card('clubs', 7)];
  s.tableau[1] = [card('spades', 9)];
  assert.equal(autoFinishAvailable(s), false);
});

test('nextAutoFinishMove: null once no foundation move remains', () => {
  const s = emptyState();
  s.tableau[0] = [card('clubs', 7)];
  assert.equal(nextAutoFinishMove(s), null);
});

test('nextAutoFinishMove: the only eligible card, regardless of which column it sits in', () => {
  const s = emptyState();
  s.foundations[2] = [card('clubs', 1)];
  s.tableau[5] = [card('clubs', 2)]; // the only playable card, tucked in a late column
  const move = nextAutoFinishMove(s);
  assert.equal(move.category, MoveCategory.FOUNDATION_MOVE);
  assert.equal(move.sourceIndex, 5);
  assert.equal(move.card.rank, 2);
});

test('nextAutoFinishMove: among several simultaneously-eligible cards, always the lowest rank - not the leftmost column', () => {
  const s = emptyState();
  s.foundations[0] = [card('hearts', 1), card('hearts', 2)]; // hearts needs a 3 next
  s.foundations[1] = [card('clubs', 1)]; // clubs needs a 2 next
  s.tableau[0] = [card('hearts', 3)]; // leftmost column - but rank 3, not the lowest eligible
  s.tableau[4] = [card('clubs', 2)]; // later column - rank 2, the actually-lowest eligible card
  const move = nextAutoFinishMove(s);
  assert.equal(move.card.rank, 2);
  assert.equal(move.sourceIndex, 4);
});

test('nextAutoFinishMove: a tie at the same rank (two suits both needing it right now) falls back to left-to-right column order', () => {
  const s = emptyState();
  s.foundations[0] = [card('hearts', 1)]; // hearts needs a 2
  s.foundations[1] = [card('clubs', 1)]; // clubs needs a 2
  s.tableau[5] = [card('clubs', 2)]; // later column
  s.tableau[1] = [card('hearts', 2)]; // earlier column - should win the tie
  const move = nextAutoFinishMove(s);
  assert.equal(move.card.rank, 2);
  assert.equal(move.sourceIndex, 1);
});

test('nextAutoFinishMove: a waste-sourced card participates in rank ordering exactly like a tableau one', () => {
  const s = emptyState();
  s.foundations[0] = [card('hearts', 1)]; // hearts needs a 2
  s.foundations[1] = [card('clubs', 1)]; // clubs needs a 2
  s.waste = [card('hearts', 2)];
  s.tableau[0] = [card('clubs', 3)]; // not yet eligible - clubs foundation is only at rank 1
  const move = nextAutoFinishMove(s);
  assert.equal(move.source, 'waste');
  assert.equal(move.card.rank, 2);
});

test('Auto Finish: the found foundation move is identical regardless of draw count, since only the resulting waste/tableau position matters', () => {
  const s1 = emptyState();
  s1.foundations[0] = [card('hearts', 1)];
  s1.waste = [card('hearts', 2)]; // as if reached via a draw-1 game

  const s2 = emptyState();
  s2.foundations[0] = [card('hearts', 1)];
  s2.waste = [card('clubs', 8), card('spades', 4), card('hearts', 2)]; // as if reached via a draw-3 game, same top card

  const move1 = getLegalMoves(s1).find(m => m.category === MoveCategory.FOUNDATION_MOVE);
  const move2 = getLegalMoves(s2).find(m => m.category === MoveCategory.FOUNDATION_MOVE);
  assert.equal(move1.card.rank, move2.card.rank);
  assert.equal(move1.card.suit, move2.card.suit);
  assert.equal(move1.targetIndex, move2.targetIndex);
});

test('Auto Finish: an Ace targets the correct leftmost open foundation slot regardless of fill order', () => {
  const s = emptyState();
  s.foundations[1] = [card('hearts', 1)]; // slot 1 already taken
  const aceSpades = card('spades', 1);
  s.tableau[0] = [aceSpades];
  const move = getLegalMoves(s).find(m => m.category === MoveCategory.FOUNDATION_MOVE);
  assert.equal(move.card.id, aceSpades.id);
  assert.equal(move.targetIndex, 0); // slot 0 is the leftmost still-empty slot
});

// ---------- rankMoves: Hint's priority policy ----------

test('rankMoves: a foundation move outranks a tableau move for the same card, even when the tableau move also reveals a card (regression for the A♣-onto-2♥ hint bug)', () => {
  const s = emptyState();
  const buried = card('spades', 9, false); // face-down beneath the ace
  const aceClubs = card('clubs', 1);
  s.tableau[0] = [buried, aceClubs];
  s.tableau[1] = [card('hearts', 2)]; // a red 2 also legally accepts the ace - the wrong move the bug report showed

  const ranked = rankMoves(s, getLegalMoves(s));
  assert.equal(ranked[0].category, MoveCategory.FOUNDATION_MOVE);
  assert.equal(ranked[0].card.id, aceClubs.id);
});

test('rankMoves: a reveal-producing tableau move outranks a non-reveal tableau move', () => {
  const s = emptyState();
  const buried = card('clubs', 9, false);
  const mover = card('hearts', 8); // moving this reveals `buried`
  s.tableau[0] = [buried, mover];
  s.tableau[1] = [card('spades', 9)]; // accepts the red 8

  const shuffler = card('hearts', 5);
  s.tableau[2] = [card('clubs', 10), shuffler]; // already-exposed top beneath it - moving reveals nothing
  s.tableau[3] = [card('clubs', 6)]; // accepts the red 5

  const ranked = rankMoves(s, getLegalMoves(s));
  const revealIndex = ranked.findIndex(m => m.card && m.card.id === mover.id);
  const shuffleIndex = ranked.findIndex(m => m.card && m.card.id === shuffler.id);
  assert.ok(revealIndex < shuffleIndex);
});

test('rankMoves: a tableau move outranks a stock draw', () => {
  const s = emptyState();
  const five = card('hearts', 5);
  s.tableau[0] = [card('clubs', 10), five]; // a legal (non-revealing) tableau shuffle
  s.tableau[1] = [card('clubs', 6)];
  s.stock = [card('diamonds', 9)];
  const ranked = rankMoves(s, getLegalMoves(s));
  const tableauIndex = ranked.findIndex(m => m.card && m.card.id === five.id);
  const drawIndex = ranked.findIndex(m => m.category === MoveCategory.DRAW_STOCK);
  assert.ok(tableauIndex < drawIndex);
});

test('rankMoves only reorders getLegalMoves\' own output - same moves, same count, nothing added or dropped', () => {
  const s = emptyState();
  s.foundations[0] = [card('hearts', 1)];
  s.tableau[0] = [card('hearts', 2)];
  s.tableau[1] = [card('clubs', 6)];
  s.tableau[2] = [card('diamonds', 5)];
  s.waste = [card('spades', 3)];
  s.stock = [card('clubs', 9)];
  const moves = getLegalMoves(s);
  const ranked = rankMoves(s, moves);
  assert.equal(ranked.length, moves.length);
  const key = m => `${m.category}|${m.source}|${m.sourceIndex}|${m.card ? m.card.id : ''}|${m.target}|${m.targetIndex}`;
  assert.deepEqual(new Set(ranked.map(key)), new Set(moves.map(key)));
});

test('rankMoves keeps getLegalMoves\' left-to-right order for moves within the same priority tier', () => {
  const s = emptyState();
  s.tableau[1] = [card('diamonds', 5)]; // red5 -> needs a black6, no reveal
  s.tableau[4] = [card('hearts', 5)];   // red5 -> needs a black6, no reveal
  s.tableau[0] = [card('clubs', 6)];
  s.tableau[6] = [card('spades', 6)];
  const ranked = rankMoves(s, getLegalMoves(s))
    .filter(m => m.category === MoveCategory.TABLEAU_MOVE && m.source === 'tableau');
  const sourceOrder = ranked.map(m => m.sourceIndex);
  assert.ok(sourceOrder.indexOf(1) < sourceOrder.indexOf(4));
});

test('rankMoves does not mutate the input array or state', () => {
  const s = emptyState();
  s.foundations[0] = [card('hearts', 1)];
  s.tableau[0] = [card('hearts', 2)];
  const moves = getLegalMoves(s);
  const movesCopy = [...moves];
  const beforeState = cloneState(s);
  rankMoves(s, moves);
  assert.deepEqual(moves, movesCopy);
  assert.deepEqual(s, beforeState);
});

// ---------- isKingColumnSwap / applyKingColumnSwap: the King-column swap ----------

test('isKingColumnSwap: two King-led columns with no empty column anywhere -> swap allowed', () => {
  const s = emptyState();
  const kingA = card('spades', 13);
  s.tableau[0] = [kingA, card('hearts', 12), card('clubs', 11)]; // K-Q-J
  s.tableau[1] = [card('diamonds', 13), card('spades', 12)]; // K-Q
  s.tableau[2] = [card('clubs', 1)]; // just something occupying every other column, so none are empty
  s.tableau[3] = [card('clubs', 2)];
  s.tableau[4] = [card('clubs', 3)];
  s.tableau[5] = [card('clubs', 4)];
  s.tableau[6] = [card('clubs', 5)];

  const stack = getStackFrom(s, 'tableau', 0, kingA);
  assert.equal(isKingColumnSwap(s, stack, 'tableau', 0, 1), true);
});

test('isKingColumnSwap: same two King-led columns, still allowed even though empty columns exist elsewhere', () => {
  const s = emptyState();
  const kingA = card('spades', 13);
  s.tableau[0] = [kingA, card('hearts', 12), card('clubs', 11)];
  s.tableau[1] = [card('diamonds', 13), card('spades', 12)];
  // tableau[2..6] left empty - legality is scoped to the two columns being
  // dragged between, not the rest of the board (see isKingColumnSwap).
  const stack = getStackFrom(s, 'tableau', 0, kingA);
  assert.equal(isKingColumnSwap(s, stack, 'tableau', 0, 1), true);
});

test('isKingColumnSwap: a non-King column dragged onto a King-led column -> no swap', () => {
  const s = emptyState();
  const queen = card('hearts', 12);
  s.tableau[0] = [queen]; // not a King
  s.tableau[1] = [card('diamonds', 13)];
  s.tableau[2] = [card('clubs', 1)]; // no empty columns
  s.tableau[3] = [card('clubs', 2)];
  s.tableau[4] = [card('clubs', 3)];
  s.tableau[5] = [card('clubs', 4)];
  s.tableau[6] = [card('clubs', 5)];
  const stack = getStackFrom(s, 'tableau', 0, queen);
  assert.equal(isKingColumnSwap(s, stack, 'tableau', 0, 1), false);
});

test('isKingColumnSwap: a King-led column dragged onto a non-King column -> no swap', () => {
  const s = emptyState();
  const king = card('spades', 13);
  s.tableau[0] = [king];
  s.tableau[1] = [card('hearts', 9)]; // not King-led
  s.tableau[2] = [card('clubs', 1)]; // no empty columns
  s.tableau[3] = [card('clubs', 2)];
  s.tableau[4] = [card('clubs', 3)];
  s.tableau[5] = [card('clubs', 4)];
  s.tableau[6] = [card('clubs', 5)];
  const stack = getStackFrom(s, 'tableau', 0, king);
  assert.equal(isKingColumnSwap(s, stack, 'tableau', 0, 1), false);
});

test('isKingColumnSwap: grabbing a card partway down a King-led run (not the King itself) -> no swap', () => {
  const s = emptyState();
  const king = card('spades', 13);
  const queen = card('hearts', 12);
  s.tableau[0] = [king, queen]; // K-Q
  s.tableau[1] = [card('diamonds', 13)];
  s.tableau[2] = [card('clubs', 1)]; // no empty columns
  s.tableau[3] = [card('clubs', 2)];
  s.tableau[4] = [card('clubs', 3)];
  s.tableau[5] = [card('clubs', 4)];
  s.tableau[6] = [card('clubs', 5)];
  const partialStack = getStackFrom(s, 'tableau', 0, queen); // just the Queen, not the whole column
  assert.equal(isKingColumnSwap(s, partialStack, 'tableau', 0, 1), false);
});

test('isKingColumnSwap: allowed even with face-down cards buried beneath either King', () => {
  const s = emptyState();
  const buriedUnderSource = card('hearts', 4, false);
  const kingA = card('spades', 13);
  s.tableau[0] = [buriedUnderSource, kingA, card('hearts', 12)]; // face-down 4, then K-Q exposed
  const buriedUnderTarget = card('clubs', 7, false);
  s.tableau[1] = [buriedUnderTarget, card('diamonds', 13)]; // face-down 7, then K exposed
  s.tableau[2] = [card('clubs', 1)]; // no empty columns
  s.tableau[3] = [card('clubs', 2)];
  s.tableau[4] = [card('clubs', 3)];
  s.tableau[5] = [card('clubs', 4)];
  s.tableau[6] = [card('clubs', 5)];

  const stack = getStackFrom(s, 'tableau', 0, kingA);
  assert.equal(isKingColumnSwap(s, stack, 'tableau', 0, 1), true);
});

test('applyKingColumnSwap: exchanges full column contents, preserving card identity, order, and face state', () => {
  const s = emptyState();
  const buried = card('hearts', 4, false);
  const kingA = card('spades', 13);
  const queenA = card('hearts', 12);
  s.tableau[0] = [buried, kingA, queenA];
  const kingB = card('diamonds', 13);
  s.tableau[1] = [kingB];

  applyKingColumnSwap(s, 0, 1);

  assert.deepEqual(s.tableau[0], [kingB]);
  assert.deepEqual(s.tableau[1], [buried, kingA, queenA]);
  assert.equal(s.tableau[1][0].faceUp, false); // the buried card's face-down state survived the move
});

test('applyKingColumnSwap round-trips cleanly through cloneState (the undo pattern)', () => {
  const s = emptyState();
  s.tableau[0] = [card('hearts', 4, false), card('spades', 13), card('hearts', 12)];
  s.tableau[1] = [card('diamonds', 13)];
  const before = cloneState(s);

  applyKingColumnSwap(s, 0, 1);
  assert.notDeepEqual(s, before);

  const restored = before; // undo() just restores the pre-move snapshot wholesale
  assert.equal(restored.tableau[0].length, 3);
  assert.equal(restored.tableau[1].length, 1);
});

test('a King-column swap situation produces zero legal moves for either column - Hint, Auto Finish, and stuck-game detection all read getLegalMoves, so the swap is invisible to every one of them by construction', () => {
  const s = emptyState();
  s.tableau[0] = [card('spades', 13), card('hearts', 12)];
  s.tableau[1] = [card('diamonds', 13)];
  // isolated black filler, ranks that can't reach a (still-empty) foundation
  // or stack on each other (all same color) - genuinely zero moves anywhere
  s.tableau[2] = [card('clubs', 2)];
  s.tableau[3] = [card('clubs', 3)];
  s.tableau[4] = [card('clubs', 4)];
  s.tableau[5] = [card('clubs', 5)];
  s.tableau[6] = [card('clubs', 6)];

  const moves = getLegalMoves(s);
  assert.ok(!moves.some(m => m.sourceIndex === 0 && m.source === 'tableau'));
  assert.ok(!moves.some(m => m.sourceIndex === 1 && m.source === 'tableau'));
  assert.equal(getProgressingMoves(s).length, 0);
  assert.equal(autoFinishAvailable(s), false);
  // historyLength > 0 and not won: the only way needsAbandonConfirmation
  // could say true here is if it counted the swap as a real move - it must not.
  assert.equal(needsAbandonConfirmation(s, 5, false), false);
});

// ---------- isKingLedColumn / computeKingCascade: tapping an empty column ----------

test('isKingLedColumn: a clean King-led run counts', () => {
  const s = emptyState();
  s.tableau[0] = [card('spades', 13), card('hearts', 12), card('clubs', 11)];
  assert.equal(isKingLedColumn(s, 0), true);
});

test('isKingLedColumn: an empty column does not count', () => {
  const s = emptyState();
  assert.equal(isKingLedColumn(s, 0), false);
});

test('isKingLedColumn: a buried (face-down) King does not count', () => {
  const s = emptyState();
  s.tableau[0] = [card('spades', 13, false), card('hearts', 9)];
  assert.equal(isKingLedColumn(s, 0), false);
});

test('isKingLedColumn: a broken/partial sequence above the King does not count', () => {
  const s = emptyState();
  // King, Queen (legal), then a same-color card that breaks the alternating
  // build - the exposed run is not actually one legal King-led cascade.
  s.tableau[0] = [card('spades', 13), card('hearts', 12), card('diamonds', 11)];
  assert.equal(isKingLedColumn(s, 0), false);
});

test('isKingLedColumn: still counts with face-down cards buried beneath the King', () => {
  const s = emptyState();
  s.tableau[0] = [card('hearts', 4, false), card('spades', 13), card('hearts', 12)];
  assert.equal(isKingLedColumn(s, 0), true);
});

test('isKingLedColumn: a lone King with nothing on top still counts', () => {
  const s = emptyState();
  s.tableau[0] = [card('diamonds', 13)];
  assert.equal(isKingLedColumn(s, 0), true);
});

test('computeKingCascade: one King column left of the tapped empty column moves right into it', () => {
  const s = emptyState();
  s.tableau[0] = [card('spades', 13)];
  s.tableau[1] = []; // tapped
  assert.deepEqual(computeKingCascade(s, 1), [{ from: 0, to: 1 }]);
});

test('computeKingCascade: multiple King columns on the left chain rightward, nearest first', () => {
  const s = emptyState();
  s.tableau[1] = [card('spades', 13)];
  s.tableau[3] = [card('hearts', 13)];
  s.tableau[4] = []; // tapped
  s.tableau[6] = [card('clubs', 13)];
  assert.deepEqual(computeKingCascade(s, 4), [
    { from: 3, to: 4 },
    { from: 1, to: 3 },
  ]);
});

test('computeKingCascade: King columns on both sides - left is chosen exclusively, right is never touched', () => {
  const s = emptyState();
  s.tableau[1] = [card('spades', 13)];
  s.tableau[3] = [card('hearts', 13)];
  s.tableau[4] = []; // tapped
  s.tableau[6] = [card('clubs', 13)];
  const moves = computeKingCascade(s, 4);
  assert.ok(!moves.some(m => m.from === 6 || m.to === 6));
  assert.equal(moves.length, 2);
});

test('computeKingCascade: no King on the left, King on the right - the right-side King moves left', () => {
  const s = emptyState();
  s.tableau[2] = []; // tapped
  s.tableau[5] = [card('hearts', 13)];
  assert.deepEqual(computeKingCascade(s, 2), [{ from: 5, to: 2 }]);
});

test('computeKingCascade: two right-side Kings at different distances - both shift, closest first, chaining outward', () => {
  const s = emptyState();
  s.tableau[2] = []; // tapped
  s.tableau[5] = [card('hearts', 13)];
  s.tableau[6] = [card('clubs', 13)];
  assert.deepEqual(computeKingCascade(s, 2), [
    { from: 5, to: 2 },
    { from: 6, to: 5 },
  ]);
});

test('computeKingCascade: no eligible King columns anywhere - tapping does nothing', () => {
  const s = emptyState();
  s.tableau[2] = []; // tapped
  s.tableau[0] = [card('clubs', 5)];
  s.tableau[5] = [card('hearts', 9)];
  assert.deepEqual(computeKingCascade(s, 2), []);
});

test('computeKingCascade: a buried King on either side is not an eligible candidate', () => {
  const s = emptyState();
  s.tableau[1] = [card('spades', 13, false), card('hearts', 9)]; // buried - doesn't count
  s.tableau[4] = []; // tapped
  s.tableau[5] = [card('hearts', 13)]; // eligible, to the right
  assert.deepEqual(computeKingCascade(s, 4), [{ from: 5, to: 4 }]);
});

test('computeKingCascade: a partial/broken sequence is not an eligible candidate', () => {
  const s = emptyState();
  s.tableau[1] = [card('spades', 13), card('clubs', 12)]; // broken - both black, same-color, doesn't count
  s.tableau[4] = []; // tapped
  s.tableau[5] = [card('hearts', 13)]; // eligible, to the right
  assert.deepEqual(computeKingCascade(s, 4), [{ from: 5, to: 4 }]);
});

test('computeKingCascade: a non-empty tapped column returns no moves', () => {
  const s = emptyState();
  s.tableau[0] = [card('spades', 13)];
  s.tableau[1] = [card('clubs', 5)]; // not empty
  assert.deepEqual(computeKingCascade(s, 1), []);
});

test('computeKingCascade: a chain stops at a column whose King run has a card buried beneath it, even if another eligible King exists further along', () => {
  const s = emptyState();
  // col1's King run sits on top of a buried face-down card - a legal
  // single move (it reveals that card, exactly as intended), but moving it
  // away does NOT leave col1 empty, so the chain must not continue past it
  // even though col0 is otherwise eligible.
  s.tableau[0] = [card('clubs', 13)];
  s.tableau[1] = [card('hearts', 4, false), card('spades', 13)];
  s.tableau[3] = []; // tapped
  assert.deepEqual(computeKingCascade(s, 3), [{ from: 1, to: 3 }]);
});

test('computeKingCascade: a lone King with nothing buried beneath it - and nothing else eligible - still chains through cleanly', () => {
  const s = emptyState();
  s.tableau[1] = [card('spades', 13)]; // nothing buried - genuinely empties col1
  s.tableau[0] = [card('clubs', 13)];
  s.tableau[3] = []; // tapped
  assert.deepEqual(computeKingCascade(s, 3), [
    { from: 1, to: 3 },
    { from: 0, to: 1 },
  ]);
});

test('computeKingCascade: never mutates state - pure', () => {
  const s = emptyState();
  s.tableau[1] = [card('spades', 13)];
  s.tableau[3] = [card('hearts', 13)];
  s.tableau[4] = [];
  const before = cloneState(s);
  computeKingCascade(s, 4);
  assert.deepEqual(s, before);
});

test('an empty-column King cascade opportunity produces zero legal moves - Hint, Auto Finish, and stuck-game detection all read getLegalMoves, so the cascade is invisible to every one of them by construction', () => {
  const s = emptyState();
  s.tableau[1] = [card('spades', 13)];
  s.tableau[3] = [card('hearts', 13)];
  s.tableau[4] = []; // the empty column a player could tap
  // isolated black filler elsewhere, genuinely zero real moves anywhere
  s.tableau[0] = [card('clubs', 2)];
  s.tableau[2] = [card('clubs', 3)];
  s.tableau[5] = [card('clubs', 4)];
  s.tableau[6] = [card('clubs', 5)];

  assert.ok(computeKingCascade(s, 4).length > 0); // the cascade genuinely is available...
  // ...yet none of these see it:
  assert.equal(getProgressingMoves(s).length, 0);
  assert.equal(autoFinishAvailable(s), false);
  assert.equal(needsAbandonConfirmation(s, 5, false), false);
});
