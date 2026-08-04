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
//    (or a sequence led by one) relocating between tableau columns only
//    ever targets an empty column to its *right* — an empty column to its
//    left is reachable only by drag, never by click, so clicking a King
//    never sends it backward across the board.
//  - no legal destination: null, meaning "do nothing".
export function resolveClickDestination(state, card, source, sourceIndex, stackLength, lastTableauDest = null) {
  const isSequence = stackLength > 1;

  if (card.rank === 1) {
    if (source === 'foundation') return null;
    const fi = anyFoundationFor(state, card);
    return fi !== -1 ? { type: 'foundation', index: fi } : null;
  }

  if (source === 'tableau') {
    let legal = findAllLegalTableau(state, card, sourceIndex);
    // A King can only ever legally target an empty column (see
    // canPlaceOnTableau — nothing outranks it), so this scopes those
    // candidates to the right of its current column, never the left.
    if (card.rank === 13) legal = legal.filter(i => i > sourceIndex);
    const ti = nextCycleIndex(legal, lastTableauDest);
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
