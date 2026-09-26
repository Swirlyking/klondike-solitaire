// Solitaire's adapter for Anonymous Game Metrics (mike-games-system, anonymous game metrics
// standard). mike-metrics.js is the family's canonical helper, copied verbatim - never edit it
// here. This file only decides where events go; script.js calls the helper at three seams:
//   newGame()     - a new instance (deal) and its mode, snapshotted at deal time
//   pushHistory() - the first meaningful action: the first committed move of a deal
//   checkWin()    - the declared, credited win (never Force Win)
// script.js loads this file with a dynamic import, so a missing or failing file can never break
// boot or play (METRICS-10).
import { createMetrics } from './mike-metrics.js';

export const COLLECTOR = 'https://metrics.mikesgames.app/e';
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

export function createSolitaireMetrics({ hostname, search, appVersion, create = createMetrics, logger = console }) {
  const route = routeFor(hostname, search);
  return create({
    game: 'solitaire',
    appVersion,
    endpoint: route.endpoint,
    log: route.log ? (payload) => logger.debug('[metrics]', payload) : null,
  });
}
