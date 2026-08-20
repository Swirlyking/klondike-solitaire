// Sound effects are intentionally DORMANT for now - this module is not
// imported anywhere in the app (script.js has no `import ... from
// './sfx.js'`), so none of this runs during normal play: no AudioContext
// is created, no audio files are requested, nothing plays. It's kept as a
// clean foundation for when SFX gets revisited - the category naming,
// sample-selection/jitter logic, and buffer decode/cache scaffolding below
// are self-contained and still valid; only the actual gameplay wiring
// (script.js call sites) and the Settings preference were removed.
//
// Hard-won notes for whoever re-implements the iOS unlock step, so that
// work doesn't need to be rediscovered from scratch:
// - iOS Safari's AudioContext.resume() can hang forever (never resolves,
//   never rejects) when triggered from pointerdown/touchstart, even though
//   the event reports isTrusted: true - it needs to be triggered from
//   pointerup/touchend/click (gesture *completion*, not gesture *start*)
//   to reliably work. Desktop Safari (mouse pointerdown) never had this
//   problem; only real iOS devices (confirmed on both iPad and iPhone) did.
// - resume() alone was still not reliable even on pointerup - synchronously
//   creating and starting an actual AudioBufferSourceNode in the same
//   gesture was the extra step that made it stick. A truly silent
//   (zero-amplitude) buffer for that unlock source was NOT reliable either;
//   a tiny, smoothly-shaped, very-low-amplitude sine arch (non-zero real
//   sample data, shaped to start/end at zero so there's no click) worked.
// - Confirmed NOT the cause, if this regresses again: insecure origin/HTTP
//   vs HTTPS (tested both, identical failure), the debugger being attached,
//   Lockdown Mode, and device-wide audio being broken (other Safari media
//   played fine throughout).

import { getPreference, setPreference } from './preferences.js';

const ENABLED_KEY = 'soundEffects';

// Two samples per category - playSound picks one at random each time so
// repeated actions (a long Auto Finish run especially) don't all sound
// identical.
const SOUND_FILES = {
  cardFlip: ['assets/sfx/card-flip.wav', 'assets/sfx/card-flip2.wav'],
  cardPlace: ['assets/sfx/card-place.wav', 'assets/sfx/card-place2.wav'],
  stackMove: ['assets/sfx/stack-move.wav', 'assets/sfx/stack-move2.wav'],
  stockDraw: ['assets/sfx/stock-draw.wav', 'assets/sfx/stock-draw2.wav'],
};
const ALL_URLS = Object.values(SOUND_FILES).flat();

// Deliberately subtle - enough that repetition doesn't read as mechanical,
// never enough to notice as the sound actually pitch-shifting or changing
// volume.
const RATE_JITTER = 0.025; // playback rate: ±2.5%
const GAIN_JITTER = 0.045; // volume: ±4.5%

export function isSoundEffectsEnabled() {
  return getPreference(ENABLED_KEY, 'on') === 'on';
}

export function setSoundEffectsEnabled(enabled) {
  setPreference(ENABLED_KEY, enabled ? 'on' : 'off');
}

let audioCtx = null;
const buffers = new Map(); // url -> decoded AudioBuffer
const decodePromises = new Map(); // url -> in-flight decode, so a slow decode is never started twice

function getContext() {
  if (audioCtx) return audioCtx;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  try {
    audioCtx = new Ctor();
  } catch {
    audioCtx = null;
  }
  return audioCtx;
}

// Fetching/decoding never needs the context to be running (only playback
// does), so this can - and does - start well before the first real user
// gesture unlocks sound.
function decodeUrl(ctx, url) {
  if (buffers.has(url)) return;
  if (decodePromises.has(url)) return;
  const p = fetch(url)
    .then(res => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.arrayBuffer();
    })
    .then(data => ctx.decodeAudioData(data))
    .then(buf => { buffers.set(url, buf); })
    .catch(() => {}); // a failed fetch/decode just means this one sample silently never plays
  decodePromises.set(url, p);
}

function preloadAll(ctx) {
  ALL_URLS.forEach(url => decodeUrl(ctx, url));
}

function pick(urls) {
  return urls[Math.random() < 0.5 ? 0 : 1];
}

// Fire-and-forget: never throws, never delays or blocks the caller. If
// sound is off, the context isn't unlocked yet, or a buffer hasn't
// finished decoding, this just silently does nothing rather than waiting -
// gameplay must never depend on audio being ready. Dormant in practice
// since nothing currently calls getContext()/preloadAll() (that lived in
// the removed unlock() step) - audioCtx stays null, so this is always a
// no-op until unlock is re-implemented.
export function playSound(category) {
  try {
    if (!isSoundEffectsEnabled()) return;
    const ctx = audioCtx;
    if (!ctx || ctx.state !== 'running') return;
    const urls = SOUND_FILES[category];
    if (!urls) return;
    const buffer = buffers.get(pick(urls));
    if (!buffer) return; // still decoding, or failed to load - skip this one play
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = 1 + (Math.random() * 2 - 1) * RATE_JITTER;
    const gain = ctx.createGain();
    gain.gain.value = 1 + (Math.random() * 2 - 1) * GAIN_JITTER;
    source.connect(gain).connect(ctx.destination);
    source.start();
  } catch {
    // Audio failure must never interfere with gameplay.
  }
}
