// Persistent player-stats layer - pure record-comparison logic plus a thin
// wrapper over preferences.js (the project's existing generic localStorage
// store), mirroring how victory.js/game-logic.js separate pure logic from
// script.js's own DOM/browser-only orchestration. Draw 1 and Draw 3 are
// tracked as fully independent records under one stored object - never a
// combined total.

import { getPreference, setPreference } from './preferences.js';

const STATS_KEY = 'stats';
export const MODES = ['draw1', 'draw3'];

// null (not 0) means "no record yet" - a real game can never finish in 0
// seconds or 0 moves, so null stays an unambiguous "never won" sentinel
// throughout, both here and in the UI that reads it. plays counts every
// fresh deal (script.js's newGame(), not restart() - replaying the exact
// same deal isn't a new play) started in this mode, independent of wins.
export function emptyModeStats() {
  return { plays: 0, wins: 0, fastestTimeSeconds: null, fewestMoves: null, lastWin: null };
}

function isPositiveInt(n) {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 && Number.isInteger(n);
}

// Validates one mode's slice field-by-field rather than all-or-nothing -
// a single corrupted field (e.g. a manually-edited localStorage value)
// falls back to that field's own empty default instead of discarding an
// otherwise-intact record.
function sanitizeModeStats(raw) {
  const empty = emptyModeStats();
  if (!raw || typeof raw !== 'object') return empty;

  const plays = isPositiveInt(raw.plays) ? raw.plays : empty.plays;
  const wins = isPositiveInt(raw.wins) ? raw.wins : empty.wins;
  const fastestTimeSeconds = isPositiveInt(raw.fastestTimeSeconds) ? raw.fastestTimeSeconds : empty.fastestTimeSeconds;
  const fewestMoves = isPositiveInt(raw.fewestMoves) ? raw.fewestMoves : empty.fewestMoves;

  let lastWin = empty.lastWin;
  if (raw.lastWin && typeof raw.lastWin === 'object'
    && isPositiveInt(raw.lastWin.timeSeconds) && isPositiveInt(raw.lastWin.moves)) {
    lastWin = { timeSeconds: raw.lastWin.timeSeconds, moves: raw.lastWin.moves };
  }

  return { plays, wins, fastestTimeSeconds, fewestMoves, lastWin };
}

// Always returns a well-formed { draw1, draw3 } regardless of what's
// stored - missing keys, a completely foreign value under the storage key,
// wrong types, or partially-corrupted fields all fail gracefully to that
// piece's own empty default rather than throwing or discarding everything.
export function sanitizeStats(raw) {
  const result = {};
  for (const mode of MODES) {
    result[mode] = sanitizeModeStats(raw && typeof raw === 'object' ? raw[mode] : null);
  }
  return result;
}

// Pure: given one mode's current stats and a just-completed win's result,
// returns the updated slice plus record-flag metadata for the victory
// screen to display. Strict `<` for both comparisons - an exact tie is
// deliberately never a new record. A record only ever needs to have
// *existed* before (fastestTimeSeconds/fewestMoves non-null) to be
// eligible to be beaten - win #1 always saves both as the new baseline but
// never returns a trophy flag, since there was nothing yet to beat.
export function applyWin(modeStats, elapsedSeconds, moveCount) {
  const current = modeStats || emptyModeStats();
  const hadFastest = current.fastestTimeSeconds != null;
  const hadFewest = current.fewestMoves != null;

  const isNewFastest = hadFastest && elapsedSeconds < current.fastestTimeSeconds;
  const isNewFewestMoves = hadFewest && moveCount < current.fewestMoves;

  const fastestTimeSeconds = hadFastest ? Math.min(current.fastestTimeSeconds, elapsedSeconds) : elapsedSeconds;
  const fewestMoves = hadFewest ? Math.min(current.fewestMoves, moveCount) : moveCount;
  const winNumber = current.wins + 1;

  return {
    stats: {
      plays: current.plays ?? 0, // a win never changes the play count - carried through unchanged
      wins: winNumber,
      fastestTimeSeconds,
      fewestMoves,
      lastWin: { timeSeconds: elapsedSeconds, moves: moveCount },
    },
    winNumber,
    isNewFastest,
    isNewFewestMoves,
  };
}

// Pure: a fresh deal starting, independent of whether it's ever won.
export function incrementPlays(modeStats) {
  const current = modeStats || emptyModeStats();
  return { ...current, plays: (current.plays ?? 0) + 1 };
}

// ---------- persistence (impure - the only functions here that touch
// preferences.js/localStorage) ----------

export function loadStats() {
  return sanitizeStats(getPreference(STATS_KEY, null));
}

export function saveStats(stats) {
  setPreference(STATS_KEY, stats);
}

export function getStatsForMode(drawModeKey) {
  return loadStats()[drawModeKey] ?? emptyModeStats();
}

// Loads, applies the win to just this one mode's slice (the other mode's
// stats pass through completely untouched), saves, and returns the same
// result shape applyWin does - the victory screen consumes this directly
// rather than recomputing anything itself.
export function recordWin(drawModeKey, elapsedSeconds, moveCount) {
  const fullStats = loadStats();
  const { stats, winNumber, isNewFastest, isNewFewestMoves } = applyWin(fullStats[drawModeKey], elapsedSeconds, moveCount);
  fullStats[drawModeKey] = stats;
  saveStats(fullStats);
  return { winNumber, isNewFastest, isNewFewestMoves, stats };
}

// Loads, increments just this one mode's play count, saves, and returns the
// updated slice. Called once per fresh deal (script.js's newGame()) -
// independent of recordWin, since most plays never end in a win.
export function recordPlay(drawModeKey) {
  const fullStats = loadStats();
  const updated = incrementPlays(fullStats[drawModeKey]);
  fullStats[drawModeKey] = updated;
  saveStats(fullStats);
  return updated;
}
