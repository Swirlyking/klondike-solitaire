// mike-metrics.js — Mike's Games privacy-minimal usage metrics client, schema v1.
//
// Canonical copy: mike-games-metrics/client/mike-metrics.js. Games copy this file verbatim;
// everything game-specific lives in the game's own adapter (METRICS-13).
//
// Two events only (game_started, game_completed). The payload is exactly v, event, game,
// install_id and, where the game has them, mode, difficulty and app_version (METRICS-2).
// install_id is one random installation ID per game installation, created on first use and kept
// in this game's own local storage; it is never derived from the device, never shared between
// games and never accompanied by a session identifier (METRICS-3). No timestamps, retries or UI
// (METRICS-10). Every event function is synchronous, returns nothing and cannot throw.
//
// Eligibility (METRICS-16): before creating the helper, an adapter asks the collector whether this
// request is eligible (currently: United States only) with checkEligibility(). The answer is kept
// in page memory only. An ineligible or failed check means the adapter never creates the helper,
// so no installation ID is created or read and nothing is sent.

export const SCHEMA_VERSION = 1;
export const TOKEN = /^[a-z][a-z0-9_]{0,23}$/;
export const APP_VERSION = /^[A-Za-z0-9][A-Za-z0-9 ._()+-]{0,31}$/;
export const INSTALL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function installIdKey(game) {
  return `mike-metrics:install-id:${game}`;
}

// A random version-4 UUID from the platform's cryptographic generator, or null.
export function randomInstallId(cryptoObj = globalThis.crypto) {
  try {
    if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
      const id = cryptoObj.randomUUID();
      if (INSTALL_ID.test(id)) return id;
    }
    if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
      const b = cryptoObj.getRandomValues(new Uint8Array(16));
      b[6] = (b[6] & 0x0f) | 0x40;
      b[8] = (b[8] & 0x3f) | 0x80;
      const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    }
  } catch { /* no generator */ }
  return null;
}

// The stored installation ID, created and stored on first use. Returns null when storage is
// unavailable or refuses the write: then events are sent without an ID, never with a
// throwaway one (a new ID per page load would act as a session identifier).
export function loadInstallId(game, storage, cryptoObj) {
  try {
    if (!storage) return null;
    const key = installIdKey(game);
    const existing = storage.getItem(key);
    if (typeof existing === 'string' && INSTALL_ID.test(existing)) return existing;
    const id = randomInstallId(cryptoObj);
    if (!id) return null;
    storage.setItem(key, id);
    return storage.getItem(key) === id ? id : null;
  } catch {
    return null;
  }
}

// Build the exact wire payload, or null if anything is invalid (the whole event is dropped).
export function buildPayload(event, game, ctx, appVersion, installId) {
  if (event !== 'game_started' && event !== 'game_completed') return null;
  if (typeof game !== 'string' || !TOKEN.test(game)) return null;
  const body = { v: SCHEMA_VERSION, event, game };
  if (typeof installId === 'string' && INSTALL_ID.test(installId)) body.install_id = installId;
  if (ctx && ctx.mode !== undefined) {
    if (typeof ctx.mode !== 'string' || !TOKEN.test(ctx.mode)) return null;
    body.mode = ctx.mode;
  }
  if (ctx && ctx.difficulty !== undefined) {
    if (typeof ctx.difficulty !== 'string' || !TOKEN.test(ctx.difficulty)) return null;
    body.difficulty = ctx.difficulty;
  }
  if (typeof appVersion === 'string' && APP_VERSION.test(appVersion)) body.app_version = appVersion;
  return body;
}

// Asks the collector's eligibility endpoint. Resolves true only for an explicit
// {"enabled":true}; any error, timeout, non-OK response or other body resolves false (fail
// closed). Never rejects, never stores the answer, sends no cookies or referrer.
export function checkEligibility(url, { fetchImpl = globalThis.fetch, timeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };
    try {
      if (!url || typeof fetchImpl !== 'function') { done(false); return; }
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = setTimeout(() => { try { controller?.abort(); } catch { /* ignore */ } done(false); }, timeoutMs);
      Promise.resolve(fetchImpl(url, {
        method: 'GET',
        mode: 'cors',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
        signal: controller?.signal,
      }))
        .then(res => (res && res.ok ? res.json() : null))
        .then(body => { clearTimeout(timer); done(!!body && body.enabled === true); })
        .catch(() => { clearTimeout(timer); done(false); });
    } catch {
      done(false);
    }
  });
}

function defaultStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

// game: the family token. appVersion: the value Settings shows. endpoint: collector URL, or
// null/'' to send nothing. send(url, bodyString): injectable for tests; defaults to a
// fire-and-forget fetch. log(payload): optional local-development log instead of sending.
// storage / cryptoObj: injectable for tests; default to localStorage and crypto.
export function createMetrics({ game, appVersion, endpoint, send = post, log = null,
  storage = defaultStorage(), cryptoObj = globalThis.crypto } = {}) {
  const startedCtx = new Map(); // instanceKey -> ctx; this page only; keys are never sent
  const completedKeys = new Set();
  let installId; // undefined until first use; then the stored ID or null

  function emit(event, ctx) {
    try {
      if (!log && !endpoint) return;
      if (installId === undefined) installId = loadInstallId(game, storage, cryptoObj);
      const body = buildPayload(event, game, ctx, appVersion, installId);
      if (!body) return;
      if (log) { log(body); return; }
      send(endpoint, JSON.stringify(body));
    } catch { /* never the player's problem */ }
  }

  return {
    // First meaningful action in a new instance. Repeated calls for one instance send once.
    started(key, ctx = {}) {
      try {
        if (startedCtx.has(key)) return;
        startedCtx.set(key, { mode: ctx.mode, difficulty: ctx.difficulty });
        emit('game_started', startedCtx.get(key));
      } catch { /* never the player's problem */ }
    },
    // A restored instance that was already started: remember it, send nothing (METRICS-7).
    resumed(key, ctx = {}) {
      try {
        if (!startedCtx.has(key)) startedCtx.set(key, { mode: ctx.mode, difficulty: ctx.difficulty });
      } catch { /* never the player's problem */ }
    },
    // The game declared and credited a win. Sends once per instance, with the start's context.
    completed(key, ctx = {}) {
      try {
        if (completedKeys.has(key)) return;
        completedKeys.add(key);
        emit('game_completed', startedCtx.get(key) ?? { mode: ctx.mode, difficulty: ctx.difficulty });
      } catch { /* never the player's problem */ }
    },
  };
}

function post(url, body) {
  try {
    const p = fetch(url, {
      method: 'POST',
      body,
      keepalive: true,
      mode: 'no-cors',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      headers: { 'Content-Type': 'text/plain' },
    });
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch { /* fetch missing or blocked */ }
}
