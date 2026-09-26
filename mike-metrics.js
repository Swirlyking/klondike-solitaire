// mike-metrics.js — Mike's Games anonymous game metrics client, schema v1.
//
// Canonical copy: mike-games-metrics/client/mike-metrics.js. Games copy this file verbatim;
// everything game-specific lives in the game's own adapter (METRICS-13).
//
// Two events only (game_started, game_completed). The payload is exactly v, event, game and,
// where the game has them, mode, difficulty and app_version (METRICS-2). No identifiers, no
// timestamps, no storage, no retries, no UI (METRICS-3, METRICS-10). Every function is
// synchronous, returns nothing and cannot throw.

export const SCHEMA_VERSION = 1;
export const TOKEN = /^[a-z][a-z0-9_]{0,23}$/;
export const APP_VERSION = /^[A-Za-z0-9][A-Za-z0-9 ._()+-]{0,31}$/;

// Build the exact wire payload, or null if anything is invalid (the whole event is dropped).
export function buildPayload(event, game, ctx, appVersion) {
  if (event !== 'game_started' && event !== 'game_completed') return null;
  if (typeof game !== 'string' || !TOKEN.test(game)) return null;
  const body = { v: SCHEMA_VERSION, event, game };
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

// game: the family token. appVersion: the value Settings shows. endpoint: collector URL, or
// null/'' to send nothing. send(url, bodyString): injectable for tests; defaults to a
// fire-and-forget fetch. log(payload): optional local-development log instead of sending.
export function createMetrics({ game, appVersion, endpoint, send = post, log = null } = {}) {
  const startedCtx = new Map(); // instanceKey -> ctx; this page only; keys are never sent
  const completedKeys = new Set();

  function emit(event, ctx) {
    try {
      const body = buildPayload(event, game, ctx, appVersion);
      if (!body) return;
      if (log) { log(body); return; }
      if (!endpoint) return;
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
