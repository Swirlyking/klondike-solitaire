import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBackup, validateBackup, resolveRestorePatch, isValidStatsPayload, backupFilename,
  BACKUP_APP_ID, CURRENT_BACKUP_VERSION, LEGACY_CARD_BACK_IDS,
} from './backup.js';

// Mirrors script.js's real CARD_FACE_DESIGNS/CONDITIONS/CARD_BACKS
// registries closely enough for these tests' purposes - resolveRestorePatch
// only ever reads these as plain id lists, never anything design/back-
// specific.
const VALID_FACE_DESIGN_IDS = ['regular', 'simple'];
const VALID_CONDITION_IDS = ['worn', 'clean'];
const VALID_CARD_BACK_IDS = [
  'lovebirds', 'mod_pop', 'north_star_blue', 'north_star_red', 'mesmer',
  'parlor_blue', 'parlor_red', 'fireflower_blue', 'fireflower_red', 'flower', 'eye', 'blue', 'red',
];
const REGISTRIES = {
  validFaceDesignIds: VALID_FACE_DESIGN_IDS,
  validConditionIds: VALID_CONDITION_IDS,
  validCardBackIds: VALID_CARD_BACK_IDS,
};

function validModeStats(overrides) {
  return { plays: 10, wins: 3, fastestTimeSeconds: 120, fewestMoves: 80, lastWin: { timeSeconds: 120, moves: 80 }, ...overrides };
}
function validStatsPayload() {
  return { draw1: validModeStats(), draw3: validModeStats({ plays: 5, wins: 1 }) };
}

// Pure-logic tests only, same split as stats.test.js/victory.test.js/
// game-logic.test.js - buildBackup/validateBackup never touch localStorage
// or the DOM, so the full schema/validation/migration surface is testable
// here without a browser.

const SAMPLE_FIELDS = {
  faceDesign: 'regular',
  cardStyle: 'worn',
  cardBack: 'parlor_red',
  drawCount: '3',
  stats: {
    draw1: { plays: 0, wins: 0, fastestTimeSeconds: null, fewestMoves: null, lastWin: null },
    draw3: { plays: 12, wins: 3, fastestTimeSeconds: 145, fewestMoves: 98, lastWin: { timeSeconds: 145, moves: 98 } },
  },
};

test('buildBackup: produces the documented envelope shape', () => {
  const backup = buildBackup(SAMPLE_FIELDS);
  assert.equal(backup.app, BACKUP_APP_ID);
  assert.equal(backup.backupVersion, CURRENT_BACKUP_VERSION);
  assert.equal(typeof backup.createdAt, 'string');
  assert.ok(!Number.isNaN(Date.parse(backup.createdAt)));
  assert.deepEqual(backup.data, SAMPLE_FIELDS);
});

test('validateBackup: a freshly built backup round-trips as valid', () => {
  const backup = buildBackup(SAMPLE_FIELDS);
  const result = validateBackup(backup);
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, SAMPLE_FIELDS);
});

test('validateBackup: rejects non-object / unparseable-shaped input', () => {
  for (const bad of [null, undefined, 'a string', 42, []]) {
    const result = validateBackup(bad);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not-an-object');
  }
});

test('validateBackup: rejects a foreign JSON document (wrong or missing app id)', () => {
  const foreign = { hello: 'world', backupVersion: 1, data: {} };
  const result = validateBackup(foreign);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'wrong-app');
});

test('validateBackup: rejects a backup claiming a different app', () => {
  const result = validateBackup({ app: 'some-other-game', backupVersion: 1, data: {} });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'wrong-app');
});

test('validateBackup: rejects missing/malformed backupVersion', () => {
  for (const backupVersion of [undefined, 'v1', 1.5, 0, -1]) {
    const result = validateBackup({ app: BACKUP_APP_ID, backupVersion, data: {} });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'missing-version');
  }
});

test('validateBackup: rejects a backupVersion newer than this code understands', () => {
  const result = validateBackup({ app: BACKUP_APP_ID, backupVersion: CURRENT_BACKUP_VERSION + 1, data: {} });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unsupported-version');
});

test('validateBackup: rejects missing/malformed data payload', () => {
  for (const data of [undefined, null, 'garbage', 42, []]) {
    const result = validateBackup({ app: BACKUP_APP_ID, backupVersion: 1, data });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'missing-data');
  }
});

test('validateBackup: an empty but well-formed data object is still valid (individual field sanitization is the caller\'s job)', () => {
  const result = validateBackup({ app: BACKUP_APP_ID, backupVersion: 1, data: {} });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, {});
});

test('backupFilename: YYYY-MM-DD, zero-padded', () => {
  assert.equal(backupFilename(new Date(2026, 0, 5)), 'mikes-solitaire-backup-2026-01-05.json');
  assert.equal(backupFilename(new Date(2026, 8, 1)), 'mikes-solitaire-backup-2026-09-01.json');
  assert.equal(backupFilename(new Date(2026, 11, 31)), 'mikes-solitaire-backup-2026-12-31.json');
});

// ---------- isValidStatsPayload ----------

test('isValidStatsPayload: undefined (stats not included in the backup at all) is valid', () => {
  assert.equal(isValidStatsPayload(undefined), true);
});

test('isValidStatsPayload: null is valid, not corrupted - a never-played device\'s own self-generated backup legitimately has stats: null (getPreference(\'stats\', null) in script.js\'s currentBackupFields)', () => {
  assert.equal(isValidStatsPayload(null), true);
});

test('isValidStatsPayload: a complete, well-formed payload is valid', () => {
  assert.equal(isValidStatsPayload(validStatsPayload()), true);
});

test('isValidStatsPayload: rejects non-object shapes (null is its own separate valid case - see the dedicated test above)', () => {
  for (const bad of ['garbage', 42, [], true]) {
    assert.equal(isValidStatsPayload(bad), false);
  }
});

test('isValidStatsPayload: rejects a payload missing either mode entirely', () => {
  assert.equal(isValidStatsPayload({ draw1: validModeStats() }), false); // no draw3
  assert.equal(isValidStatsPayload({ draw3: validModeStats() }), false); // no draw1
});

test('isValidStatsPayload: rejects wrong-typed plays/wins (the exact "sneaks through" case)', () => {
  const payload = validStatsPayload();
  payload.draw1.plays = 'not a number';
  assert.equal(isValidStatsPayload(payload), false);
});

test('isValidStatsPayload: rejects negative or non-integer numeric fields', () => {
  for (const bad of [-1, 1.5, NaN, Infinity]) {
    const payload = validStatsPayload();
    payload.draw3.fewestMoves = bad;
    assert.equal(isValidStatsPayload(payload), false, `fewestMoves=${bad} should be rejected`);
  }
});

test('isValidStatsPayload: null is a legitimate "no record yet" value for fastestTimeSeconds/fewestMoves/lastWin', () => {
  const payload = { draw1: validModeStats({ fastestTimeSeconds: null, fewestMoves: null, lastWin: null }), draw3: validModeStats() };
  assert.equal(isValidStatsPayload(payload), true);
});

test('isValidStatsPayload: rejects a malformed nested lastWin', () => {
  const payload = validStatsPayload();
  payload.draw1.lastWin = { timeSeconds: 'not a number', moves: 80 };
  assert.equal(isValidStatsPayload(payload), false);
});

test('isValidStatsPayload: rejects lastWin as a non-object (e.g. a stray string)', () => {
  const payload = validStatsPayload();
  payload.draw3.lastWin = 'garbage';
  assert.equal(isValidStatsPayload(payload), false);
});

// ---------- resolveRestorePatch ----------

test('resolveRestorePatch: a fully valid payload resolves every field', () => {
  const data = { faceDesign: 'simple', cardStyle: 'clean', cardBack: 'parlor_red', drawCount: '1', stats: validStatsPayload() };
  const result = resolveRestorePatch(data, REGISTRIES);
  assert.equal(result.ok, true);
  assert.deepEqual(result.patch, data);
});

// ---------- faceDesign (Card Faces) ----------

test('resolveRestorePatch: resolves a valid faceDesign', () => {
  const result = resolveRestorePatch({ faceDesign: 'simple' }, REGISTRIES);
  assert.equal(result.ok, true);
  assert.deepEqual(result.patch, { faceDesign: 'simple' });
});

test('resolveRestorePatch: rejects the whole restore for an unrecognized faceDesign, with no partial patch', () => {
  const result = resolveRestorePatch({ faceDesign: 'ultra-deluxe-design', cardStyle: 'worn' }, REGISTRIES);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid-faceDesign');
  assert.equal(result.patch, undefined);
});

test('resolveRestorePatch: rejects a non-string faceDesign', () => {
  for (const bad of [42, null, {}, []]) {
    const result = resolveRestorePatch({ faceDesign: bad }, REGISTRIES);
    assert.equal(result.ok, false, `faceDesign=${JSON.stringify(bad)} should be rejected`);
    assert.equal(result.reason, 'invalid-faceDesign');
  }
});

test('resolveRestorePatch: backward compatibility - a backup predating Card Faces (no faceDesign key at all) restores everything else fine, with faceDesign simply absent from the patch (not defaulted, not rejected)', () => {
  // Mirrors a real pre-Card-Faces backup file: buildBackup() from that era
  // never included a faceDesign key in the first place.
  const preCardFacesData = { cardStyle: 'clean', cardBack: 'parlor_red', drawCount: '1', stats: validStatsPayload() };
  const result = resolveRestorePatch(preCardFacesData, REGISTRIES);
  assert.equal(result.ok, true);
  assert.equal('faceDesign' in result.patch, false);
  assert.deepEqual(result.patch, preCardFacesData);
  // The device's own getPreference('faceDesign', DEFAULT_FACE_DESIGN) fallback
  // (script.js) is what resolves the now-untouched preference to 'regular' -
  // resolveRestorePatch itself never writes a default value.
});

test('resolveRestorePatch: an empty data object resolves to an empty (no-op) patch, not a failure', () => {
  const result = resolveRestorePatch({}, REGISTRIES);
  assert.equal(result.ok, true);
  assert.deepEqual(result.patch, {});
});

test('resolveRestorePatch: stats: null (a never-played device\'s own legitimate self-generated backup) resolves fine and is omitted from the patch, never written as null', () => {
  const result = resolveRestorePatch({ cardStyle: 'worn', stats: null }, REGISTRIES);
  assert.equal(result.ok, true);
  assert.deepEqual(result.patch, { cardStyle: 'worn' });
  assert.equal('stats' in result.patch, false);
});

test('resolveRestorePatch: a field simply absent from data is omitted from the patch, not treated as invalid', () => {
  const result = resolveRestorePatch({ cardStyle: 'worn' }, REGISTRIES);
  assert.equal(result.ok, true);
  assert.deepEqual(result.patch, { cardStyle: 'worn' });
});

test('resolveRestorePatch: rejects the whole restore for an unrecognized cardStyle', () => {
  const result = resolveRestorePatch({ cardStyle: 'ultra-deluxe-collection' }, REGISTRIES);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid-cardStyle');
  assert.equal(result.patch, undefined);
});

test('resolveRestorePatch: rejects a retired cardBack id with no known mapping (green/purple/rabbit)', () => {
  for (const retired of ['green', 'purple', 'rabbit']) {
    const result = resolveRestorePatch({ cardBack: retired }, REGISTRIES);
    assert.equal(result.ok, false, `${retired} should be rejected`);
    assert.equal(result.reason, 'invalid-cardBack');
  }
});

test('resolveRestorePatch: migrates a known retired cardBack id (flowers -> flower) rather than rejecting or passing it through unmigrated', () => {
  assert.equal(LEGACY_CARD_BACK_IDS.flowers, 'flower');
  const result = resolveRestorePatch({ cardBack: 'flowers' }, REGISTRIES);
  assert.equal(result.ok, true);
  assert.equal(result.patch.cardBack, 'flower');
});

test('resolveRestorePatch: rejects an unrecognized drawCount', () => {
  for (const bad of ['2', 1, 3, 'three', null]) {
    const result = resolveRestorePatch({ drawCount: bad }, REGISTRIES);
    assert.equal(result.ok, false, `drawCount=${JSON.stringify(bad)} should be rejected`);
    assert.equal(result.reason, 'invalid-drawCount');
  }
});

test('resolveRestorePatch: rejects malformed stats', () => {
  const result = resolveRestorePatch({ stats: { draw1: validModeStats({ plays: 'nope' }), draw3: validModeStats() } }, REGISTRIES);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid-stats');
});

test('resolveRestorePatch: NO PARTIAL RESTORE - three perfectly valid fields plus one invalid field rejects the entire patch, not just the bad field', () => {
  const data = {
    cardStyle: 'worn',       // valid
    cardBack: 'lovebirds',   // valid
    drawCount: '3',          // valid
    stats: { draw1: validModeStats({ wins: -5 }), draw3: validModeStats() }, // invalid (negative wins)
  };
  const result = resolveRestorePatch(data, REGISTRIES);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid-stats');
  // The critical assertion: no patch object is exposed at all when validation
  // fails, so there is no way for a caller to accidentally apply the three
  // valid fields while silently dropping the invalid one.
  assert.equal(result.patch, undefined);
});

test('resolveRestorePatch: NO PARTIAL RESTORE - an invalid FIRST field still rejects fields checked after it', () => {
  const data = {
    cardStyle: 'not-a-real-collection', // invalid - checked first
    cardBack: 'lovebirds',              // otherwise valid
    drawCount: '1',                     // otherwise valid
    stats: validStatsPayload(),         // otherwise valid
  };
  const result = resolveRestorePatch(data, REGISTRIES);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid-cardStyle');
  assert.equal(result.patch, undefined);
});

test('resolveRestorePatch: rejects non-object data', () => {
  for (const bad of [null, 'garbage', 42, []]) {
    const result = resolveRestorePatch(bad, REGISTRIES);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid-data');
  }
});

test('resolveRestorePatch: end-to-end with validateBackup - a backup with one bad field is fully rejected by the combined pipeline', () => {
  const backup = buildBackup({ cardStyle: 'worn', cardBack: 'rabbit', drawCount: '3', stats: validStatsPayload() });
  const envelope = validateBackup(backup);
  assert.equal(envelope.ok, true); // envelope itself is structurally fine
  const resolved = resolveRestorePatch(envelope.data, REGISTRIES);
  assert.equal(resolved.ok, false); // but the payload fails on the retired cardBack id
  assert.equal(resolved.reason, 'invalid-cardBack');
});
