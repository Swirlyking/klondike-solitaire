// Automatic Tips: gentle, volunteered rule explanations after repeated
// evidence a player is misunderstanding a specific rule - never a Hint
// (which suggests a move), never a tutorial, never fired on a single
// mistake. Pure logic only (no DOM, no localStorage) - same split as
// stats.js/victory.js - so script.js supplies persistence/rendering and
// this stays fully unit-testable under `node --test`.
//
// Deliberately two separate things, per the MIKE Learning System's own
// forward-looking architecture note: TIP_CATALOG is the *content* (what a
// concept says), the functions below are the *mechanism* (when a concept
// gets volunteered). A later contextual-help/tutorial/How-to-Play surface
// can reuse these same concept keys (same_color, wrong_rank,
// needs_king_on_empty, covered_card) without touching this trigger logic.

export const TIP_CATALOG = {
  same_color: { headline: 'WRONG COLOR', body: 'Build downward, alternating colors.' },
  wrong_rank: { headline: 'ONE STEP AT A TIME', body: 'Cards build downward one number at a time.' },
  needs_king_on_empty: { headline: 'KINGS ONLY', body: 'Only a King can start an empty column.' },
  covered_card: { headline: 'STILL COVERED', body: 'Clear the cards covering this one first.' },
};

// A single failed attempt is normal experimentation, not evidence of a
// misunderstanding - require the *same* category to repeat before
// volunteering anything. One shared threshold for every category in this
// prototype (small and easy to reason about, per the brief) but each
// category's count is fully independent, so nothing here has to change to
// tune one category differently later.
export const TIP_TRIGGER_THRESHOLD = 2;

const CATEGORIES = Object.keys(TIP_CATALOG);

function zeroed() {
  return Object.fromEntries(CATEGORIES.map(c => [c, 0]));
}
function falsed() {
  return Object.fromEntries(CATEGORIES.map(c => [c, false]));
}

// Per-deal state. Never persisted - Solitaire has no save/resume for the
// active deal (see SYSTEM.md §03), so there's nothing to write to disk and
// nothing here can ever contaminate a real game save. Reset on New Game
// only, not Restart - a tip already shown for this exact deal shouldn't
// start volunteering itself again just because the player replayed the same
// hand (see script.js's restart(), which deliberately does not call
// resetAutoTipState()).
export function createAutoTipState() {
  return { counts: zeroed(), shown: falsed() };
}

// Records one failed attempt in `category`. Returns the (possibly
// unchanged) next state plus `tipId`: the category to show now, or null.
// A category already shown this deal never re-arms (no nagging) - counting
// stops for it entirely, not just the display.
export function recordTipTrigger(tipState, category) {
  if (!(category in TIP_CATALOG) || tipState.shown[category]) {
    return { nextState: tipState, tipId: null };
  }
  const count = tipState.counts[category] + 1;
  if (count < TIP_TRIGGER_THRESHOLD) {
    return { nextState: { ...tipState, counts: { ...tipState.counts, [category]: count } }, tipId: null };
  }
  return {
    nextState: {
      counts: { ...tipState.counts, [category]: 0 },
      shown: { ...tipState.shown, [category]: true },
    },
    tipId: category,
  };
}

// A demonstrated correct use of a rule clears any in-progress miscount for
// it, so a stale near-miss from earlier doesn't combine with an unrelated
// later one. Does not clear `shown` - a tip already volunteered this deal
// stays suppressed regardless of how the player plays afterward.
export function recordRuleDemonstrated(tipState, categories) {
  if (!categories.length) return tipState;
  const counts = { ...tipState.counts };
  for (const c of categories) {
    if (c in counts) counts[c] = 0;
  }
  return { ...tipState, counts };
}
