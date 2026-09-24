// Pure pieces of the update checker (the DOM/fetch/timer side lives in
// script.js's "update checking" IIFE). See mike-games-system/SYSTEM.md §05:
// no build step, so a new deploy is detected by fingerprinting the site's
// own files with HEAD requests (content-derived ETag, else Last-Modified)
// rather than a hand-maintained version number.

// Every file the running page is built from: index.html, style.css, the
// classic domain-migration script, the manifest, and every module reachable
// from script.js's static imports. A deploy that changes only one module
// (a tweak to game-logic.js, say) must still count as an update.
// update-check.test.js recomputes the import graph from the real files and
// fails if this list misses any of them.
export const CHECK_FILES = [
  'index.html', 'style.css', 'manifest.json', 'domain-migration.js',
  'script.js', 'autoTips.js', 'backup.js', 'card-face-compositor.js', 'flick.js',
  'game-logic.js', 'help.js', 'install-prompt.js', 'preferences.js',
  'pwa-icon-notice.js', 'share.js', 'shuffle.js', 'stats.js',
  'tableau-scroll.js', 'update-check.js', 'victory.js', 'whats-new.js',
];

export const CHECK_INTERVAL_MS = 60000;

// `responses`: one { ok, etag, lastModified } per CHECK_FILES entry, in
// order. Any failed or unfingerprintable file means "no answer this time"
// (null), never "changed" - offline, a flaky edge or a host without either
// header must not produce a false prompt.
export function fingerprint(responses) {
  if (!Array.isArray(responses) || responses.length !== CHECK_FILES.length) return null;
  const parts = [];
  for (const r of responses) {
    const tag = r && r.ok ? (r.etag || r.lastModified || '') : '';
    if (!tag) return null;
    parts.push(tag);
  }
  return parts.join('|');
}

// The first successful fingerprint after load is the baseline for what
// this page is running; any later, different one is a newer deploy.
export function isNewer(baseline, current) {
  return !!(baseline && current && baseline !== current);
}

// A reload discards the current deal (Solitaire deliberately has no
// save/resume), so the bar only appears when there's nothing to lose -
// `betweenGames` is the same judgement guardAbandon() uses before a
// reload or new deal (needsAbandonConfirmation, false).
export function shouldShowUpdateBar({ updateAvailable, dismissed, betweenGames } = {}) {
  return !!(updateAvailable && !dismissed && betweenGames);
}
