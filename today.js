// "Today" - a quiet daily tally of games and wins, for the player who deals
// again and again chasing at least one win today. Pure logic plus a thin
// wrapper over preferences.js, the same split stats.js uses.
//
// Deliberately small (decided 2026-11-08): only the current local calendar
// day is ever stored - no history, no streaks, no calendar. A record whose
// date isn't today simply reads as an empty day (lazy reset), so there are
// no timers and nothing to do at midnight.
//
// Stored under its own preference key, never inside `stats`: stats.js's
// sanitizeStats() rebuilds that object from draw1/draw3 only (anything else
// would be erased on the next save), and backup.js validates it strictly.
// Keeping it separate leaves both, and every existing lifetime total,
// untouched. Not part of backups either - a restored copy of an old day
// would read as empty anyway.
//
// Draw 1 and Draw 3 are counted separately but shown COMBINED. stats.js's
// "never a combined total" rule is about lifetime records; "did I win
// today?" is about the player's day, not a mode - a deliberate exception.
//
// What counts as a game, and which day/mode gets credit, is decided by
// deal-tally.js. This module only stores what it's told.

import { getPreference, setPreference } from './preferences.js';

const TODAY_KEY = 'today';
const MODES = ['draw1', 'draw3'];

// The device's LOCAL calendar date as YYYY-MM-DD - "today" should match the
// player's own sense of the day, not UTC.
export function todayKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function emptyModeDay() {
  return { games: 0, wins: 0 };
}

export function emptyDay(day) {
  return { date: day, draw1: emptyModeDay(), draw3: emptyModeDay() };
}

function isCount(n) {
  return typeof n === 'number' && Number.isFinite(n) && Number.isInteger(n) && n >= 0;
}

// Field-by-field repair, same forgiving philosophy as stats.js: one bad
// field falls back to 0 rather than discarding the rest. Also restores the
// one invariant the UI depends on - wins never exceed games.
function sanitizeModeDay(raw) {
  if (!raw || typeof raw !== 'object') return emptyModeDay();
  const games = isCount(raw.games) ? raw.games : 0;
  const wins = isCount(raw.wins) ? raw.wins : 0;
  return { games: Math.max(games, wins), wins };
}

export function sanitizeToday(raw) {
  const ok = raw && typeof raw === 'object' && !Array.isArray(raw);
  const date = ok && typeof raw.date === 'string' && DAY_KEY_PATTERN.test(raw.date) ? raw.date : null;
  const result = { date };
  for (const mode of MODES) result[mode] = sanitizeModeDay(ok ? raw[mode] : null);
  return result;
}

// The lazy reset: a stored record for any other day is an empty `day`.
export function readDay(raw, day) {
  const clean = sanitizeToday(raw);
  return clean.date === day ? clean : emptyDay(day);
}

export function addGame(raw, day, mode) {
  const rec = readDay(raw, day);
  if (!MODES.includes(mode)) return rec;
  return { ...rec, [mode]: { ...rec[mode], games: rec[mode].games + 1 } };
}

// deal-tally.js always counts the deal as a game on this day before its
// win, so games >= wins already holds - the Math.max is only a backstop.
export function addWin(raw, day, mode) {
  const rec = readDay(raw, day);
  if (!MODES.includes(mode)) return rec;
  const wins = rec[mode].wins + 1;
  return { ...rec, [mode]: { games: Math.max(rec[mode].games, wins), wins } };
}

export function dayTotals(dayRecord) {
  let games = 0;
  let wins = 0;
  for (const mode of MODES) {
    games += dayRecord[mode].games;
    wins += dayRecord[mode].wins;
  }
  return { games, wins };
}

// The one line under "WIN #N" on the win screen. Only the day's first win
// gets special wording; later wins are a plain running tally.
export function formatTodayWinLine({ games, wins }) {
  if (wins < 1) return '';
  if (wins === 1) return games <= 1 ? 'First win today, first try' : `First win today, on game ${games}`;
  return `${wins} wins today from ${games} games`;
}

// Status line for the Stats panel's Today block.
export function formatTodayStatus({ games, wins }) {
  if (wins > 0) return 'Won today';
  if (games > 0) return 'No win yet today';
  return 'No games yet today';
}

// ---------- persistence (impure) ----------

export function loadTodayRaw() {
  return getPreference(TODAY_KEY, null);
}

export function getToday(day = todayKey()) {
  return readDay(loadTodayRaw(), day);
}

export function recordTodayGame(day, mode) {
  const rec = addGame(loadTodayRaw(), day, mode);
  setPreference(TODAY_KEY, rec);
  return rec;
}

export function recordTodayWin(day, mode) {
  const rec = addWin(loadTodayRaw(), day, mode);
  setPreference(TODAY_KEY, rec);
  return rec;
}
