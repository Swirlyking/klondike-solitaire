// Pure Klondike rule/decision functions — no DOM access, so these can run
// identically in the browser and under a plain Node test runner. Every
// function takes `state` explicitly rather than closing over it.

export function canPlaceOnFoundation(state, card, foundationIndex) {
  const pile = state.foundations[foundationIndex];
  if (!pile.length) return card.rank === 1; // any Ace may start an empty slot
  const top = pile[pile.length - 1];
  return top.suit === card.suit && top.rank === card.rank - 1;
}

// Leftmost legal foundation for this card. Once canPlaceOnFoundation stops
// hard-mapping suit -> index, this loop's natural left-to-right order is
// what gives Aces "leftmost empty slot" priority — no extra logic needed.
export function anyFoundationFor(state, card) {
  for (let i = 0; i < state.foundations.length; i++) {
    if (canPlaceOnFoundation(state, card, i)) return i;
  }
  return -1;
}

export function canPlaceOnTableau(state, card, colIndex) {
  const col = state.tableau[colIndex];
  if (!col.length) return card.rank === 13;
  const top = col[col.length - 1];
  if (!top.faceUp) return false;
  return top.color !== card.color && top.rank === card.rank + 1;
}

// The face-up run starting at `card` through the end of its column — always
// a well-formed descending/alternating sequence by construction, since that
// is the only way cards can be placed on a tableau column in the first place.
export function getStackFrom(state, source, sourceIndex, card) {
  if (source === 'tableau') {
    const col = state.tableau[sourceIndex];
    const idx = col.findIndex(c => c.id === card.id);
    return col.slice(idx);
  }
  return [card];
}

export function findAnyLegalTableau(state, card) {
  for (let i = 0; i < state.tableau.length; i++) {
    if (canPlaceOnTableau(state, card, i)) return i;
  }
  return -1;
}

// Every legal tableau column for this card, left to right, excluding the
// column it's currently sitting in (a card can't be "moved" onto itself).
export function findAllLegalTableau(state, card, excludeIndex) {
  const result = [];
  for (let i = 0; i < state.tableau.length; i++) {
    if (i === excludeIndex) continue;
    if (canPlaceOnTableau(state, card, i)) result.push(i);
  }
  return result;
}

// Given the current legal destinations (ascending) and the column this card
// was sent to last time it was cycled, returns the next one: the smallest
// legal index greater than lastUsed, or the leftmost again if lastUsed was
// at or past the end — a true left-to-right cycle rather than a bounce.
// lastUsed need not appear in legalIndices; it's only ever used as a
// threshold, so a stale or unrelated value still degrades gracefully to
// "the next legal spot after it" (or wraps if there isn't one).
export function nextCycleIndex(legalIndices, lastUsed) {
  if (!legalIndices.length) return -1;
  if (lastUsed == null) return legalIndices[0];
  const after = legalIndices.find(i => i > lastUsed);
  return after !== undefined ? after : legalIndices[0];
}

// Click-to-move destination priority:
//  - Aces always click straight to a foundation, regardless of source, and
//    never to the tableau — the tableau is reachable for an Ace only via an
//    explicit drag. (An Ace can never lead a multi-card sequence — nothing
//    has rank 0 to stack beneath it in a tableau run — so this never blocks
//    a sequence move.) A foundation-sourced Ace has nowhere else to go by
//    click, since foundation-to-foundation is never a legal move.
//  - waste/foundation source (non-Ace): leftmost legal tableau column
//    anywhere, else leftmost legal foundation (foundation skipped entirely
//    for foundation-sourced cards).
//  - tableau source (non-Ace): every legal tableau column, left to right,
//    cycling forward from lastTableauDest each time the same card/sequence
//    is clicked again (see nextCycleIndex); else a legal foundation (single
//    cards only — a multi-card sequence never targets a foundation). A King
//    (or a sequence led by one) relocating between tableau columns is
//    deterministic: the first click targets the first legal empty column to
//    its *right*; repeated clicks keep advancing rightward through every
//    remaining legal column in order; once none remain to the right, the
//    next click wraps to the leftmost legal column overall (which may be to
//    its left) and the cycle continues from there. It never re-targets its
//    own current column.
//  - no legal destination: null, meaning "do nothing".
export function resolveClickDestination(state, card, source, sourceIndex, stackLength, lastTableauDest = null) {
  const isSequence = stackLength > 1;

  if (card.rank === 1) {
    if (source === 'foundation') return null;
    const fi = anyFoundationFor(state, card);
    return fi !== -1 ? { type: 'foundation', index: fi } : null;
  }

  if (source === 'tableau') {
    const legal = findAllLegalTableau(state, card, sourceIndex);
    // A King's only legal tableau targets are empty columns (see
    // canPlaceOnTableau). With no cycle memory yet, seed the search from
    // the King's own column instead of the board's leftmost legal column
    // (the latter is what every other card uses) - that's what makes a
    // King's very first click prefer rightward-from-here rather than
    // jumping to whichever empty column happens to be leftmost overall.
    const threshold = (card.rank === 13 && lastTableauDest == null) ? sourceIndex : lastTableauDest;
    const ti = nextCycleIndex(legal, threshold);
    if (ti !== -1) return { type: 'tableau', index: ti };
    if (!isSequence) {
      const fi = anyFoundationFor(state, card);
      if (fi !== -1) return { type: 'foundation', index: fi };
    }
    return null;
  }

  const ti = findAnyLegalTableau(state, card);
  if (ti !== -1) return { type: 'tableau', index: ti };
  if (source !== 'foundation') {
    const fi = anyFoundationFor(state, card);
    if (fi !== -1) return { type: 'foundation', index: fi };
  }
  return null;
}

// True only when this can be stated with certainty: stock and waste are
// both empty (no more cycling through the stock is possible, ever) AND no
// currently-exposed card (every tableau column's top, every foundation's
// top) has anywhere legal to go. This deliberately does *not* attempt to
// prove a deal is unwinnable while stock/waste still has cards in it -
// drawing could still reveal a move that isn't visible yet, and answering
// that fully would need a real solver, not a rules check. When it can't be
// sure, this returns true (a move might still exist) rather than falsely
// claiming the game is stuck.
export function hasAnyLegalMove(state) {
  if (state.stock.length > 0 || state.waste.length > 0) return true;
  for (let i = 0; i < state.tableau.length; i++) {
    const col = state.tableau[i];
    if (!col.length) continue;
    const top = col[col.length - 1];
    if (anyFoundationFor(state, top) !== -1) return true;
    if (findAllLegalTableau(state, top, i).length > 0) return true;
  }
  for (let i = 0; i < state.foundations.length; i++) {
    const pile = state.foundations[i];
    if (!pile.length) continue;
    // Moving a foundation card back down to the tableau is legal, if
    // unusual - still worth counting as "a move exists".
    if (findAnyLegalTableau(state, pile[pile.length - 1]) !== -1) return true;
  }
  return false;
}

// The single place every destructive action (New Game, Restart, ...)
// consults before discarding the current deal. historyLength and won are
// caller-tracked (script.js), not part of `state` itself.
export function needsAbandonConfirmation(state, historyLength, won) {
  if (historyLength === 0) return false; // nothing played yet - nothing to lose
  if (won) return false;
  return hasAnyLegalMove(state);
}

export function flipNewTopIfNeeded(state, colIndex) {
  const col = state.tableau[colIndex];
  if (col.length && !col[col.length - 1].faceUp) {
    col[col.length - 1].faceUp = true;
  }
}

export function removeFromSource(state, source, sourceIndex, card) {
  if (source === 'waste') {
    state.waste.pop();
  } else if (source === 'foundation') {
    state.foundations[sourceIndex].pop();
  } else if (source === 'tableau') {
    const col = state.tableau[sourceIndex];
    const idx = col.findIndex(c => c.id === card.id);
    const removed = col.splice(idx);
    flipNewTopIfNeeded(state, sourceIndex);
    return removed;
  }
  return [card];
}

// Mutates state: pulls `cards` off their source pile and pushes them onto
// the target pile. Pure state transition — no history/move-count/rendering,
// those are the caller's concern.
export function applyMove(state, cards, source, sourceIndex, target, targetIndex) {
  removeFromSource(state, source, sourceIndex, cards[0]);
  if (target === 'foundation') {
    state.foundations[targetIndex].push(cards[0]);
  } else {
    state.tableau[targetIndex].push(...cards);
  }
}

export function cloneState(state) {
  return JSON.parse(JSON.stringify(state));
}
