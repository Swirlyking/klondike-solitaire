// The one-time "what's new" notice: shown once to a returning player after
// an update that changed something they'd want to know about, and never to
// a brand-new install (nothing is "new" to a device that shipped with the
// feature already in it).
//
// Same shape, and the same reasoning, as pwa-icon-notice.js's generation
// marker - see that file's header. The split here is deliberate: the
// DECISION is pure and unit-tested below-the-line in whats-new.test.js,
// while the three thin wrappers that read and write the preference store
// are not (they need real localStorage, exactly the reason stats.js's own
// persistence wrappers aren't tested either).
//
// This is NOT an update-delivery mechanism. Getting new code to a player
// is already handled, unchanged, by the ETag-polling update bar and
// hardReload() in script.js. This only decides whether to say anything
// about it once the new code is running.
import { getPreference, setPreference } from './preferences.js';
import { hasPriorActivity } from './pwa-icon-notice.js';

const SEEN_KEY = 'whatsNewSeen';

// The id of the note this build wants to show. Bumping it is what makes a
// FUTURE update eligible to say something again: every device that has
// already seen this one is stamped with this exact string, so a new id is
// simply "not seen yet" for everybody at once. A hand-bumped constant with
// no build step behind it, same convention as APP_VERSION/ASSET_VERSION.
export const CURRENT_NOTE = 'flick-any-single-card';

// The whole decision, as a pure function of the two things it depends on.
//   'already-seen'  - this device has been told about this note
//   'fresh-install' - no stored marker AND no prior play: the feature was
//                     never new to this device, so it is stamped as seen
//                     and the notice never appears
//   'show'          - a returning player who has not seen THIS note, which
//                     includes anyone stamped with an older note's id
export function whatsNewDecision({ seen, hadPriorActivity }) {
  if (seen === CURRENT_NOTE) return 'already-seen';
  if (seen == null && !hadPriorActivity) return 'fresh-install';
  return 'show';
}

// Must run before anything else in the session writes to the preference
// store - specifically before stats.recordPlay(), which runs on every
// newGame() and would make a brand-new device look like a returning player
// by the time anything checked. Exactly the ordering constraint
// ensureIconGenerationMarker() documents, and it is called beside it.
export function ensureWhatsNewMarker() {
  const seen = getPreference(SEEN_KEY, null);
  if (whatsNewDecision({ seen, hadPriorActivity: hasPriorActivity() }) === 'fresh-install') {
    setPreference(SEEN_KEY, CURRENT_NOTE);
  }
}

export function shouldShowWhatsNew() {
  return whatsNewDecision({
    seen: getPreference(SEEN_KEY, null),
    hadPriorActivity: hasPriorActivity(),
  }) === 'show';
}

// Called when the notice is SHOWN, not when its button is pressed. That is
// what makes it appear exactly once rather than once per launch until
// someone happens to tap the right thing: a player who reads it and
// switches away has still been told, and should not be told again.
export function markWhatsNewSeen() {
  setPreference(SEEN_KEY, CURRENT_NOTE);
}
