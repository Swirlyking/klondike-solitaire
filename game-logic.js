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

export const MoveCategory = {
  FOUNDATION_MOVE: 'FOUNDATION_MOVE', // any source -> a foundation
  TABLEAU_MOVE: 'TABLEAU_MOVE',       // any source -> a tableau column
  DRAW_STOCK: 'DRAW_STOCK',
  RECYCLE_STOCK: 'RECYCLE_STOCK',
};

// Every currently legal move on the board: objective and unfiltered, with no
// opinion about which ones are worth doing (see classifyMove for that - a
// deliberately separate layer). Each entry:
// { category, source: 'tableau'|'waste'|'foundation'|'stock', sourceIndex,
//   card, stackLength, target: 'tableau'|'foundation'|'waste'|'stock',
//   targetIndex }
// card is null and stackLength is 0 for a stock draw/recycle, which acts on
// a pile rather than a specific card.
export function getLegalMoves(state) {
  const moves = [];

  for (let col = 0; col < state.tableau.length; col++) {
    const column = state.tableau[col];
    for (let i = column.length - 1; i >= 0; i--) {
      const card = column[i];
      if (!card.faceUp) break; // nothing face-up sits above a face-down card
      const stackLength = column.length - i;
      findAllLegalTableau(state, card, col).forEach(targetIndex => {
        moves.push({ category: MoveCategory.TABLEAU_MOVE, source: 'tableau', sourceIndex: col, card, stackLength, target: 'tableau', targetIndex });
      });
      if (stackLength === 1) {
        const fi = anyFoundationFor(state, card);
        if (fi !== -1) moves.push({ category: MoveCategory.FOUNDATION_MOVE, source: 'tableau', sourceIndex: col, card, stackLength: 1, target: 'foundation', targetIndex: fi });
      }
    }
  }

  if (state.waste.length) {
    const card = state.waste[state.waste.length - 1];
    // sourceIndex: null matches the convention script.js already uses for
    // waste-sourced cards (attachCardInteractions passes null, not an
    // index) - resolveClickDestination matches candidates against exactly
    // what the caller passes in.
    findAllLegalTableau(state, card, -1).forEach(targetIndex => {
      moves.push({ category: MoveCategory.TABLEAU_MOVE, source: 'waste', sourceIndex: null, card, stackLength: 1, target: 'tableau', targetIndex });
    });
    const fi = anyFoundationFor(state, card);
    if (fi !== -1) moves.push({ category: MoveCategory.FOUNDATION_MOVE, source: 'waste', sourceIndex: null, card, stackLength: 1, target: 'foundation', targetIndex: fi });
  }

  for (let i = 0; i < state.foundations.length; i++) {
    const pile = state.foundations[i];
    if (!pile.length) continue;
    const card = pile[pile.length - 1];
    findAllLegalTableau(state, card, -1).forEach(targetIndex => {
      moves.push({ category: MoveCategory.TABLEAU_MOVE, source: 'foundation', sourceIndex: i, card, stackLength: 1, target: 'tableau', targetIndex });
    });
  }

  if (state.stock.length > 0) {
    moves.push({ category: MoveCategory.DRAW_STOCK, source: 'stock', sourceIndex: null, card: null, stackLength: 0, target: 'waste', targetIndex: null });
  } else if (state.waste.length > 0) {
    moves.push({ category: MoveCategory.RECYCLE_STOCK, source: 'waste', sourceIndex: null, card: null, stackLength: 0, target: 'stock', targetIndex: null });
  }

  return moves;
}

function moveKey(m) {
  return `${m.category}|${m.source}|${m.sourceIndex}|${m.card ? m.card.id : ''}|${m.target}|${m.targetIndex}`;
}

function nonShuffleReason(move) {
  if (move.target === 'foundation') return 'foundation_progress';
  if (move.category === MoveCategory.DRAW_STOCK) return 'draws_stock';
  if (move.category === MoveCategory.RECYCLE_STOCK) return 'recycles_waste';
  if (move.source === 'waste') return 'clears_waste';
  return 'returns_card'; // source === 'foundation' -> tableau
}

// Is this move genuinely progressive, or a reversible shuffle that leaves
// the board effectively unchanged? Only tableau->tableau moves are
// ambiguous enough to need resolving - every other category is always real
// progress by definition (sending a card home, unsticking the waste,
// drawing/recycling the stock), so those short-circuit immediately.
//
// For a tableau->tableau move: simulate it (cloneState + applyMove, the
// same pair the undo system already uses) and diff getLegalMoves before and
// after, excluding every move belonging to the card/stack actually being
// moved (not just this one destination - the moved card's own set of
// possible next moves is expected to look different after it relocates,
// e.g. its sourceIndex changes, regardless of whether anything meaningful
// happened; comparing the *rest* of the board is what actually answers the
// question). If nothing else differs, the move could be undone for free
// right now - a reversible shuffle. If the diff shows any other change (a
// new destination opened, a previously-legal move gone), something real
// happened, whatever it is - the diff finds it without this function having
// to understand *why*.
//
// One fact is checked directly rather than left to the diff: whether a
// face-down card becomes face-up. A freshly-revealed card only appears in
// getLegalMoves if it already has somewhere to go; if it doesn't yet, the
// diff alone would see no change and call the reveal "trivial," which isn't
// true - a reveal is real, irreversible progress regardless of whether it
// immediately unlocks another move.
export function classifyMove(state, move) {
  if (move.category !== MoveCategory.TABLEAU_MOVE || move.source !== 'tableau') {
    return { status: 'meaningful', reason: nonShuffleReason(move) };
  }

  const col = state.tableau[move.sourceIndex];
  const remaining = col.length - move.stackLength;
  const revealsCard = remaining > 0 && !col[remaining - 1].faceUp;

  const belongsToMovedCard = m => m.card && m.card.id === move.card.id;
  const beforeKeys = new Set(getLegalMoves(state).filter(m => !belongsToMovedCard(m)).map(moveKey));

  const after = cloneState(state);
  const afterStack = getStackFrom(after, move.source, move.sourceIndex, move.card);
  applyMove(after, afterStack, move.source, move.sourceIndex, move.target, move.targetIndex);

  const afterKeys = new Set(getLegalMoves(after).filter(m => !belongsToMovedCard(m)).map(moveKey));

  const graphChanged = beforeKeys.size !== afterKeys.size || [...beforeKeys].some(k => !afterKeys.has(k));

  if (revealsCard) return { status: 'meaningful', reason: 'reveals_card' };
  return graphChanged
    ? { status: 'meaningful', reason: 'changes_available_moves' }
    : { status: 'trivial', reason: 'reversible_shuffle' };
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
//  - tableau source, single card (non-Ace): a legal foundation first, if
//    one exists; only when none does, every legal tableau column, left to
//    right, cycling forward from lastTableauDest each time the same card is
//    clicked again (see nextCycleIndex). A King (or a sequence led by one)
//    relocating between tableau columns is deterministic: the first click
//    targets the first legal empty column to its *right*; repeated clicks
//    keep advancing rightward through every remaining legal column in
//    order; once none remain to the right, the next click wraps to the
//    leftmost legal column overall (which may be to its left) and the
//    cycle continues from there. It never re-targets its own column.
//  - tableau source, multi-card sequence: never a foundation - straight to
//    every legal tableau column, same left-to-right/cycling rule as above.
//  - no legal destination: null, meaning "do nothing".
//
// Sourced from getLegalMoves(state) rather than calling the rule predicates
// directly - this is the same shared enumeration Hint and the abandon
// dialog read from, just filtered down to the one clicked card and reduced
// via the priority/cycling rules above. It deliberately never consults
// classifyMove: a manual click is an intentional action, even when the same
// move wouldn't be worth a Hint or count as "progress."
export function resolveClickDestination(state, card, source, sourceIndex, stackLength, lastTableauDest = null) {
  const isSequence = stackLength > 1;
  const candidates = getLegalMoves(state).filter(
    m => m.source === source && m.sourceIndex === sourceIndex && m.card && m.card.id === card.id
  );
  const foundationMove = candidates.find(m => m.target === 'foundation');
  const tableauTargets = candidates.filter(m => m.target === 'tableau').map(m => m.targetIndex).sort((a, b) => a - b);

  if (card.rank === 1) {
    if (source === 'foundation') return null;
    return foundationMove ? { type: 'foundation', index: foundationMove.targetIndex } : null;
  }

  if (source === 'tableau') {
    if (!isSequence && foundationMove) return { type: 'foundation', index: foundationMove.targetIndex };
    // A King's only legal tableau targets are empty columns (see
    // canPlaceOnTableau). With no cycle memory yet, seed the search from
    // the King's own column instead of the board's leftmost legal column
    // (the latter is what every other card uses) - that's what makes a
    // King's very first click prefer rightward-from-here rather than
    // jumping to whichever empty column happens to be leftmost overall.
    const threshold = (card.rank === 13 && lastTableauDest == null) ? sourceIndex : lastTableauDest;
    const ti = nextCycleIndex(tableauTargets, threshold);
    if (ti !== -1) return { type: 'tableau', index: ti };
    return null;
  }

  if (tableauTargets.length) return { type: 'tableau', index: tableauTargets[0] };
  if (source !== 'foundation' && foundationMove) return { type: 'foundation', index: foundationMove.targetIndex };
  return null;
}

// The single place every destructive action (New Game, Restart, ...)
// consults before discarding the current deal. historyLength and won are
// caller-tracked (script.js), not part of `state` itself. Visibility only -
// script.js separately consults classifyMove to choose the dialog's
// wording ("still available" vs "only non-progressing moves remain").
export function needsAbandonConfirmation(state, historyLength, won) {
  if (historyLength === 0) return false; // nothing played yet - nothing to lose
  if (won) return false;
  return getLegalMoves(state).length > 0;
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
