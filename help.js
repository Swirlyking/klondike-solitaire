// Contextual Help (the `?` Help mode): user-requested, not volunteered - the
// player taps `?`, then taps something in the game to ask "what's this?".
// Pure content + a pure classifier only (no DOM, no localStorage), same
// split as autoTips.js/game-logic.js - script.js supplies the actual mode
// toggle and rendering.
//
// Deliberately its own catalog, not folded into autoTips.js's TIP_CATALOG:
// Help concepts describe WHAT something is ("the stock", "a hidden card"),
// Automatic Tips describe WHICH RULE a specific attempt broke ("wrong
// color") - related vocabularies, not the same one. Where they genuinely
// say the same thing (an empty column only ever accepts a King), this
// reuses TIP_CATALOG's own string below rather than retyping it.
//
// Concept keys (stock, waste, tableau, hidden_card, empty_column,
// foundation) are named for future reuse by Learn to Play/How to Play, not
// just this prototype - see the MIKE Learning System brief - but nothing
// here builds those surfaces.

import { TIP_CATALOG } from './autoTips.js';

export const HELP_CATALOG = {
  stock: {
    headline: 'THE STOCK',
    body: 'Tap here to deal more cards when you need another move.',
  },
  waste: {
    headline: 'THE WASTE',
    body: 'The top card here can be played onto the tableau or a foundation.',
  },
  tableau: {
    headline: 'THE TABLEAU',
    body: 'Build downward, alternating red and black. Move single cards or groups.',
  },
  hidden_card: {
    headline: 'HIDDEN CARD',
    body: 'Clear the cards covering it to turn it face up.',
  },
  empty_column: {
    headline: 'EMPTY COLUMN',
    body: TIP_CATALOG.needs_king_on_empty.body,
  },
  foundation: {
    headline: 'FOUNDATION',
    body: 'Build each suit from Ace to King.',
  },
};

// The one place "which concept does this tap belong to" gets decided - every
// Help entry point in script.js calls this instead of hand-rolling the same
// source/faceUp/empty branching per call site. `source` is the same
// 'stock'/'waste'/'foundation'/'tableau' string script.js already uses
// elsewhere (attachCardInteractions, checkAutoTipOnIllegalTableauDrop) -
// reused here rather than inventing a second vocabulary for the same piles.
export function helpConceptForTarget(source, { faceUp = true, isEmpty = false } = {}) {
  if (source === 'tableau') return isEmpty ? 'empty_column' : (faceUp ? 'tableau' : 'hidden_card');
  if (source === 'stock' || source === 'waste' || source === 'foundation') return source;
  return null;
}
