// Tiny localStorage-backed key/value store for user preferences (card
// back color, and whatever gets added later - table surface, card face
// style, etc.). Deliberately schema-free: this module doesn't know what
// keys exist or what their valid values are - that's the settings
// panel's own config (see PREFERENCE_SECTIONS in script.js). Keeping
// this generic means adding a new preference never requires touching
// this file.

const STORAGE_KEY = 'klondike-preferences';

function readAll() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writeAll(prefs) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Private browsing, storage disabled/full, etc. - preferences just
    // won't persist across reloads; not worth surfacing an error for.
  }
}

export function getPreference(key, fallback) {
  const prefs = readAll();
  return key in prefs ? prefs[key] : fallback;
}

export function setPreference(key, value) {
  const prefs = readAll();
  prefs[key] = value;
  writeAll(prefs);
}

// Merges several keys into the store in one read-modify-write cycle,
// rather than one setPreference() call per key (each of which re-reads
// and re-writes the whole blob) - used by backup restore, which wants its
// several allowlisted fields to land together rather than as a sequence
// of separate writes.
export function setPreferences(partial) {
  const prefs = readAll();
  Object.assign(prefs, partial);
  writeAll(prefs);
}
