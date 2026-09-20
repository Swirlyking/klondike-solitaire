// Runtime card-face compositing. A face design no longer ships as 52
// separately pre-baked "clean" + 52 pre-baked "worn" images - instead each
// design contributes one set of 52 transparent face PNGs (just the
// printed artwork, no card body), and every design shares the same small
// set of background layers (6 dirty card bodies + 1 clean/white one) that
// this module draws underneath at render time. This is what lets a third
// design (or a fourth, a fifth...) cost 52 small transparent PNGs instead
// of ~120MB of pre-baked clean+worn art per design (see the worn/simple
// asset folders this replaces).
//
// Two caches, deliberately different lifetimes:
//  - The LAYER cache (module-level singletons below) holds the decoded
//    source images - background layers once for the whole session, each
//    design's transparent faces once per design, lazily, the first time
//    that design is actually used. None of this ever changes mid-session,
//    so none of it is ever invalidated.
//  - The composite-RESULT cache (compositeCache) holds the actual drawn
//    output per design+condition+card. This IS invalidated - see
//    beginNewGameVariants - because the Worn condition's per-card dirty-
//    background+transform assignment is re-randomized every new game, so
//    a result cached under last game's assignment would be wrong. Clean
//    results never actually change game to game, but clearing them too on
//    every new game costs nothing (a cheap synchronous recomposite on next
//    demand) and keeps this cache's lifetime rule a single, simple one.

// ---------- pure: per-game variant assignment (unit-tested) ----------

export const DIRTY_BACKGROUND_COUNT = 6;

// Only 4 distinct looks, not 5: flipping a rectangle on both axes
// (flipX+flipY) is pixel-identical to rotating it 180 degrees, so a fifth
// "rotate180" entry would just be a duplicate of the fourth one here, not
// a genuinely new appearance.
export const TRANSFORM_VARIANTS = [
  { flipX: false, flipY: false },
  { flipX: true, flipY: false },
  { flipX: false, flipY: true },
  { flipX: true, flipY: true },
];

// Assigns one dirty-background index + transform to every given card key.
// randomInt is injected (never imported directly from shuffle.js in here)
// so this stays a pure function: a caller can hand it a fake, deterministic
// sequence in a test instead of real randomness, and this module never
// needs to know crypto exists. Call exactly once per fresh deal (see
// beginNewGameVariants below) - calling it more often than that is the one
// way to break "stable for the whole game."
export function assignFaceVariants(cardKeys, randomInt) {
  const assignments = {};
  for (const key of cardKeys) {
    const dirtyIndex = randomInt(DIRTY_BACKGROUND_COUNT);
    const transform = TRANSFORM_VARIANTS[randomInt(TRANSFORM_VARIANTS.length)];
    assignments[key] = { dirtyIndex, flipX: transform.flipX, flipY: transform.flipY };
  }
  return assignments;
}

const DEFAULT_VARIANT = { dirtyIndex: 0, flipX: false, flipY: false };

// ---------- impure: asset locations ----------
// Shared across every design - only the transparent face art below is
// design-specific.
const DIRTY_BASE = 'assets/cards/DIRTYS';
const WHITE_BG_SRC = 'assets/cards/WHITE.jpg';

function dirtyBackgroundSrc(index, version) {
  return `${DIRTY_BASE}/Card-Dirt-${index + 1}_700x1015.png?v=${version}`;
}

// design: { facesBase, suffix } - see CARD_FACE_DESIGNS in script.js.
// cardId: { key, suitFile, rankFile } - see faceCardId in script.js.
function faceArtSrc(design, cardId, version) {
  return `${encodeURI(design.facesBase)}/${cardId.suitFile}_${cardId.rankFile}_${design.suffix}.png?v=${version}`;
}

function placeholderSrc(condition, version) {
  // Shown only in the brief window before a design's source layers have
  // finished loading (see getComposedFaceSrc) - a real, valid, on-disk
  // image (no compositing needed), never a broken or blank src. Every
  // caller that actually needs the true composite ready in hand awaits
  // ensureFacesReady/ensureFacesReadyStrict first (see script.js's
  // critical-asset gate and Settings-switch handlers), so in practice this
  // is only ever visible behind the startup intro overlay, if at all.
  return condition === 'clean' ? `${WHITE_BG_SRC}?v=${version}` : dirtyBackgroundSrc(0, version);
}

// ---------- impure: image loading ----------

// decode()-awaited, rejecting on a genuine load/decode failure - same
// shape as script.js's own decodeAwaitedImage, for the same reason: the
// strict/non-strict split below needs a real rejection to build on.
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.src = src;
    if (img.decode) {
      img.decode().then(() => resolve(img), reject);
    } else {
      img.onload = () => resolve(img);
      img.onerror = reject;
    }
  });
}

// getComposedFaceSrc's placeholder fallback (below) only ever self-heals
// on its OWN next call for that same card - nothing else naturally calls
// it again for a card nobody's interacting with (e.g. one still buried in
// the stock when a design switch warms only the visible board). These
// listeners are the general fix: notified once, every time a background
// layer or a face image finishes loading for the first time, regardless
// of what triggered that load (self-heal, the critical gate, a Settings
// switch, or background warming). script.js's one registered listener
// re-renders, which is what actually swaps a placeholder <img> for the
// real composite once it exists - see onAssetReady.
const readyListeners = [];

export function onAssetReady(callback) {
  readyListeners.push(callback);
}

function notifyAssetReady() {
  readyListeners.forEach(cb => cb());
}

let backgroundLayers = null; // { white, dirties[6] } once resolved - session-lifetime, never cleared
let backgroundLayersLoading = null;

function ensureBackgroundLayers(version) {
  if (backgroundLayers) return Promise.resolve(backgroundLayers);
  if (!backgroundLayersLoading) {
    backgroundLayersLoading = Promise.all([
      loadImage(`${WHITE_BG_SRC}?v=${version}`),
      ...Array.from({ length: DIRTY_BACKGROUND_COUNT }, (_, i) => loadImage(dirtyBackgroundSrc(i, version))),
    ]).then(([white, ...dirties]) => {
      backgroundLayers = { white, dirties };
      backgroundLayersLoading = null;
      notifyAssetReady();
      return backgroundLayers;
    }, err => {
      backgroundLayersLoading = null;
      throw err;
    });
  }
  return backgroundLayersLoading;
}

const faceImageCache = new Map(); // "facesBase|suitFile_rankFile" -> resolved HTMLImageElement
const faceImageLoading = new Map(); // same key -> in-flight Promise, for dedup only

function faceImageKey(design, cardId) {
  return `${design.facesBase}|${cardId.suitFile}_${cardId.rankFile}`;
}

function ensureFaceImage(design, cardId, version) {
  const key = faceImageKey(design, cardId);
  if (faceImageCache.has(key)) return Promise.resolve(faceImageCache.get(key));
  if (!faceImageLoading.has(key)) {
    const promise = loadImage(faceArtSrc(design, cardId, version)).then(img => {
      faceImageCache.set(key, img);
      faceImageLoading.delete(key);
      notifyAssetReady();
      return img;
    }, err => {
      faceImageLoading.delete(key);
      throw err;
    });
    faceImageLoading.set(key, promise);
  }
  return faceImageLoading.get(key);
}

// ---------- impure: compositing + per-game state ----------

let currentVariants = {}; // cardId.key -> { dirtyIndex, flipX, flipY } - see beginNewGameVariants
const compositeCache = new Map(); // "facesBase:condition:cardKey" -> data URL, cleared per new game

// cardKeys: plain strings, exactly what cardId.key will be for each card
// this game (see faceCardId in script.js) - assignFaceVariants doesn't
// need the full card shape, just something stable to key by.
export function beginNewGameVariants(cardKeys, randomInt) {
  currentVariants = assignFaceVariants(cardKeys, randomInt);
  compositeCache.clear();
}

function drawComposite(design, cardId, condition, size, layers, faceImg) {
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext('2d');
  if (condition === 'clean') {
    ctx.drawImage(layers.white, 0, 0, size.width, size.height);
  } else {
    const variant = currentVariants[cardId.key] || DEFAULT_VARIANT;
    const dirty = layers.dirties[variant.dirtyIndex];
    // The transform applies to the dirty background only - ctx.save/
    // restore fences it off so the face art drawn right after is always
    // upright, never flipped along with it.
    ctx.save();
    if (variant.flipX) { ctx.translate(size.width, 0); ctx.scale(-1, 1); }
    if (variant.flipY) { ctx.translate(0, size.height); ctx.scale(1, -1); }
    ctx.drawImage(dirty, 0, 0, size.width, size.height);
    ctx.restore();
  }
  ctx.drawImage(faceImg, 0, 0, size.width, size.height);
  return canvas.toDataURL('image/png');
}

// Synchronous and never-throwing - every render()/ghost/preview call site
// in script.js sets img.src straight from this, exactly like it did when
// cardImageSrc pointed at a static file. Returns the cached composite when
// one exists; composites (cheap - a couple of already-decoded images drawn
// to a small canvas) and caches it on the spot when the needed layers are
// already loaded; otherwise kicks off loading in the background (memoized,
// safe to call repeatedly) and hands back a plain placeholder for now. See
// ensureFacesReady/ensureFacesReadyStrict for callers that need the real
// composite ready before this is ever called.
export function getComposedFaceSrc(design, cardId, condition, size, version) {
  const cacheKey = `${design.facesBase}:${condition}:${cardId.key}`;
  const cached = compositeCache.get(cacheKey);
  if (cached) return cached;

  const faceImg = faceImageCache.get(faceImageKey(design, cardId));
  if (backgroundLayers && faceImg) {
    const result = drawComposite(design, cardId, condition, size, backgroundLayers, faceImg);
    compositeCache.set(cacheKey, result);
    return result;
  }

  ensureBackgroundLayers(version).catch(() => {});
  ensureFaceImage(design, cardId, version).catch(() => {});
  return placeholderSrc(condition, version);
}

async function ensureFacesReadyCore(design, cardIds, condition, size, version) {
  await ensureBackgroundLayers(version);
  await Promise.all(cardIds.map(id => ensureFaceImage(design, id, version)));
  // Layers are guaranteed loaded now, so every one of these is the fast,
  // synchronous compositing path - no different from a cached hit.
  for (const id of cardIds) getComposedFaceSrc(design, id, condition, size, version);
}

// Rejects on a genuine load/decode failure - for the startup critical-
// asset gate, which needs to tell a real failure apart from success (see
// script.js's SUCCESS/FAILURE/TIMEOUT gate).
export function ensureFacesReadyStrict(design, cardIds, condition, size, version) {
  return ensureFacesReadyCore(design, cardIds, condition, size, version);
}

// Never rejects - for a Settings switch (and other non-critical warming),
// which must not hang on one broken asset. Same split, same reasoning as
// script.js's own decodeAwaitedImage vs preloadUrls.
export function ensureFacesReady(design, cardIds, condition, size, version) {
  return ensureFacesReadyCore(design, cardIds, condition, size, version).catch(() => {});
}
