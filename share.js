// How a win result actually leaves the device, plus the one place its share
// text is assembled. Pure apart from the injected browser objects, so the
// whole decision tree is testable without a DOM - same split as victory.js/
// stats.js/backup.js/shuffle.js; script.js only ever calls in and renders
// what comes back.
//
// The navigator-interaction half (shareMode/isUserCancel/copyResult/
// shareCelebration) is ported from Mike's Word Flower's own
// src/share-actions.js, the family's one established pattern for a native
// "share your result" action (see mike-games-system/SYSTEM.md) - already
// adopted once before by Mike's Sudoku (src/app/shareResult.js). Identical
// shape here too, renamed only to fit this app's single-file-per-concern
// convention (one share.js, not a separate shareResult.js/celebrationShare.js
// pair - Solitaire's script.js is the only DOM layer either way).
//
// Order of preference:
//   1. navigator.share  - the native share sheet (Messages, Mail, AirDrop,
//      Copy, ...). The player picks the destination there; we never need to
//      show them the text ourselves.
//   2. navigator.clipboard.writeText - when there is no share sheet (most
//      desktop browsers).
//   3. a legacy copy (execCommand-style, supplied by the caller) - only
//      reached when the modern API is missing or refused, which is exactly
//      what happens in an insecure context, where navigator.share and
//      navigator.clipboard don't exist at all.
//   4. 'manual' - the caller shows the text on screen with a "select and
//      copy" instruction.
//
// Never a browser dialog of any kind - no alert, prompt, or confirm - in
// this module or its callers.
//
// IMPORTANT: navigator.share() must be invoked synchronously from the
// user's tap. shareCelebration() calls it before its first await, and
// callers must not await anything before calling shareCelebration.

export function shareMode(nav = globalThis.navigator) {
  return typeof nav?.share === 'function' ? 'native' : 'copy';
}

export function isUserCancel(err) {
  return err?.name === 'AbortError';
}

/**
 * Copy `text`, trying the modern API, then the caller's legacy copier.
 * Resolves to { outcome: 'copied', via: 'clipboard' | 'legacy' } or
 * { outcome: 'manual' }. Never throws.
 */
export async function copyResult({ text, clipboard, legacyCopy = null }) {
  if (typeof clipboard?.writeText === 'function') {
    try {
      await clipboard.writeText(text);
      return { outcome: 'copied', via: 'clipboard' };
    } catch {
      // refused (no activation, permission, insecure context) - try the next path
    }
  }
  if (typeof legacyCopy === 'function') {
    try {
      if (legacyCopy(text)) return { outcome: 'copied', via: 'legacy' };
    } catch {
      // fall through
    }
  }
  return { outcome: 'manual' };
}

/**
 * Share `text` the best way this browser allows. Resolves to one of:
 *   { outcome: 'shared' }                       the share sheet completed
 *   { outcome: 'cancelled' }                    the player dismissed the
 *                                                sheet - not an error
 *   { outcome: 'copied', via, shareError? }     copied to the clipboard
 *                                                (shareError set if the
 *                                                sheet was available but
 *                                                failed for a non-cancel
 *                                                reason and we fell back)
 *   { outcome: 'manual', shareError? }          nothing automatic worked;
 *                                                show the text
 * Never throws.
 */
export async function shareCelebration({ text, nav = globalThis.navigator, clipboard = nav?.clipboard, legacyCopy = null }) {
  let shareError = null;
  if (typeof nav?.share === 'function') {
    try {
      await nav.share({ text }); // synchronous call - nothing awaited before this line
      return { outcome: 'shared' };
    } catch (err) {
      if (isUserCancel(err)) return { outcome: 'cancelled' };
      shareError = err?.message ?? String(err);
    }
  }
  const copied = await copyResult({ text, clipboard, legacyCopy });
  return shareError ? { ...copied, shareError } : copied;
}

// ---------- share text ----------
//
// The share URL is a fixed constant, never window.location.origin - a
// player could open Settings > Share from a Netlify deploy-preview URL,
// file:// during local testing, or (eventually) a wrapped-app internal
// scheme, none of which is a link a recipient could ever open. This is the
// one place that link is written, so nothing downstream can regress it back
// to an origin lookup. Mirrors the exact reasoning Sudoku's own
// celebrationShare.js documents for its own CANONICAL_SHARE_URL.
export const CANONICAL_SHARE_URL = 'https://solitaire.mikesgames.app';

// The exact wording of one record line - "🏆 NEW FASTEST TIME" if this win
// just broke that record, otherwise the ordinary "Fastest: 2:11" readout.
// Exported and reused by script.js's own renderRecordRow (the on-screen
// win card) rather than each keeping its own copy of this ternary, so the
// card a player sees and the text they share can never independently drift
// on the exact same result.
export function formatRecordLine(isNewRecord, trophyText, ordinaryLabel, formattedRecordValue) {
  return isNewRecord ? trophyText : `${ordinaryLabel}: ${formattedRecordValue}`;
}

// Assembles a completed game's share text - the one place this exists, so
// the exact wording can't drift between call sites. Every value here is
// something showVictoryMessage already computed for the on-screen win card
// (see script.js) - this never recomputes or re-derives anything (no fresh
// pickHeadline() call, no fresh formatTime()), so the shared text always
// describes literally the same result the player is looking at, never a
// close-but-different re-roll of it.
//
// showRecords/isNewFastest/isNewFewestMoves/fastestTimeLabel/fewestMoves
// mirror showVictoryMessage's own gating exactly: win #1 has no prior
// record to compare against, so the records section is omitted entirely
// rather than shown as a redundant echo of the result line above it.
export function buildShareText({
  emoji,
  drawCount,
  winNumber,
  timeLabel,
  moveCount,
  showRecords,
  isNewFastest,
  isNewFewestMoves,
  fastestTimeLabel,
  fewestMoves,
}) {
  const lines = [
    'MIKE’S SOLITAIRE',
    `Draw ${drawCount}`,
    '',
    `${emoji} WIN #${winNumber}`,
    `${timeLabel} · ${moveCount} moves`,
  ];
  if (showRecords) {
    lines.push('');
    lines.push(formatRecordLine(isNewFastest, '🏆 NEW FASTEST TIME', 'Fastest', fastestTimeLabel));
    lines.push(formatRecordLine(isNewFewestMoves, '🏆 NEW FEWEST MOVES', 'Fewest moves', fewestMoves));
  }
  lines.push('');
  lines.push(CANONICAL_SHARE_URL);
  return lines.join('\n');
}
