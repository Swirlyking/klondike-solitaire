// Solitaire's adapter for privacy-minimal usage metrics (mike-games-metrics standard).
// mike-metrics.js is the family's canonical helper, copied verbatim - never edit it here.
// This file only decides where events go; script.js calls the helper at three seams:
//   newGame()     - a new instance (deal) and its mode, snapshotted at deal time
//   pushHistory() - the first meaningful action: the first committed move of a deal
//   checkWin()    - the declared, credited win (never Force Win)
// script.js loads this file with a dynamic import, so a missing or failing file can never break
// boot or play (METRICS-10).
import { createMetrics, checkEligibility } from './mike-metrics.js';

export const COLLECTOR = 'https://metrics.mikesgames.app/e';
export const ELIGIBILITY = 'https://metrics.mikesgames.app/eligibility';
export const PRODUCTION_HOSTS = ['solitaire.mikesgames.app', 'solitaire.mikestrassburger.com'];
const LOCAL_HOSTS = ['localhost', '127.0.0.1'];

// Production sends to the collector. Local development only logs to the console, unless
// ?metrics=test routes it to the collector (stored as test). Any other host (deploy previews,
// LAN addresses) sends nothing unless ?metrics=test is present.
export function routeFor(hostname, search) {
  let testRequested = false;
  try { testRequested = new URLSearchParams(search).get('metrics') === 'test'; } catch { /* no routing */ }
  if (PRODUCTION_HOSTS.includes(hostname)) return { endpoint: COLLECTOR, log: false };
  if (testRequested) return { endpoint: COLLECTOR, log: false };
  if (LOCAL_HOSTS.includes(hostname)) return { endpoint: null, log: true };
  return { endpoint: null, log: false };
}

// Resolves to the metrics helper, or null. Wherever events would reach the collector, the helper is
// created only after the collector confirms this request is eligible (METRICS-16: United States
// only); until then, and whenever the answer is no or the check fails, there is no helper, so no
// installation ID is created or read and nothing is sent. The answer lives in memory only. Local
// development (console log only, nothing sent) skips the check.
export async function initSolitaireMetrics({ hostname, search, appVersion, check = checkEligibility, create = createMetrics, logger = console }) {
  const route = routeFor(hostname, search);
  if (route.endpoint) {
    const eligible = await check(ELIGIBILITY);
    if (!eligible) return null;
  } else if (!route.log) {
    return null;
  }
  return createSolitaireMetrics({ hostname, search, appVersion, create, logger });
}

export function createSolitaireMetrics({ hostname, search, appVersion, create = createMetrics, logger = console }) {
  const route = routeFor(hostname, search);
  return create({
    game: 'solitaire',
    appVersion,
    endpoint: route.endpoint,
    log: route.log ? (payload) => logger.debug('[metrics]', payload) : null,
  });
}
