// Per-deal counting rules for lifetime Plays (stats.js) and Today's games and
// wins (today.js). Pure: every function takes the current deal state and
// returns the next one plus a list of effects for script.js to apply, so the
// sequencing (first move, Undo, Restart, abandoned deals, mode changes,
// midnight) is unit-tested here instead of only by hand.
//
// Rules (decided 2026-11-08):
// - A deal counts as played on its first COMMITTED move (anything that goes
//   through script.js's pushHistory(): a card move, a stock draw or recycle,
//   one grouped Auto Finish run) - never when it's merely dealt, so app
//   launches and reloads don't count.
// - Its Draw 1/Draw 3 mode is locked at that first move, never earlier: an
//   interrupted attempt (a stock draw superseded by New Game/Restart while
//   its card art loads) locks nothing. A first stock draw locks to the mode
//   it computed its card count from, so it follows those rules. Every effect for the deal
//   is credited to that mode, and script.js keeps dealing the stock in it
//   until New Game, even if Deal Style changes mid-deal.
// - One lifetime Play per deal, ever.
// - One Today game per deal per calendar day: a deal played on both sides of
//   midnight is a game on each day.
// - A win belongs to the day it completes. If the deal hasn't counted as a
//   game that day yet, it does so first, so a day's wins never exceed its
//   games.
// - Restarting an already-won deal and winning it again still records a
//   lifetime win (unchanged behavior - replaying a known deal for a faster
//   time is legitimate), but adds no second Today win on the same day: one
//   deal never counts twice on one day.
//
// The state is created fresh by New Game only. Undo and Restart keep it -
// they don't start a new deal.

export function createDeal() {
  return { mode: null, playCounted: false, lastCountedDay: null, lastWinDay: null };
}

// No-op once locked. Called with the stock draw's own mode just before that
// draw is committed; also implied by every committed move.
export function lockMode(deal, settingMode) {
  if (deal.mode) return deal;
  return { ...deal, mode: settingMode };
}

export function onCommittedMove(deal, day, settingMode) {
  let next = lockMode(deal, settingMode);
  const effects = [];
  if (!next.playCounted) {
    next = { ...next, playCounted: true };
    effects.push({ type: 'lifetimePlay', mode: next.mode });
  }
  if (next.lastCountedDay !== day) {
    next = { ...next, lastCountedDay: day };
    effects.push({ type: 'todayGame', day, mode: next.mode });
  }
  return { deal: next, effects };
}

export function onWin(deal, day, settingMode) {
  const { deal: counted, effects } = onCommittedMove(deal, day, settingMode);
  let next = counted;
  effects.push({ type: 'lifetimeWin', mode: next.mode });
  if (next.lastWinDay !== day) {
    next = { ...next, lastWinDay: day };
    effects.push({ type: 'todayWin', day, mode: next.mode });
  }
  return { deal: next, effects };
}
