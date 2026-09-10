// Install-help logic, kept independent of any specific UI - standalone
// detection (reused from pwa-icon-notice.js, never a second
// implementation), iOS/beforeinstallprompt capture, and the
// preferences-backed dismissal/visit-count bookkeeping that decides
// whether the iOS "Add to Home Screen" instructional overlay is allowed
// to show. Pure state/logic - see script.js for the actual overlay
// markup/wiring and the Settings row this also drives.
//
// Ported from Mike's Sudoku's app/installPrompt.js (see
// mike-games-system/SYSTEM.md §02, "Custom install prompt") - same
// eligibility rules and beforeinstallprompt handling, adapted to this
// game's own preferences.js wrapper instead of a raw localStorage blob,
// since that's the existing storage convention here. These three keys
// are deliberately never passed into buildBackup() (see backup.js) -
// same precedent as pwa-icon-notice.js's own homeScreenIconGen/
// homeScreenIconNotice keys: device-local nag/dismissal state has no
// business surviving a restore onto a different device.

import { getPreference, setPreference } from './preferences.js';
import { isStandalonePwa } from './pwa-icon-notice.js';

const VISITS_KEY = 'installHelpVisits';
const NEVER_ASK_AGAIN_KEY = 'installHelpNeverAskAgain';
const NOT_NOW_AT_VISIT_KEY = 'installHelpNotNowAtVisit';
const VISITS_TO_WAIT_AFTER_NOT_NOW = 5;

// Bumped once per app load (see script.js's boot sequence), not on
// every render - "wait N visits" means N separate times the app was
// opened, not N re-renders within the same one.
export function bumpVisitCount() {
  const visits = getPreference(VISITS_KEY, 0) + 1;
  setPreference(VISITS_KEY, visits);
  return visits;
}

// iPadOS 13+ Safari reports itself as "MacIntel" like a real Mac (its
// default desktop-class UA string), but is touch-capable where an
// actual Mac isn't - the standard way to tell the two apart.
export function isIOSDevice() {
  const ua = window.navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  return window.navigator.platform === 'MacIntel' && window.navigator.maxTouchPoints > 1;
}

// Whether the iOS instructional overlay is currently allowed to show -
// false once already installed, on any non-iOS device, after a
// permanent "Got it", or during the cooldown following a "Not now".
export function isEligibleForIOSHelp() {
  if (isStandalonePwa() || !isIOSDevice()) return false;
  if (getPreference(NEVER_ASK_AGAIN_KEY, false)) return false;
  const notNowAtVisit = getPreference(NOT_NOW_AT_VISIT_KEY, null);
  if (notNowAtVisit != null) {
    const visitsSince = getPreference(VISITS_KEY, 0) - notNowAtVisit;
    if (visitsSince < VISITS_TO_WAIT_AFTER_NOT_NOW) return false;
  }
  return true;
}

export function recordGotIt() {
  setPreference(NEVER_ASK_AGAIN_KEY, true);
}

export function recordNotNow() {
  setPreference(NOT_NOW_AT_VISIT_KEY, getPreference(VISITS_KEY, 0));
}

// --- beforeinstallprompt (Chrome/Edge/Android) --------------------------

let deferredPrompt = null;
const availabilityListeners = new Set();

function notifyAvailability() {
  for (const listener of availabilityListeners) listener(deferredPrompt !== null);
}

// Call once, as early as possible - Chrome can fire beforeinstallprompt
// before any user interaction, and the event must be preventDefault()'d
// immediately (not just handled later) to suppress its own mini-infobar
// and keep it available for a deliberate "Install" button instead.
export function initBeforeInstallPromptCapture() {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredPrompt = event;
    notifyAvailability();
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    notifyAvailability();
  });
}

export function isNativeInstallAvailable() {
  return deferredPrompt !== null;
}

// Returns an unsubscribe function.
export function onInstallAvailabilityChange(listener) {
  availabilityListeners.add(listener);
  return () => availabilityListeners.delete(listener);
}

// Invokes the real native install dialog - only ever possible because
// the browser itself offered beforeinstallprompt; there is no way to
// summon this on iOS or on a browser that hasn't fired that event.
export async function promptNativeInstall() {
  if (!deferredPrompt) return null;
  const event = deferredPrompt;
  deferredPrompt = null;
  notifyAvailability();
  event.prompt();
  const { outcome } = await event.userChoice;
  return outcome;
}
