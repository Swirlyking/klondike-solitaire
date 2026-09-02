// Pure backup/restore schema logic - mirrors how game-logic.js/victory.js/
// stats.js separate pure logic from script.js's DOM/browser orchestration.
// This file never touches localStorage or the DOM; script.js supplies the
// live preference values in and reads validated ones back out.
//
// The backup format is intentionally versioned (backupVersion, independent
// of APP_VERSION) so a future change to what's backed up - a new
// preference, a restructured stats shape - can add a migration step here
// without breaking a restore of an older file. Only version 1 exists today.

export const BACKUP_APP_ID = 'mikes-solitaire';
export const CURRENT_BACKUP_VERSION = 1;

// Builds the exportable backup object from the caller's current preference
// values. Deliberately an explicit allowlist of fields (cardStyle,
// cardBack, drawCount, stats) rather than a blind dump of everything in
// storage - ephemeral/internal state (e.g. the Home Screen icon notice's
// migration/dismissal markers) is never passed in here in the first place,
// so it can't end up in a backup by accident.
export function buildBackup({ cardStyle, cardBack, drawCount, stats }) {
  return {
    app: BACKUP_APP_ID,
    backupVersion: CURRENT_BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    data: { cardStyle, cardBack, drawCount, stats },
  };
}

// Structural validation only - "is this recognizably a Mike's Solitaire
// backup file this code knows how to read at all". Field-by-field
// validation of data's own contents (is cardBack a real design id, is
// stats well-formed, ...) is a separate, later step - see
// resolveRestorePatch below.
export function validateBackup(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'not-an-object' };
  }
  if (parsed.app !== BACKUP_APP_ID) {
    return { ok: false, reason: 'wrong-app' };
  }
  if (typeof parsed.backupVersion !== 'number' || !Number.isInteger(parsed.backupVersion) || parsed.backupVersion < 1) {
    return { ok: false, reason: 'missing-version' };
  }
  if (parsed.backupVersion > CURRENT_BACKUP_VERSION) {
    return { ok: false, reason: 'unsupported-version' };
  }
  if (!parsed.data || typeof parsed.data !== 'object' || Array.isArray(parsed.data)) {
    return { ok: false, reason: 'missing-data' };
  }
  // Room for a per-version migration step here once backupVersion 2+
  // exists (e.g. `if (parsed.backupVersion === 1) parsed = migrateV1(parsed);`)
  // - not needed yet since CURRENT_BACKUP_VERSION is still 1.
  return { ok: true, data: parsed.data, backupVersion: parsed.backupVersion };
}

// A couple of retired preference values from earlier Solitaire versions
// that map cleanly onto a current equivalent - 'flowers' (plural) became
// 'flower' when the card-back set was replaced, same design either way.
// Exported so script.js's own one-time localStorage migration (for a
// device's existing stored preference, independent of any backup) reads
// from this exact same map rather than keeping a second copy that could
// drift from this one. Any OTHER retired id (green, purple, rabbit - no
// current equivalent) is deliberately absent here: those fail restore
// outright via resolveRestorePatch below rather than falling back to
// something arbitrary.
export const LEGACY_CARD_BACK_IDS = { flowers: 'flower' };

function isPositiveInt(n) {
  return typeof n === 'number' && Number.isFinite(n) && Number.isInteger(n) && n >= 0;
}

// One mode's stats slice (draw1 or draw3) - every field required and
// individually well-typed. Unlike stats.js's sanitizeModeStats (which
// exists to gracefully recover a corrupted REAL localStorage value by
// falling each bad field back to its own empty default), this rejects
// outright rather than repairing - a backup's job is to faithfully
// reproduce what it claims to contain, not to be silently patched into
// something plausible.
function isValidModeStats(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  if (!isPositiveInt(raw.plays)) return false;
  if (!isPositiveInt(raw.wins)) return false;
  if (raw.fastestTimeSeconds !== null && !isPositiveInt(raw.fastestTimeSeconds)) return false;
  if (raw.fewestMoves !== null && !isPositiveInt(raw.fewestMoves)) return false;
  if (raw.lastWin !== null) {
    if (!raw.lastWin || typeof raw.lastWin !== 'object' || Array.isArray(raw.lastWin)) return false;
    if (!isPositiveInt(raw.lastWin.timeSeconds) || !isPositiveInt(raw.lastWin.moves)) return false;
  }
  return true;
}

// The full { draw1, draw3 } stats payload - both modes required and valid
// if `stats` is present at all. undefined (the key was never included in
// this backup) and null both mean the same thing here - "this backup
// doesn't carry stats", not "the stats are broken" - current stats are
// left untouched either way. null specifically matters because
// currentBackupFields() in script.js builds a backup from
// getPreference('stats', null) - a device that has never played produces
// exactly stats: null in its own, entirely legitimate, self-generated
// backup; rejecting that as "corrupted" would be a real bug, not caution.
// Anything else that doesn't fully qualify (missing a mode, a malformed
// field several layers down, wrong types) fails the whole payload rather
// than being partially accepted - this is specifically what stops
// malformed nested stats data from sneaking through just because the
// top-level `stats` key exists.
export function isValidStatsPayload(raw) {
  if (raw === undefined || raw === null) return true;
  if (typeof raw !== 'object' || Array.isArray(raw)) return false;
  return isValidModeStats(raw.draw1) && isValidModeStats(raw.draw3);
}

// The single entry point for turning a validated backup's `data` into a
// ready-to-write patch - or rejecting the ENTIRE restore. There is no
// partial outcome: every field the backup actually includes must
// independently resolve to something currently valid (directly, or via
// LEGACY_CARD_BACK_IDS above) or this returns ok:false and the caller
// must not write anything at all. A field simply absent from `data` is
// different from an invalid one - it's omitted from the returned patch
// (leaving whatever's already on the device for that field alone) rather
// than causing a failure.
//
// validCollectionIds/validCardBackIds are supplied by the caller (script.js's
// live CARD_COLLECTIONS/CARD_BACKS registries) since this module has no
// registry of its own to check against - keeps this fully pure/testable
// without needing to import script.js's local, non-exported constants.
export function resolveRestorePatch(data, { validCollectionIds, validCardBackIds }) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, reason: 'invalid-data' };
  }

  const patch = {};

  if (data.cardStyle !== undefined) {
    if (typeof data.cardStyle !== 'string' || !validCollectionIds.includes(data.cardStyle)) {
      return { ok: false, reason: 'invalid-cardStyle' };
    }
    patch.cardStyle = data.cardStyle;
  }

  if (data.cardBack !== undefined) {
    if (typeof data.cardBack !== 'string') return { ok: false, reason: 'invalid-cardBack' };
    const migrated = LEGACY_CARD_BACK_IDS[data.cardBack] || data.cardBack;
    if (!validCardBackIds.includes(migrated)) {
      return { ok: false, reason: 'invalid-cardBack' };
    }
    patch.cardBack = migrated;
  }

  if (data.drawCount !== undefined) {
    if (data.drawCount !== '1' && data.drawCount !== '3') {
      return { ok: false, reason: 'invalid-drawCount' };
    }
    patch.drawCount = data.drawCount;
  }

  if (data.stats !== undefined && data.stats !== null) {
    if (!isValidStatsPayload(data.stats)) {
      return { ok: false, reason: 'invalid-stats' };
    }
    patch.stats = data.stats;
  }

  return { ok: true, patch };
}

// Human-readable explanation for every validateBackup()/resolveRestorePatch()
// failure reason - script.js's error message and this module's own test
// suite both read from the same map, so the two can't drift apart.
export const VALIDATION_ERROR_MESSAGES = {
  'not-an-object': "That file doesn't look like a Mike's Solitaire backup.",
  'wrong-app': "That file doesn't look like a Mike's Solitaire backup.",
  'missing-version': "That file doesn't look like a Mike's Solitaire backup.",
  'unsupported-version': 'That backup was made with a newer version of Mike’s Solitaire and can’t be restored here.',
  'missing-data': "That backup file looks incomplete and can't be restored.",
  'invalid-data': "That backup file looks incomplete and can't be restored.",
  'invalid-cardStyle': "That backup contains a card style this version of Mike's Solitaire doesn't recognize, so nothing was restored.",
  'invalid-cardBack': "That backup contains a card back design this version of Mike's Solitaire doesn't recognize, so nothing was restored.",
  'invalid-drawCount': "That backup contains a deal style this version of Mike's Solitaire doesn't recognize, so nothing was restored.",
  'invalid-stats': "That backup's saved stats look corrupted, so nothing was restored.",
};

// YYYY-MM-DD from the caller-supplied Date (script.js passes `new Date()`
// rather than this module reaching for the clock itself, matching how
// buildBackup() takes its data as plain arguments rather than reading
// anything live on its own).
export function backupFilename(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `mikes-solitaire-backup-${y}-${m}-${d}.json`;
}
