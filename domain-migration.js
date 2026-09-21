// MIKE GAMES DOMAIN MIGRATION - the DOM half of a temporary system that
// moves players off this game's old *.mikestrassburger.com hostname and
// onto its new *.mikesgames.app one. Remove this file, its markup in
// index.html, its styles in style.css, the inline gate in index.html's
// <head>, and the two guards in script.js once the old hostname is
// retired - the whole system is deliberately self-contained so that
// removal is one small commit rather than an archaeology exercise.
//
// THE GATE IS NOT HERE. The authoritative hostname + date decision lives
// in an inline <script> in index.html's <head> - see that block's own
// comment for why (it has to run before first paint, before any game
// script, and depend on nothing but index.html itself). This file only
// ever reads the decision that gate already made, via window.MIKE_MIGRATION.
//
// What that split buys, concretely:
//   - Phase 2 (on/after the cutoff) needs NOTHING from this file.
//     #migration-screen is static markup in index.html, it is revealed by
//     a stylesheet the gate injects itself, and both of its buttons are
//     real <a href> elements. If this file 404s, is stale, or never runs,
//     the cutoff is still enforced and the screen still works.
//   - Phase 1 (before the cutoff) is the only thing that needs JS, and its
//     failure mode is simply "the notice doesn't appear" - never a game
//     that won't start.
//
// Classic script, not an ES module, and no import of preferences.js: this
// has to be able to run ahead of script.js's whole module graph, and the
// migration system must not entangle itself with this game's preference
// schema or its backup allowlist for the few months it exists.
(function () {
  'use strict';

  var M = window.MIKE_MIGRATION;
  // Not an old hostname (or the gate never ran) - this file does nothing
  // at all. No listeners, no timers, no storage reads.
  if (!M || M.phase === 'none') return;

  // Raw localStorage key rather than preferences.js (see the header): it is
  // origin-scoped device-local nag state with a three-month life, and
  // keeping it out of the preferences blob keeps it out of backup/restore
  // for free - a snooze set on the old origin has no business travelling
  // to a new device, exactly like the installHelp*/homeScreenIcon* keys'
  // own documented reasoning.
  var SNOOZE_KEY = 'mikeGamesMigrationSnoozeUntil';
  var SNOOZE_MS = 3 * 24 * 60 * 60 * 1000; // "Remind Me Later" = 3 days

  var noticeEl = document.getElementById('migration-notice');

  function effectiveNow() { return Date.now() + (M.dateOffsetMs || 0); }

  // --- Live cutoff watch -------------------------------------------------
  // An installed iOS Home Screen PWA is SUSPENDED and RESUMED, not
  // relaunched, when the player switches away and back - its app shell can
  // stay alive for days without this file ever running a second time. A
  // boot-only date check would therefore let a session that happened to
  // start on September 30 keep playing indefinitely past the cutoff, which
  // is the single most likely way for an installed old app to slip through.
  // These signals close that: resume/foreground covers the realistic case,
  // the interval covers an app simply left open across midnight.
  function checkCutoff() {
    if (M.blocked) return;
    if (effectiveNow() < M.cutoffMs) return;
    // Same enforcement path the boot-time gate uses (attribute + injected
    // blackout stylesheet), so a cutoff crossed mid-session is byte-for-byte
    // the same state as a cutoff crossed before the page ever loaded.
    M.enforceBlock();
    if (noticeEl) noticeEl.hidden = true;
  }

  if (!M.blocked) {
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) checkCutoff();
    });
    window.addEventListener('focus', checkCutoff);
    window.addEventListener('pageshow', checkCutoff);
    setInterval(checkCutoff, 60000);
  }

  // Phase 2 is entirely static from here - see the header.
  if (M.blocked) return;

  // --- Phase 1: the pre-cutoff notice ------------------------------------
  if (!noticeEl) return;

  if (M.clearSnooze) {
    try { localStorage.removeItem(SNOOZE_KEY); } catch (e) {}
  }

  function snoozedUntil() {
    try {
      var raw = parseInt(localStorage.getItem(SNOOZE_KEY), 10);
      return isFinite(raw) ? raw : 0;
    } catch (e) {
      return 0; // private browsing / storage disabled - just show the notice
    }
  }

  // Deliberately real wall-clock time, never effectiveNow(): "remind me
  // later" is a real three days. ?migrationDate only ever simulates the
  // CUTOFF, and letting a simulated far-future date land in here would
  // silently suppress the notice on the tester's next genuine visit.
  function snooze() {
    try { localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_MS)); } catch (e) {}
  }

  function dismiss() {
    snooze();
    noticeEl.hidden = true;
  }

  var remindBtn = document.getElementById('migrationRemindBtn');
  if (remindBtn) remindBtn.addEventListener('click', dismiss);

  // Backdrop tap closes it, matching #support-overlay/#install-prompt-overlay's
  // own convention in this app (and, like those two, no Escape handler -
  // this is not the place to introduce a one-off). It SNOOZES rather than
  // merely closing, so however the player gets rid of it, the notice can
  // never come back more often than once every three days. There is
  // deliberately no permanent dismissal anywhere in this system.
  noticeEl.addEventListener('click', function (e) {
    if (e.target === noticeEl) dismiss();
  });

  if (Date.now() < snoozedUntil()) return;

  // The same 1600ms delay shouldShowIconNotice()'s own reveal uses in
  // script.js, for the same reason and with the same contract: NOT gated on
  // the intro finishing (the two systems stay independent, per initIntro()'s
  // "never gates or delays game boot" rule), just staged early enough that
  // it is already in place as the intro lifts rather than popping in after.
  setTimeout(function () {
    if (M.blocked) return; // crossed the cutoff during the intro
    noticeEl.hidden = false;
  }, 1600);
})();
