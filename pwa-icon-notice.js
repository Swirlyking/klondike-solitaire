// Determines whether this device should see the one-time "your Home Screen
// icon is stale" notice introduced alongside the icon-v2 asset replacement,
// and owns the small pair of persisted markers that decision depends on.
// Kept isolated from script.js's own DOM orchestration for the same reason
// stats.js/preferences.js are: version-detection logic like this is easy
// to get subtly wrong once it's scattered across a much larger file.
//
// Not unit-testable under plain `node --test` (relies on the real
// localStorage/matchMedia/navigator globals, same reason stats.js's own
// persistence wrappers aren't - see stats.test.js's comment); verified
// live in the browser instead.

import { getPreference, setPreference } from './preferences.js';

const ICON_GEN_KEY = 'homeScreenIconGen';
const NOTICE_DISMISSAL_KEY = 'homeScreenIconNotice';
const CURRENT_ICON_GEN = 'v2';
const DISMISSED_VALUE = 'v2-dismissed';

// Stamps this device's icon "generation" exactly once, the very first time
// this code ever runs on it. MUST run before anything else in the session
// writes to the preferences store - specifically before stats.recordPlay(),
// which runs unconditionally on every newGame() and would otherwise make
// even a brand-new device's very first session look like a returning
// player's by the time anything checked.
//
// A device with any pre-existing stats (plays/wins > 0 in either draw
// mode) at this exact moment predates icon-v2 and is stamped 'v1' - it may
// still have the old Home Screen icon and is eligible for the notice. A
// device with no pre-existing stats is a genuinely fresh install and is
// stamped 'v2' directly, the same generation it already ships with - it
// never needs telling to replace an icon it never had. Either way this
// only ever runs once per device: a marker already present short-circuits
// immediately.
export function ensureIconGenerationMarker() {
  if (getPreference(ICON_GEN_KEY, null) != null) return;

  const existingStats = getPreference('stats', null);
  const hadPriorActivity = existingStats != null && ['draw1', 'draw3'].some(mode => {
    const modeStats = existingStats[mode];
    return modeStats && ((modeStats.plays ?? 0) > 0 || (modeStats.wins ?? 0) > 0);
  });

  setPreference(ICON_GEN_KEY, hadPriorActivity ? 'v1' : CURRENT_ICON_GEN);
}

// Exported (not just used internally) so install-prompt.js's own
// eligibility check reuses this exact test rather than a second,
// independently-written standalone-detection - see that module's own
// header for why.
export function isStandalonePwa() {
  return (typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches)
    || window.navigator.standalone === true; // legacy iOS Safari's own standalone flag
}

// The one thing script.js actually needs to know: should the notice appear
// right now. Combines the permanent per-device eligibility marker with the
// current session's actual display mode and the (separate, only-set-when-
// explicitly-requested) dismissal marker - eligibility alone is never
// enough, since an eligible device isn't shown the notice while it's just
// being used in ordinary Safari rather than as an installed Home Screen
// app.
export function shouldShowIconNotice() {
  const gen = getPreference(ICON_GEN_KEY, CURRENT_ICON_GEN);
  if (gen === CURRENT_ICON_GEN) return false;
  if (getPreference(NOTICE_DISMISSAL_KEY, null) === DISMISSED_VALUE) return false;
  return isStandalonePwa();
}

export function dismissIconNoticePermanently() {
  setPreference(NOTICE_DISMISSAL_KEY, DISMISSED_VALUE);
}
