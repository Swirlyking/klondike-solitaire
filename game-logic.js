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

// Everything from `card` through the end of its column, tableau-sourced.
// Does not itself verify this is a well-formed descending/alternating run -
// a face-up card can rest directly above an unrelated face-up card (it's
// the run's own base, or was dealt face-up) without the two forming a legal
// build. Callers that need "is this actually one movable unit" should check
// getLegalMoves' entries, which do validate that before offering a
// multi-card TABLEAU_MOVE (see getLegalMoves) - this function just extracts
// whatever's physically there once a target card/id is already known-good.
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
    // Whether column[i..end] is currently a well-formed, alternating,
    // descending run - i.e. actually pickupable as one unit. This is *not*
    // guaranteed just because every card in it is face-up: a face-up card
    // can sit directly above an unrelated face-up card (e.g. it was dealt
    // face-up originally, or is the run's own base sitting on top of
    // whatever was there before) without the two forming a legal build.
    // Starts true for the top card itself - a lone card is trivially its
    // own valid one-card run, with no pairing left to check.
    let validRun = true;
    for (let i = column.length - 1; i >= 0; i--) {
      const card = column[i];
      if (!card.faceUp) break; // nothing face-up sits above a face-down card
      const stackLength = column.length - i;
      if (i < column.length - 1) {
        const above = column[i + 1]; // the card resting on top of `card`
        validRun = validRun && above.color !== card.color && above.rank === card.rank - 1;
      }
      if (validRun) {
        findAllLegalTableau(state, card, col).forEach(targetIndex => {
          moves.push({ category: MoveCategory.TABLEAU_MOVE, source: 'tableau', sourceIndex: col, card, stackLength, target: 'tableau', targetIndex });
        });
      }
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

// Is Auto Finish available? Deliberately looser than "no other move is
// legal": tolerates a harmless tableau shuffle still being technically
// possible, matching how an experienced player judges a deal to be
// effectively won - once nothing is hidden and nothing is left to draw,
// they already know it's over, regardless of whether some card could still
// be nudged sideways.
export function autoFinishAvailable(state) {
  if (state.stock.length > 0) return false;
  if (!state.tableau.every(col => col.every(c => c.faceUp))) return false;
  return getLegalMoves(state).some(m => m.category === MoveCategory.FOUNDATION_MOVE);
}

function nonShuffleReason(move) {
  if (move.target === 'foundation') return 'foundation_progress';
  return 'clears_waste'; // only remaining case: source === 'waste' -> tableau (foundation-sourced and stock moves are handled before this is ever called)
}

// Drawing or recycling only ever changes which card sits on top of the
// waste - it never touches a tableau or foundation top - so whether it can
// ever help depends on whether some card that could still reach one is
// actually capable of *becoming* the waste's top card at all.
//
// At Draw 1 that's every remaining card eventually, but at Draw 3+ it is
// not: onStockClick pops drawCount cards off the end of the stock and
// pushes them onto the waste in that same order, so within each group only
// the last one pushed ends up exposed - the other drawCount-1 are
// immediately buried underneath it. Recycling pops the waste from its end
// and pushes onto the stock in that order too, which is a second reversal
// that exactly undoes the first - a recycle always restores the precise
// pre-pass stock order (confirmed by direct simulation), so every pass
// draws the identical groups in the identical order, forever. A card that
// isn't the last card of its group is therefore never individually
// reachable, no matter how many times the stock is cycled.
//
// state.stock (bottom-to-top) is exactly the undrawn prefix of this pass's
// original order; state.waste (bottom-to-top) is exactly that same order's
// drawn suffix, reversed (each draw reverses the group it moves) - so
// un-reversing the waste and appending it back after the stock reconstructs
// this pass's full original order, from which the reachable (last-of-
// -group, counting from the top) cards can be read off directly.
function stockHasReachableCard(state, drawCount) {
  const order = [...state.stock, ...state.waste.slice().reverse()]; // bottom-to-top, this pass's original order
  let pos = order.length - 1;
  while (pos >= 0) {
    const groupSize = Math.min(drawCount, pos + 1);
    const exposedCard = order[pos - groupSize + 1]; // the last card drawn in this group - the only one ever exposed as the waste's top
    if (anyFoundationFor(state, exposedCard) !== -1 || findAnyLegalTableau(state, exposedCard) !== -1) return true;
    pos -= groupSize;
  }
  return false;
}

// For every card NOT in `excludeIds`: can it currently reach a foundation,
// and can it currently reach anywhere at all (foundation or tableau)? Used
// to compare a board before/after a simulated move by what each card can
// *do*, not by which exact column it would land in - see classifyMove.
function opportunityMap(state, excludeIds) {
  const map = new Map();
  getLegalMoves(state).forEach(m => {
    if (!m.card || excludeIds.has(m.card.id)) return;
    const entry = map.get(m.card.id) || { playable: false, foundation: false };
    entry.playable = true;
    if (m.category === MoveCategory.FOUNDATION_MOVE) entry.foundation = true;
    map.set(m.card.id, entry);
  });
  return map;
}

// Is this move genuinely progressive, or a reversible shuffle that leaves
// the board effectively unchanged? Sending a card home or unsticking the
// waste onto the tableau are always real progress by definition, so those
// short-circuit immediately. Two other categories get their own direct
// policy instead of that automatic pass, both for the same underlying
// reason - a move can be perfectly legal Klondike and still not be worth
// doing (getLegalMoves is never weakened for either case):
// - foundation-sourced moves (taking a card back out) are always trivial -
//   a step backward, never counted as progress, no matter what it might
//   theoretically unlock.
// - stock draws/recycles are trivial too, but only once nothing left in
//   the stock or waste can ever actually *reach* the waste's top - see
//   stockHasReachableCard. Until then they're real progress, same as ever.
//   drawCount defaults to 1 (Draw 1, where every remaining card eventually
//   reaches the top) so callers that don't care about the distinction -
//   most tests, and every reason unrelated to stock/waste - are unaffected;
//   real gameplay must pass the game's actual draw count explicitly.
//
// Two things are checked directly, before any simulation:
// - revealsCard: a face-down card becomes face-up. This can't be inferred
//   from a legal-move diff - a freshly-revealed card only appears in
//   getLegalMoves if it already has somewhere to go, so a reveal that
//   doesn't immediately unlock anything would otherwise look like nothing
//   happened, when it's real, irreversible progress regardless.
// - emptiesColumn: the *net* number of empty tableau columns goes up. Net,
//   not "the source column happens to end up empty" - a King relocating
//   from one already-empty column to another empty one also "empties its
//   column," but the total count of empty columns is unchanged, so nothing
//   was actually gained (see the King-shuffle tests).
//
// Everything else is decided by simulating the move (cloneState + applyMove,
// the same pair the undo system already uses) and comparing, for every card
// *not* carried by this move, whether it gains the ability to reach a
// foundation or reach anywhere at all. This is a deliberately different
// comparison than diffing getLegalMoves' raw entries: two red 6s are
// interchangeable parking spots for a black 5, so if a 5 could already
// reach *some* red 6 before and can reach a (possibly different) one after,
// nothing new opened up - even though the exact (source, target) column
// pair in getLegalMoves changed. Comparing at the level of "what can this
// card do" rather than "which exact column" is what correctly ignores that
// kind of relabeling while still catching a genuinely new opportunity
// elsewhere on the board.
//
// Every card actually carried by the move (the full stack, via getStackFrom
// - not just move.card, the stack's base) is excluded from that comparison.
// A multi-card run's own sub-stack moves (e.g. moving just the top two
// cards of a three-card sequence) are separate getLegalMoves entries whose
// sourceIndex always travels with the run - comparing those would always
// look like something changed, even when the run just relocated in whole.
export function classifyMove(state, move, drawCount = 1) {
  if (move.source === 'foundation') {
    return { status: 'trivial', reason: 'foundation_return' };
  }

  if (move.category === MoveCategory.DRAW_STOCK || move.category === MoveCategory.RECYCLE_STOCK) {
    return stockHasReachableCard(state, drawCount)
      ? { status: 'meaningful', reason: move.category === MoveCategory.DRAW_STOCK ? 'draws_stock' : 'recycles_waste' }
      : { status: 'trivial', reason: 'stock_exhausted' };
  }

  if (move.category !== MoveCategory.TABLEAU_MOVE || move.source !== 'tableau') {
    return { status: 'meaningful', reason: nonShuffleReason(move) };
  }

  const col = state.tableau[move.sourceIndex];
  const remaining = col.length - move.stackLength;
  const revealsCard = remaining > 0 && !col[remaining - 1].faceUp;
  if (revealsCard) return { status: 'meaningful', reason: 'reveals_card' };

  const after = cloneState(state);
  const afterStack = getStackFrom(after, move.source, move.sourceIndex, move.card);
  applyMove(after, afterStack, move.source, move.sourceIndex, move.target, move.targetIndex);

  const emptyBefore = state.tableau.filter(c => c.length === 0).length;
  const emptyAfter = after.tableau.filter(c => c.length === 0).length;
  if (emptyAfter > emptyBefore) return { status: 'meaningful', reason: 'empties_column' };

  const movedIds = new Set(getStackFrom(state, move.source, move.sourceIndex, move.card).map(c => c.id));
  const before = opportunityMap(state, movedIds);
  const afterMap = opportunityMap(after, movedIds);

  let opened = false;
  afterMap.forEach((entry, id) => {
    const prior = before.get(id) || { playable: false, foundation: false };
    if ((entry.playable && !prior.playable) || (entry.foundation && !prior.foundation)) opened = true;
  });

  return opened
    ? { status: 'meaningful', reason: 'changes_available_moves' }
    : { status: 'trivial', reason: 'reversible_shuffle' };
}

// The shared "is this worth doing" filter - Hint and the abandon dialog
// both call this instead of classifyMove directly, so the two can never
// disagree about what counts as progress. Never reimplements the rule,
// only selects from exactly what classifyMove already decided. drawCount
// matters only for DRAW_STOCK/RECYCLE_STOCK moves - see classifyMove.
export function getProgressingMoves(state, drawCount = 1) {
  return getLegalMoves(state).filter(m => classifyMove(state, m, drawCount).status === 'meaningful');
}

// Hint's ranking policy - a fourth, separate layer on top of getLegalMoves,
// classifyMove, and getProgressingMoves. Never generates or filters moves
// itself, only reorders exactly the array it was given - Hint calls this on
// getProgressingMoves(state)'s output, so the result is always a permutation
// of that (never something classifyMove would reject, and never something
// getLegalMoves didn't produce in the first place).
//
// Priority: reaching a foundation first (always the best use of a card),
// then revealing a hidden tableau card, then any other tableau
// rearrangement, then stock/waste actions last (drawing or recycling never
// improves the board on its own - it only sets up a future move). Stable
// within each tier: Array.prototype.sort is required to be stable, so ties
// keep getLegalMoves' own left-to-right, top-to-bottom order.
function movePriority(state, move) {
  if (move.category === MoveCategory.FOUNDATION_MOVE) return 0;
  if (move.category === MoveCategory.TABLEAU_MOVE) {
    return classifyMove(state, move).reason === 'reveals_card' ? 1 : 2;
  }
  return 3; // DRAW_STOCK / RECYCLE_STOCK
}

export function rankMoves(state, moves) {
  return [...moves].sort((a, b) => movePriority(state, a) - movePriority(state, b));
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
