import {
  canPlaceOnFoundation,
  anyFoundationFor,
  canPlaceOnTableau,
  getStackFrom,
  resolveClickDestination,
  applyMove,
  cloneState,
  needsAbandonConfirmation,
  getLegalMoves,
  classifyMove,
  MoveCategory,
  autoFinishAvailable,
  rankMoves,
  getProgressingMoves,
  nextAutoFinishMove,
  isKingColumnSwap,
  applyKingColumnSwap,
  computeKingCascade,
} from './game-logic.js';
import { getPreference, setPreference } from './preferences.js';
import { shuffle } from './shuffle.js';
import { generateVictoryPersonality, assignCardBehaviors, pickHeadline } from './victory.js';
import { recordWin, getStatsForMode, applyWin, recordPlay } from './stats.js';

(() => {
  const SUITS = [
    { key: 'hearts', file: 'heart', color: 'red', symbol: '♥' },
    { key: 'diamonds', file: 'diamond', color: 'red', symbol: '♦' },
    { key: 'clubs', file: 'club', color: 'black', symbol: '♣' },
    { key: 'spades', file: 'spade', color: 'black', symbol: '♠' },
  ];
  const RANK_LABELS = ['', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  const RANK_FILES = ['', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'jack', 'queen', 'king'];

  // Read once, at load, from whatever the viewport happens to be - never
  // recomputed after this. Both RESOLUTION_TIER and CARD_SIZE below key off
  // this same single measurement (avoiding a second forced-layout DOM
  // probe), and both inherit the same "decided once, frozen for the
  // session" guarantee for the same reason: an in-progress game can't have
  // cards change appearance out from under it on rotation/resize. --card-w
  // is itself a calc()-with-100vw expression on mobile (see
  // resolveCssLength below, defined later in this file but hoisted -
  // function declarations are available to code above them in the same
  // scope), so it's resolved through a real element rather than parsed as
  // text.
  const RENDERED_CARD_W_PX = resolveCssLength('var(--card-w)') || 84;

  // Every card-face collection this game knows about, each pointing at its
  // two CARD_SIZE variants' base directory on disk. Adding a future
  // collection means adding one entry here, its two asset folders, and one
  // more option in PREFERENCE_SECTIONS' 'cardStyle' section below - nothing
  // else in this file needs to change, since every call site only ever asks
  // CARD_COLLECTIONS[getActiveCollection()][...] for a base path, never a
  // hard-coded directory name. Card backs are deliberately NOT part of this
  // registry - see BACKS_BASE.
  const CARD_COLLECTIONS = {
    worn: {
      standard: 'assets/cards/worn/standard',
      mobile: 'assets/cards/worn/mobile',
    },
    clean: {
      standard: 'assets/cards/clean/standard',
      mobile: 'assets/cards/clean/mobile',
    },
  };
  const DEFAULT_COLLECTION = 'worn';

  // Read live off the 'cardStyle' preference (see PREFERENCE_SECTIONS)
  // rather than a frozen constant - unlike RESOLUTION_TIER/CARD_SIZE above,
  // which are real per-session viewport measurements that can't change
  // mid-game without the board visibly jumping, which collection to draw
  // from is a pure skin choice with nothing physical backing it, so there's
  // no reason it can't apply the instant the player picks it. Falls back to
  // the default for a stale/unknown stored id, same defensive pattern
  // currentPreferenceOption uses below - a bad value here can never break
  // rendering.
  function getActiveCollection() {
    const id = getPreference('cardStyle', DEFAULT_COLLECTION);
    return CARD_COLLECTIONS[id] ? id : DEFAULT_COLLECTION;
  }

  // Card backs aren't collection-specific artwork the way faces are -
  // every collection shares the same set of back designs, so they live in
  // their own top-level directory rather than inside 'worn/'. A future
  // collection costs nothing extra for backs: there's nothing to duplicate.
  const BACKS_BASE = 'assets/cards/backs';

  // Two pre-rendered resolution tiers ship on disk for Standard-size faces
  // (lo at ~175x250, hi at the original 350x500, both lossless WebP) so a
  // phone never has to download or decode pixels many times larger than it
  // can actually show. This is a pure bandwidth optimization, orthogonal to
  // both collection and CARD_SIZE below - it stays entirely behind the
  // resolver functions here; nothing else in the game ever needs to know
  // it exists. Keys off the same 720px breakpoint style.css uses for its
  // own mobile layout, then double-checks the actual physical pixel need
  // against the lo tier's native resolution - this is what keeps a
  // landscape-rotated phone (viewport width > 720 despite being a phone)
  // safely on the hi tier instead of upscaling a too-small asset. Mobile-
  // size faces (below) ship at a single native resolution with no tier
  // split of their own - see CARD_SIZE.
  const RESOLUTION_TIER = (() => {
    const neededPhysicalPx = RENDERED_CARD_W_PX * (window.devicePixelRatio || 1);
    const LO_TIER_NATIVE_PX = 175;
    return (window.innerWidth <= 720 && neededPhysicalPx <= LO_TIER_NATIVE_PX) ? 'lo' : 'hi';
  })();

  // A second, orthogonal axis from RESOLUTION_TIER above: which card-face
  // DESIGN size to use, not which resolution of it. Mobile-size art is a
  // distinct design (not a downscaled copy of Standard - full native
  // 700x1015 art, always) purpose-built to stay readable at genuinely small
  // rendered sizes, where Standard's corner rank/suit becomes hard to read.
  // 65px sits in the middle of a wide, clean gap measured across every real
  // breakpoint this game ships: only iPhone-portrait-class widths render
  // cards around 50-52px; every other case (iPad either orientation
  // ~86-140px, iPhone landscape ~90-95px, all desktop sizes 84-170px) sits
  // comfortably at 84px+, with nothing in between - so this threshold has
  // wide margin on both sides rather than sitting close to any real
  // device's actual width.
  const SMALL_FACE_THRESHOLD_PX = 65;
  const CARD_SIZE = RENDERED_CARD_W_PX <= SMALL_FACE_THRESHOLD_PX ? 'mobile' : 'standard';

  // Displayed at the bottom of Settings (see versionLink) - no build step
  // generates this, so it's a plain hand-bumped constant, same convention
  // as ASSET_VERSION just below. A timestamp (YYYY.MM.DD.HHmm, bumped to
  // "now" on every change) rather than a semantic version - the point isn't
  // to track features, it's to let you glance at Settings on any given
  // tab/device and immediately tell whether it's running the build you just
  // pushed or a stale cached one from before.
  const APP_VERSION = '2026.08.12.1129';

  // Cache-buster on every card image URL, not a build/deploy version -
  // bump this by hand whenever the card art itself changes. It's what
  // lets Netlify give the card-art directories a year-long immutable
  // Cache-Control (see netlify.toml) without a stale deck getting stuck in
  // a returning player's cache: a version bump mints new URLs, which are
  // cache misses by construction, while every URL that didn't change keeps
  // serving instantly from cache forever.
  const ASSET_VERSION = 'v5';

  // CARD_SIZE picks the collection folder for card FACES only - card backs
  // (below) are untouched by it, always following RESOLUTION_TIER alone
  // against the shared BACKS_BASE, since backs aren't collection- or
  // size-specific the way faces are. Standard-size faces get a further
  // RESOLUTION_TIER subfolder; Mobile-size faces don't (single native res).
  // collectionId defaults to the live active collection - every real call
  // site wants that. The optional override exists solely for
  // preloadForCollectionSwitch, which needs to resolve URLs for the
  // collection the player is about to switch TO, before the preference
  // (and therefore getActiveCollection()) actually changes.
  function cardImageSrc(card, collectionId = getActiveCollection()) {
    const suit = SUITS.find(s => s.key === card.suit);
    const base = CARD_COLLECTIONS[collectionId][CARD_SIZE];
    const tierDir = CARD_SIZE === 'standard' ? `/${RESOLUTION_TIER}` : '';
    return `${base}${tierDir}/${suit.file}_${RANK_FILES[card.rank]}.webp?v=${ASSET_VERSION}`;
  }

  // Every selectable card-back DESIGN this game knows about, keyed by the
  // same id the 'cardBack' preference is stored as - e.g. 'parlor_red',
  // never 'parlor_red_worn'. Which actual artwork that resolves to is a
  // second, independent question (see backImageSrc) driven by the active
  // face collection - the two axes only ever combine at the resolver,
  // mirroring how CARD_COLLECTIONS and CARD_SIZE stay separate too. Adding
  // a future design means adding one entry here (plus its clean/worn
  // asset files) - PREFERENCE_SECTIONS' 'cardBack' options are generated
  // from this, not hand-listed.
  const CARD_BACKS = {
    lovebirds: 'Lovebirds',
    mod_pop: 'Mod Pop',
    north_star_blue: 'North Star Blue',
    north_star_red: 'North Star Red',
    mesmer: 'Mesmer',
    parlor_blue: 'Parlor Blue',
    parlor_red: 'Parlor Red',
    fireflower_blue: 'Fireflower Blue',
    fireflower_red: 'Fireflower Red',
    flower: 'Flower',
    eye: 'Eye',
    blue: 'Blue',
    red: 'Red',
  };

  // Which back-art "condition" (clean or worn) a given face collection
  // uses. Not every future collection is guaranteed its own worn-specific
  // back set, so anything unlisted here falls back to 'clean' - the same
  // thing a genuinely new collection with no back art of its own yet
  // would need anyway.
  const BACK_CONDITION_BY_COLLECTION = { worn: 'worn', clean: 'clean' };

  function backCondition(collectionId) {
    return BACK_CONDITION_BY_COLLECTION[collectionId] || 'clean';
  }

  // A resolved worn back has no dedicated debug/label surface in the game
  // today, but if one is ever added, describe it as e.g. "Parlor Red
  // (worn)" via CARD_BACKS[designId] + this suffix - never in the Card
  // Back picker itself, which only ever shows the plain design name (see
  // PREFERENCE_SECTIONS below).
  function backConditionSuffix(collectionId) {
    return backCondition(collectionId) === 'worn' ? '-worn' : '';
  }

  // collectionId defaults to the live active collection, same pattern as
  // cardImageSrc - the optional override exists for the same reason:
  // resolving a URL for the collection the player is about to switch TO,
  // before the preference actually changes (see the settings click
  // handler's preload step).
  function backImageSrc(designId, collectionId = getActiveCollection()) {
    return `${BACKS_BASE}/${RESOLUTION_TIER}/back-${designId}${backConditionSuffix(collectionId)}.webp?v=${ASSET_VERSION}`;
  }

  // The original PNGs stay on disk as a graceful fallback target -
  // untiered and unversioned, so they're guaranteed to exist regardless of
  // RESOLUTION_TIER or a WebP request failing/being unsupported. Each
  // CARD_SIZE carries its own such fallback (same art, same idea) inside
  // its own collection folder, so even a WebP-decode failure still shows
  // the right artwork, not just a working one. See attachImageFallback for
  // where these get wired up.
  function cardPngFallbackSrc(card, collectionId = getActiveCollection()) {
    const suit = SUITS.find(s => s.key === card.suit);
    const base = CARD_COLLECTIONS[collectionId][CARD_SIZE];
    return `${base}/${suit.file}_${RANK_FILES[card.rank]}.png`;
  }

  function backPngFallbackSrc(designId, collectionId = getActiveCollection()) {
    return `${BACKS_BASE}/back-${designId}${backConditionSuffix(collectionId)}.png`;
  }

  // Falls back exactly once per <img> - the dataset flag stops a failing
  // fallback from looping - so a broken or unsupported WebP request
  // degrades to a real image instead of leaving a permanently blank card.
  function attachImageFallback(img, fallbackSrc) {
    img.addEventListener('error', () => {
      if (img.dataset.fallenBack) return;
      img.dataset.fallenBack = '1';
      img.src = fallbackSrc;
    });
  }

  // Every user-choosable preference, driving both the Settings panel's UI
  // (built generically from this array - see renderSettingsPanel) and how
  // the board itself reads the choice back (see getCardBackSrc). Adding a
  // future preference (table surface, ...) should only ever mean adding
  // another entry here, an appearance-reading helper like getCardBackSrc,
  // and the render-time call sites that use it - never new settings-panel
  // plumbing. 'cardStyle' is the one exception with extra wiring beyond
  // that: see the special-cased preload in renderSettingsPanel's click
  // handler, needed only because switching it can require new network
  // fetches an instant color/deal-style change never does.
  const PREFERENCE_SECTIONS = [
    {
      key: 'cardStyle',
      label: 'Cards',
      default: DEFAULT_COLLECTION,
      variant: 'text', // plain text segmented control - no card art preview, unlike every other image-backed section
      options: [
        { id: 'worn', label: 'Worn' },
        { id: 'clean', label: 'New' },
      ],
    },
    {
      key: 'cardBack',
      label: 'Card Back',
      default: 'red',
      // Generated from CARD_BACKS rather than hand-listed, so a future
      // design only ever needs adding there. previewSrc is pinned to
      // 'clean' regardless of the live active collection - the picker is
      // choosing a DESIGN, not a wear condition, and should read the same
      // whether the player is currently on Worn or Clean faces.
      options: Object.entries(CARD_BACKS).map(([id, label]) => ({
        id,
        label,
        previewSrc: () => backImageSrc(id, 'clean'),
      })),
    },
    {
      key: 'drawCount',
      label: 'Deal Style',
      default: '3',
      variant: 'stack', // bigger tiles with a preview illustration + visible label, not a small color swatch
      options: [
        { id: '1', label: 'Draw 1', previewCards: 1 },
        { id: '3', label: 'Draw 3', previewCards: 3 },
      ],
    },
  ];

  function findPreferenceSection(key) {
    return PREFERENCE_SECTIONS.find(s => s.key === key);
  }

  // Falls back to the section's own declared default (not just whichever
  // option happens to be listed first) if a stored value doesn't match any
  // current option - e.g. a retired card-back design with no modern
  // equivalent. Falling back to options[0] instead of the real default
  // would silently depend on default always happening to be first in the
  // array, which stopped being true once Card Back's default ('red')
  // wasn't its first listed design - never lets a stale preference break
  // rendering OR land on the wrong design.
  function currentPreferenceOption(section) {
    const chosenId = getPreference(section.key, section.default);
    return section.options.find(o => o.id === chosenId)
      ?? section.options.find(o => o.id === section.default)
      ?? section.options[0];
  }

  // A couple of retired card-back ids get one-time-migrated to their
  // modern equivalent, silently, on load - so a returning player who had
  // one selected keeps the same design under its new id rather than
  // reverting to the default. Every other retired id (green, purple,
  // rabbit) has no equivalent in the current 13 designs and is
  // deliberately left alone here: it already falls back safely to
  // 'cardBack's declared default via currentPreferenceOption above.
  const LEGACY_CARD_BACK_IDS = { flowers: 'flower' };
  (() => {
    const stored = getPreference('cardBack', null);
    if (stored && LEGACY_CARD_BACK_IDS[stored]) {
      setPreference('cardBack', LEGACY_CARD_BACK_IDS[stored]);
    }
  })();

  function getCardBackDesignId() {
    return currentPreferenceOption(findPreferenceSection('cardBack')).id;
  }

  function getCardBackSrc() {
    return backImageSrc(getCardBackDesignId());
  }

  // Read live from the preference on every draw rather than cached in a
  // local variable - single source of truth, same pattern as
  // getCardBackSrc, so a Settings change takes effect on the very next
  // stock click with nothing to keep in sync.
  function getDrawCount() {
    return parseInt(currentPreferenceOption(findPreferenceSection('drawCount')).id, 10);
  }

  // The key stats.js stores each mode's records under - 'draw1'/'draw3',
  // read live off the same preference getDrawCount() reads, so the two
  // never drift out of sync with each other.
  function currentDrawModeKey() {
    return `draw${getDrawCount()}`;
  }

  // ---------- background image warming ----------

  // Every URL this has already kicked off a fetch+decode for - guards
  // both against the background queue ever revisiting a card twice and
  // against re-requesting something already on screen (backgroundPreload-
  // Remaining only queues face-down cards; the visible ones got their
  // fetch from render() itself and are already showing).
  const preloadedUrls = new Set();

  function preloadImageUrl(url) {
    if (preloadedUrls.has(url)) return;
    preloadedUrls.add(url);
    const img = new Image();
    img.src = url;
    if (img.decode) img.decode().catch(() => {});
  }

  let backgroundPreloadStarted = false;

  // Warms the browser's fetch+decode cache for every card the current
  // deal doesn't need yet, so that by the time a real draw or tableau
  // flip reaches one, it's already sitting in memory instead of racing a
  // fresh network request - this is what keeps flips and newly revealed
  // cards appearing instantly during normal play even though startup no
  // longer preloads the whole deck up front. Runs exactly once per app
  // load (not per newGame/restart): after the first pass the entire
  // 52-card deck is warm regardless of how it gets reshuffled afterwards.
  // Deliberately only queues faces, never the other 3 unselected card
  // backs - those only get fetched if the player actually opens Settings
  // (renderSettingsPanel's own <img> tags do that for free) or switches
  // to one.
  function backgroundPreloadRemaining() {
    if (backgroundPreloadStarted) return;
    backgroundPreloadStarted = true;

    // Stock first, in draw order (onStockClick pops from the end - see
    // there), since those are the cards a real move is soonest to need;
    // covered tableau cards follow, least-likely-soonest last.
    const queue = [];
    for (let i = state.stock.length - 1; i >= 0; i--) {
      queue.push(cardImageSrc(state.stock[i]));
    }
    for (const col of state.tableau) {
      for (const card of col) {
        if (!card.faceUp) queue.push(cardImageSrc(card));
      }
    }
    if (!queue.length) return;

    const BATCH_SIZE = 4;
    function runBatch() {
      queue.splice(0, BATCH_SIZE).forEach(preloadImageUrl);
      if (queue.length) scheduleNext();
    }
    function scheduleNext() {
      if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(runBatch, { timeout: 1000 });
      } else {
        setTimeout(runBatch, 120); // Safari-without-requestIdleCallback fallback: small timed batches instead of one big blocking pass
      }
    }
    scheduleNext();
  }

  // Animation tuning.
  // One shared duration for every "card slides from A to B" glide -
  // click-to-move, a completed drag's settle, Auto Finish (which reuses
  // click-to-move directly), and the King-column swap - so the physical
  // sliding motion feels the same regardless of what triggered it. Within
  // the ~180-220ms range that reads as a quick, snappy slide rather than a
  // slow float.
  const MOVE_GLIDE_MS = 200;
  // The actual glide duration of whichever move most recently committed -
  // read by checkWin() so the post-win pause always waits out the real
  // animation instead of assuming MOVE_GLIDE_MS, which stopped being a safe
  // assumption once Auto Finish can pass its own (shorter, accelerating)
  // duration for its final cards. Set right before every commitMove() call
  // that could possibly complete the game (executeClickMove and the direct
  // drag-drop path both set it); King swap/cascade never touch a
  // foundation, so they can never be the winning move and don't need to.
  let lastMoveGlideMs = MOVE_GLIDE_MS;
  const MAX_ROTATE_DEG = 1.6;
  const ROTATE_VELOCITY_PX_MS = 1.6; // pointer speed (px/ms) that reaches MAX_ROTATE_DEG
  const FLIP_MS = 260; // keep in sync with .flip-inner's transition duration in style.css - the whole dealt packet flips together, in place, over this long
  const DEAL_STACK_OFFSET_PX = 3; // per-card offset while held at the stock, so a 3-card draw visibly reads as a small packet rather than a single card
  const DEAL_TRAVEL_MS = 340; // each card's one continuous glide, straight from the stock to its real fanned slot
  const SPREAD_STAGGER_MS = 50; // delay before each successive card's glide starts, so a multi-card draw still reads as a sequence rather than one glide
  const GATHER_MS = 120; // waste-pile draw transition: already-visible cards squaring up into the pile before the next batch deals
  const SURVIVOR_SETTLE_MS = 180; // waste-pile draw transition: a still-visible card's short hop from the gathered pile out to its new fanned slot
  const DRAG_THRESHOLD_PX = 4; // pointer movement below this counts as a click, not a drag
  const TABLEAU_FLIP_PAUSE_MS = 170; // beat of stillness after a move exposes a new tableau card, before it turns - reads as a natural pause rather than an instant swap
  const TABLEAU_FLIP_MS = 410; // this reveal's own flip duration - deliberately separate from the deal's FLIP_MS so the two can be tuned independently

  // getComputedStyle().getPropertyValue() on a *custom* property (--foo)
  // returns its raw, var()-substituted token text - never a resolved
  // number - because custom properties have no "used value" the way a
  // real layout property does. That's harmless for a plain literal like
  // `9px`, but --cascade-down/up and --card-w became calc()-with-100vw
  // expressions when mobile card sizing went fully responsive, and
  // parseFloat("calc(...)") is NaN. The only reliable way to resolve a
  // custom property to real px, calc()/vw and all, is to hand it to an
  // actual layout property and measure the result.
  function resolveCssLength(cssLengthExpr) {
    const probe = document.createElement('div');
    probe.style.cssText = `position:absolute; visibility:hidden; height:0; width:${cssLengthExpr};`;
    document.body.appendChild(probe);
    const px = probe.getBoundingClientRect().width;
    probe.remove();
    return px;
  }

  // Every one of these values genuinely only changes at a responsive
  // breakpoint/resize (they resolve fixed CSS custom properties, or a
  // layout position "fixed by the layout above it" - see colTop's own use
  // below), but resolveCssLength forces a synchronous layout (DOM
  // append+measure+remove) every time it runs, and getTableauCol's colTop
  // read is a forced layout too. Recomputing all of that on every single
  // render() call - which commitMove() does on every single move - was
  // cheap enough to miss during ordinary, human-paced clicking, but Auto
  // Finish fires 20+ moves in a ~4s burst: that same layout-thrashing cost
  // repeated in a tight loop was long enough, often enough, to compete with
  // the ghost glide's own animation frames for main-thread time, which is
  // what actually read as jerky. Cached here instead, invalidated only by
  // invalidateLayoutCache() on resize/orientationchange - every render()
  // in between reuses the same numbers for free.
  let cachedCascadeDown = null;
  let cachedCascadeUp = null;
  let cachedCardHeight = null;
  let cachedSafeAreaBottom = null;
  let cachedColTop = null;
  let cachedToolbarReservedHeight = null;
  // Tracks expandedColumnIndex !== null as of the last render() - lets
  // render() detect the exact moment that flips (see its own use of this)
  // without needing every one of the many places that set
  // expandedColumnIndex = ... to separately remember to invalidate the
  // toolbar-height cache themselves.
  let lastRenderedInspecting = false;
  function invalidateLayoutCache() {
    cachedCascadeDown = null;
    cachedCascadeUp = null;
    cachedCardHeight = null;
    cachedSafeAreaBottom = null;
    cachedColTop = null;
    cachedToolbarReservedHeight = null;
  }

  // The gap after a tableau card depends on its own face - a back only
  // needs to show a sliver of its top border, while a face needs enough
  // exposed to read the corner's rank and the top of its suit pip.
  function getCascadeDown() {
    if (cachedCascadeDown === null) cachedCascadeDown = resolveCssLength('var(--cascade-down)');
    return cachedCascadeDown;
  }

  function getCascadeUp() {
    if (cachedCascadeUp === null) cachedCascadeUp = resolveCssLength('var(--cascade-up)');
    return cachedCascadeUp;
  }

  function getCardHeight() {
    if (cachedCardHeight === null) cachedCardHeight = resolveCssLength('var(--card-h)');
    return cachedCardHeight;
  }

  // How much vertical room a tableau column actually has, from its own
  // current top (wherever the existing header/top-row layout puts it -
  // untouched by any of this) down to the bottom of the *safe*, visible
  // viewport - past the home-indicator/notch safe area, with a little
  // breathing room so the bottom card isn't flush against the edge.
  const TABLEAU_BOTTOM_MARGIN_PX = 10;

  // On the iPhone-portrait breakpoint .controls becomes a fixed bottom
  // toolbar (see style.css) instead of living in #topbar's normal flow -
  // reads its real rendered height directly rather than duplicating that
  // breakpoint's pixel values here, so this stays correct automatically if
  // those numbers ever change. Anywhere else .controls is still in normal
  // flow (position !== 'fixed'), contributing nothing here - the existing
  // safe-area-bottom handling below is what applies instead.
  function getToolbarReservedHeight() {
    if (cachedToolbarReservedHeight === null) {
      const controlsEl = document.querySelector('.controls');
      const isFixedToolbar = controlsEl && getComputedStyle(controlsEl).position === 'fixed';
      // iPhone landscape only: while a column is expanded for inspection,
      // the toolbar hides itself entirely (see body.tableau-inspecting in
      // style.css) so the expanded cascade - and every other column's own
      // compression, computed from this same function - can use the space
      // it would otherwise reserve. pointer-events is set as an instant,
      // non-transitioning marker of "hidden" (unlike opacity/transform,
      // which are still mid-animation for a beat) - checking it here can
      // never read a half-hidden toolbar as still reserving space.
      const isHiddenForInspection = isFixedToolbar && getComputedStyle(controlsEl).pointerEvents === 'none';
      cachedToolbarReservedHeight = isFixedToolbar && !isHiddenForInspection
        ? controlsEl.getBoundingClientRect().height
        : 0;
    }
    return cachedToolbarReservedHeight;
  }

  function getTableauAvailableHeight(colTop) {
    // The toolbar's own bottom padding already includes
    // safe-area-inset-bottom (see style.css) - its rendered height alone
    // is the full reserved amount. Subtracting cachedSafeAreaBottom too
    // would double-count that inset.
    const toolbarHeight = getToolbarReservedHeight();
    if (toolbarHeight > 0) return Math.max(0, window.innerHeight - toolbarHeight - TABLEAU_BOTTOM_MARGIN_PX - colTop);
    if (cachedSafeAreaBottom === null) cachedSafeAreaBottom = resolveCssLength('env(safe-area-inset-bottom, 0px)');
    return Math.max(0, window.innerHeight - cachedSafeAreaBottom - TABLEAU_BOTTOM_MARGIN_PX - colTop);
  }

  // The one place a tableau column's per-card vertical offsets are computed
  // from scratch - renderTableauCol uses it for the real column, and
  // computeDestRects uses it to predict where cards not yet in the DOM will
  // land, so the two can never disagree. Everything else (drag, click-move,
  // the flip reveal, hint highlighting) reads a card's real position back
  // out of the DOM via getBoundingClientRect() rather than recomputing it,
  // so it automatically inherits whatever this function decided.
  //
  // Two-tier accordion, cheapest concession first - reordered and
  // POSITION-WEIGHTED relative to an earlier version of this function:
  // 1. Normal spacing, if the whole column already fits top to bottom -
  //    true for every desktop/portrait/short-column case.
  // 2. Otherwise, compress FACE-UP gaps first (not face-down), weighted by
  //    position within the face-up run: the gap right after the first
  //    face-up card, and the last few gaps near the bottom, get a floor at
  //    full legibility (READABLE_UP_FRACTION, same value this function
  //    always used) - that's what protects "what's the first exposed
  //    card" and "what's immediately playable" regardless of how deep the
  //    compression gets. Gaps deep in the middle of the run get a much
  //    lower floor (MIDDLE_MIN_GAP - "almost stacked" is explicitly fine
  //    there). The falloff between the two is a smooth curve by distance
  //    from the nearest edge of the face-up run (see faceUpGapMiddleness),
  //    not a hard cutoff, so compression concentrates in the true middle
  //    first and only spreads outward as more room is needed. All face-up
  //    gaps then shrink PROPORTIONALLY toward their own floor at once - a
  //    gap with more slack (a middle gap, with a much lower floor)
  //    automatically absorbs more of the reduction, with no separate
  //    "is this the middle" branch needed.
  // 3. Only if that still isn't enough, compress face-down gaps toward
  //    MIN_DOWN_GAP - deliberately LAST, not first: face-down cards need
  //    to stay COUNTABLE AT A GLANCE (not merely technically distinguishable
  //    pixel-by-pixel), and that outranks both generous spacing in a
  //    face-up middle nobody can read once it's compressed anyway, and
  //    fitting an extreme column without the expand toggle - see this
  //    tier's own priority note below.
  //
  // Every floor here is a hard floor, never crossed. Cropping the actual
  // card art (Ace/2/10/King, all four suits) at increasing reveal heights
  // found that cascadeUp's own normal value (~19.7% of card height) only
  // shows a sliver of the suit pip under the rank; 25% comfortably shows
  // the whole pip. READABLE_UP_FRACTION splits the difference with a
  // little margin - in practice it sits *above* cascadeUp's own normal
  // value, so edge gaps are a no-op almost always. If excess remains once
  // both tiers are fully floored, the column overflows the ideal boundary
  // rather than eroding legibility further - see the expand/collapse
  // toggle for that case. That tradeoff is deliberate for face-down gaps
  // specifically: an extreme column failing to fit and falling back to the
  // toggle is preferable to a face-down run compressed past being
  // glanceable - see MIN_DOWN_GAP's own value below.
  //
  // 9px, not the 6px an earlier version used: visually tested 2-6 face-down
  // cards on iPad at both 6px and 9px. At 6px, 5-6 cards read as "a small
  // stack" rather than a countable number without deliberately counting
  // individual slivers; 9px was the point where each one reads as a
  // distinct card at a glance, even at 6, without needing to count
  // carefully. This is now the single highest-priority floor in the whole
  // function, by design - see the tier ordering above.
  const MIN_DOWN_GAP = 9;
  const READABLE_UP_FRACTION = 0.28;
  // The tightest a face-up gap may ever get, deep in a column's middle.
  const MIDDLE_MIN_GAP = 3;
  // How quickly the floor falls from READABLE_UP_FRACTION (at either edge
  // of the face-up run) toward MIDDLE_MIN_GAP (dead center) - >1 keeps
  // most of the run close to fully readable and concentrates the drop into
  // a narrower band right at the middle, rather than a linear ramp the
  // whole way across.
  const MIDDLE_FALLOFF_POWER = 2;

  // 0 at either edge of the face-up run (protected, full legibility), 1
  // dead center (maximally compressible). faceUpGapIndex/faceUpGapCount
  // are both 0-based/counted among ONLY the face-up gaps, not every gap in
  // the column.
  function faceUpGapMiddleness(faceUpGapIndex, faceUpGapCount) {
    if (faceUpGapCount <= 1) return 0; // nothing to call "the middle" with 0 or 1 gaps - both ends are the same gap
    const edgeDistance = Math.min(faceUpGapIndex, faceUpGapCount - 1 - faceUpGapIndex);
    const maxEdgeDistance = Math.floor((faceUpGapCount - 1) / 2);
    const t = maxEdgeDistance > 0 ? edgeDistance / maxEdgeDistance : 0;
    return Math.pow(t, MIDDLE_FALLOFF_POWER);
  }

  function computeTableauTops(faceUpFlags, availableHeight, cascadeDown, cascadeUp, cardHeight) {
    const n = faceUpFlags.length;
    if (n === 0) return [];
    if (n === 1) return [0];

    const gaps = faceUpFlags.slice(0, n - 1).map(faceUp => faceUp ? cascadeUp : cascadeDown);
    const naturalGapSum = gaps.reduce((a, b) => a + b, 0);

    if (naturalGapSum + cardHeight > availableHeight) {
      let excess = naturalGapSum - Math.max(0, availableHeight - cardHeight);

      const minDown = Math.min(cascadeDown, Math.max(MIN_DOWN_GAP, cascadeDown * 0.25));
      const edgeUpFloor = Math.max(cascadeUp, cardHeight * READABLE_UP_FRACTION);
      const middleUpFloor = Math.min(edgeUpFloor, MIDDLE_MIN_GAP);

      const downIdx = [], upIdx = [];
      faceUpFlags.slice(0, n - 1).forEach((faceUp, i) => (faceUp ? upIdx : downIdx).push(i));

      // Shrinks every gap in `idx` toward its own floor (from `floorOf`,
      // called with each gap's position within `idx`) proportionally, all
      // at once - a gap with more slack absorbs more of `excess`
      // automatically, rather than every gap losing an equal flat amount.
      // downIdx's floor is flat (ignores its position argument), so this
      // degenerates to a plain equal-shrink there, same as before.
      const shrinkProportional = (idx, floorOf) => {
        if (excess <= 0 || !idx.length) return;
        const slacks = idx.map((i, k) => Math.max(0, gaps[i] - floorOf(k)));
        const totalSlack = slacks.reduce((a, b) => a + b, 0);
        if (totalSlack <= 0) return;
        const fraction = Math.min(1, excess / totalSlack);
        idx.forEach((i, k) => { gaps[i] -= fraction * slacks[k]; });
        excess -= fraction * totalSlack;
      };

      // Face-up first (see this function's header comment for why),
      // position-weighted toward the middle of the face-up run.
      shrinkProportional(upIdx, (k) => {
        const middleness = faceUpGapMiddleness(k, upIdx.length);
        return edgeUpFloor - middleness * (edgeUpFloor - middleUpFloor);
      });
      // Face-down only if the face-up middle wasn't enough on its own.
      shrinkProportional(downIdx, () => minDown);
      // No further fallback beyond this point - if excess remains, every
      // gap is already sitting at its hard floor. The column overflows the
      // ideal boundary rather than erasing the gaps that make it a cascade
      // - or, once expand/collapse below can compensate, staying readable.
    }

    const tops = [0];
    for (let i = 0; i < gaps.length; i++) tops.push(tops[i] + gaps[i]);
    return tops;
  }

  // Cheap yes/no companion to computeTableauTops - same "does the natural
  // height fit" check that function makes internally, exposed separately
  // so callers can know whether a column is a compression candidate at all
  // without running (or duplicating) the actual shrink logic. Drives both
  // the expand-toggle badge's visibility and whether tapping it does
  // anything - a column that already fits never gets a toggle.
  function columnWouldCompress(faceUpFlags, availableHeight, cascadeDown, cascadeUp, cardHeight) {
    const n = faceUpFlags.length;
    if (n <= 1) return false;
    const naturalGapSum = faceUpFlags.slice(0, n - 1).reduce((sum, faceUp) => sum + (faceUp ? cascadeUp : cascadeDown), 0);
    return naturalGapSum + cardHeight > availableHeight;
  }

  // Which tableau column, if any, is temporarily showing full normal
  // spacing instead of its calculated compressed spacing - a display-only
  // inspection mode, never more than one column at a time (see
  // toggleColumnExpanded). Cleared - not just left stale - by every place
  // that changes what's rendered underneath it: a fresh render() call on
  // its own doesn't reset this, since simply *looking* at an expanded
  // column shouldn't collapse it.
  let expandedColumnIndex = null;

  let state = null;
  // Snapshot of the very first deal from the current newGame() call, kept
  // around (untouched by any subsequent move) so restart() can jump back
  // to the exact same hand without reshuffling.
  let initialDeal = null;
  let history = [];
  let moveCount = 0;
  let startTime = null;
  let timerHandle = null;
  let won = false;
  // Snapshot taken the instant checkWin() detects the win, so the celebration
  // (which only starts after a deliberate pause) still shows the exact
  // moveCount/elapsed time from the winning move itself, not whatever they'd
  // be by the time the message actually renders.
  let pendingWinResult = null;
  let celebrationTimer = null;
  // Every currently-in-flight celebration-card Animation object (from
  // el.animate() - see animateCelebrationCard), tracked purely so
  // cleanupVictoryCelebration can immediately .cancel() every one of them
  // on New Game/Restart/Undo, no matter how far into their own (now
  // multi-second) run they are. Never read for any other purpose - the
  // cards' actual motion is entirely self-contained in each Animation.
  let activeCelebrationAnimations = [];
  // Set by forceWinForTesting right before it fabricates a solved board, so
  // the win it triggers (through the exact same checkWin() path a real win
  // uses) still locks the toolbar and plays the real celebration, but
  // doesn't inflate the player's actual stats with a result that took zero
  // real moves to reach. Cleared the instant checkWin() reads it.
  let skipNextStatsRecord = false;
  // The win message no longer waits for the cards to finish at all - the
  // flying cards ARE the celebration, not an intro blocking the message.
  // This is a short, fixed delay from the moment the celebration actually
  // begins (createVictoryCelebration's own invocation), independent of how
  // long individual cards go on to animate for afterward. Tuned by feel: it
  // needs to clear the double-rAF handoff plus give the very first cards a
  // beat to actually be visibly moving before text appears on top of them.
  const MESSAGE_DELAY_AFTER_CELEBRATION_START_MS = 1300;

  // Remembers, per tableau card/sequence, which column a click-cycle last
  // sent it to — so the next click on the same card advances to the next
  // legal destination instead of restarting at the leftmost. Cleared by
  // any other state change (see resetTableauClickMemory call sites).
  let tableauClickMemory = null;
  function resetTableauClickMemory() {
    tableauClickMemory = null;
  }

  const boardEl = document.getElementById('board');
  const movesEl = document.getElementById('moves');
  const timerEl = document.getElementById('timer');
  const undoBtn = document.getElementById('undoBtn');
  const hintBtn = document.getElementById('hintBtn');
  const hintMessage = document.getElementById('hint-message');
  const autoFinishBtn = document.getElementById('autoFinishBtn');
  const autoFinishBtnLabel = document.getElementById('autoFinishBtnLabel');
  const newGameBtn = document.getElementById('newGameBtn');
  const restartBtn = document.getElementById('restartBtn');
  const winMessage = document.getElementById('win-message');
  const winEmoji = document.getElementById('winEmoji');
  const winHeadline = document.getElementById('winHeadline');
  const winResultLine = document.getElementById('winResultLine');
  const winPlaysLine = document.getElementById('winPlaysLine');
  const winRecordTime = document.getElementById('winRecordTime');
  const winRecordMoves = document.getElementById('winRecordMoves');
  const winRecords = document.getElementById('winRecords');
  const winNewGameBtn = document.getElementById('winNewGameBtn');
  const celebrationLayer = document.getElementById('celebration-layer');
  const settingsBtn = document.getElementById('settingsBtn');
  const settingsOverlay = document.getElementById('settings-overlay');
  const settingsCloseBtn = document.getElementById('settingsCloseBtn');
  const settingsSections = document.getElementById('settings-sections');
  const versionLink = document.getElementById('versionLink');
  const statsLink = document.getElementById('statsLink');
  const statsOverlay = document.getElementById('stats-overlay');
  const statsCloseBtn = document.getElementById('statsCloseBtn');
  const statsDraw1Btn = document.getElementById('statsDraw1Btn');
  const statsDraw3Btn = document.getElementById('statsDraw3Btn');
  const statsRows = document.getElementById('stats-rows');
  const confirmOverlay = document.getElementById('confirm-overlay');
  const confirmTitle = document.getElementById('confirm-title');
  const confirmMessage = document.getElementById('confirm-message');
  const confirmKeepBtn = document.getElementById('confirmKeepBtn');
  const confirmGiveUpBtn = document.getElementById('confirmGiveUpBtn');

  function freshDeck() {
    const deck = [];
    let id = 0;
    for (const suit of SUITS) {
      for (let rank = 1; rank <= 13; rank++) {
        deck.push({ id: id++, suit: suit.key, color: suit.color, rank, faceUp: false });
      }
    }
    return deck;
  }

  function newGame() {
    cancelActiveDrag();
    clearGhosts();
    cleanupVictoryCelebration();
    resetTableauClickMemory();
    clearHint();
    expandedColumnIndex = null;
    recordPlay(currentDrawModeKey()); // a fresh deal, independent of whether it's ever won - restart() replays this same deal, so it doesn't count again
    const deck = shuffle(freshDeck());
    const tableau = [[], [], [], [], [], [], []];
    let idx = 0;
    for (let col = 0; col < 7; col++) {
      for (let row = 0; row <= col; row++) {
        const card = deck[idx++];
        card.faceUp = row === col;
        tableau[col].push(card);
      }
    }
    const stock = deck.slice(idx).map(c => ({ ...c, faceUp: false }));
    state = {
      stock,
      waste: [],
      foundations: [[], [], [], []],
      tableau,
    };
    initialDeal = cloneState(state);
    history = [];
    moveCount = 0;
    won = false;
    winMessage.classList.add('hidden');
    setAutoFinishControlsDisabled(false); // the only re-enable path once a win has locked the toolbar - see checkWin()
    startTime = Date.now();
    updateMoves();
    render();
  }

  // Replays the exact same deal as the current newGame() call, for when
  // the player wants another attempt at an identical hand rather than a
  // fresh shuffle. Mirrors newGame()'s reset logic but restores the saved
  // initialDeal snapshot instead of drawing a new one.
  function restart() {
    if (!initialDeal) return;
    cancelActiveDrag();
    clearGhosts();
    cleanupVictoryCelebration();
    resetTableauClickMemory();
    clearHint();
    expandedColumnIndex = null;
    state = cloneState(initialDeal);
    history = [];
    moveCount = 0;
    won = false;
    winMessage.classList.add('hidden');
    setAutoFinishControlsDisabled(false);
    startTime = Date.now();
    updateMoves();
    render();
  }

  // ---------- abandon-game confirmation ----------

  const ABANDON_COPY = {
    newGame: { title: 'Quitting?', message: 'There are still moves available, are you sure?', confirmLabel: 'Shuffle Me a New Game' },
    restart: { title: 'Restart this deal?', message: 'Your moves will be undone, but the same cards will be dealt again.' },
  };

  let confirmOpen = false;
  let confirmResolving = false; // guards a rapid double-tap on either button from double-firing or leaving the modal half-closed
  let confirmOnConfirm = null;
  let confirmTriggerEl = null; // whatever had focus before the modal opened, restored on close

  function onConfirmKeydown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeConfirm();
      return;
    }
    if (e.key === 'Tab') {
      // Only two focusable elements ever exist inside this modal - trap
      // Tab/Shift+Tab between them instead of letting focus escape to the
      // page underneath the overlay.
      e.preventDefault();
      (document.activeElement === confirmKeepBtn ? confirmGiveUpBtn : confirmKeepBtn).focus();
    }
  }

  function closeConfirm() {
    if (!confirmOpen) return;
    confirmOpen = false;
    confirmOverlay.classList.add('hidden');
    document.removeEventListener('keydown', onConfirmKeydown, true);
    confirmOnConfirm = null;
    if (confirmTriggerEl) confirmTriggerEl.focus();
    confirmTriggerEl = null;
  }

  function showConfirm({ title, message, confirmLabel, onConfirm }) {
    if (confirmOpen) return; // only one modal at a time
    confirmOpen = true;
    confirmResolving = false;
    confirmOnConfirm = onConfirm;
    confirmTriggerEl = document.activeElement;
    confirmTitle.textContent = title;
    confirmMessage.textContent = message || '';
    confirmMessage.classList.toggle('hidden', !message); // some dialogs (e.g. the stuck-game case) are title-only
    confirmGiveUpBtn.textContent = confirmLabel || 'Give Up'; // reset every time - this button is shared across every dialog variant
    confirmOverlay.classList.remove('hidden');
    document.addEventListener('keydown', onConfirmKeydown, true);
    confirmKeepBtn.focus();
  }

  confirmKeepBtn.addEventListener('click', () => {
    if (confirmResolving) return;
    confirmResolving = true;
    closeConfirm();
  });
  confirmGiveUpBtn.addEventListener('click', () => {
    if (confirmResolving) return;
    confirmResolving = true;
    const action = confirmOnConfirm;
    closeConfirm();
    if (action) action();
  });
  confirmOverlay.addEventListener('click', e => {
    if (e.target === confirmOverlay) closeConfirm();
  });

  // The one place every destructive action consults before discarding the
  // current deal (see needsAbandonConfirmation in game-logic.js) - runs
  // `action` immediately when nothing meaningful would actually be lost
  // (including when only trivial/non-progressing moves remain), otherwise
  // shows the modal with action-specific wording and only runs it if the
  // player confirms via the modal's own destructive button.
  function guardAbandon(actionKey, action) {
    if (!needsAbandonConfirmation(state, history.length, won, getDrawCount())) {
      action();
      return;
    }
    showConfirm({ ...ABANDON_COPY[actionKey], onConfirm: action });
  }

  // ---------- hint ----------
  //
  // Browses getProgressingMoves(state), ranked by rankMoves - the same
  // shared filter the abandon dialog reads from, so the two can't disagree
  // about what's worth doing. A non-progressing tableau shuffle (moves
  // something already exposed to an equivalent spot, opens nothing new)
  // never appears here, even if it's the only legal move left.

  let hintMoves = null; // cached getLegalMoves() result while a hint session is active; null = no active session
  let hintIndex = 0;

  // Appends a card's label as a small chip (see .hint-card in style.css) -
  // rank and suit set tight against each other with no gap, on the chip's
  // own light card-colored background, so it reads like a tiny card rather
  // than plain sentence text. The suit symbol gets its own span colored to
  // match the card's actual color (see .suit-red/.suit-black).
  function appendCardLabel(container, card) {
    const chip = document.createElement('span');
    chip.className = 'hint-card';
    chip.appendChild(document.createTextNode(RANK_LABELS[card.rank]));
    const suitEl = document.createElement('span');
    suitEl.className = card.color === 'red' ? 'suit-red' : 'suit-black';
    suitEl.textContent = SUITS.find(s => s.key === card.suit).symbol;
    chip.appendChild(suitEl);
    container.appendChild(chip);
  }

  function cardElFor(card) {
    return card ? document.querySelector(`.card[data-id="${card.id}"]`) : null;
  }

  function pileElFor(type, index) {
    if (type === 'tableau') return document.getElementById(`tableau-${index}`);
    if (type === 'foundation') return document.getElementById(`foundation-${index}`);
    if (type === 'waste') return document.getElementById('waste');
    if (type === 'stock') return document.getElementById('stock');
    return null;
  }

  // Builds the hint sentence as a sequence of pieces rather than one string,
  // so the renderer (renderHintMessage) can color just the suit symbols:
  // plain strings render as-is, card objects render as rank + colored suit.
  function hintMoveSegments(move) {
    if (move.category === MoveCategory.DRAW_STOCK) return ['Draw from the stock.'];
    if (move.category === MoveCategory.RECYCLE_STOCK) return ['Recycle the waste into the stock.'];

    const suffix = move.stackLength > 1 ? ' sequence' : '';
    if (move.target === 'foundation') return ['Move the ', move.card, suffix, ' to the foundation.'];

    const destCol = state.tableau[move.targetIndex];
    const destTop = destCol.length ? destCol[destCol.length - 1] : null;
    const segments = destTop
      ? ['Move the ', move.card, suffix, ' onto the ', destTop, '.']
      : ['Move the ', move.card, suffix, ' to the empty column.'];
    if (classifyMove(state, move).reason === 'reveals_card') segments.push(' This reveals a hidden card.');
    return segments;
  }

  function renderHintMessage(segments) {
    hintMessage.innerHTML = '';
    segments.forEach(segment => {
      if (typeof segment === 'string') {
        hintMessage.appendChild(document.createTextNode(segment));
      } else {
        appendCardLabel(hintMessage, segment);
      }
    });
  }

  function clearHint() {
    document.querySelectorAll('.hint-highlight').forEach(el => el.classList.remove('hint-highlight'));
    hintMoves = null;
    hintIndex = 0;
    hintMessage.classList.add('hidden');
    hintMessage.textContent = '';
  }

  function showHintMove(move) {
    document.querySelectorAll('.hint-highlight').forEach(el => el.classList.remove('hint-highlight'));
    if (move.category === MoveCategory.DRAW_STOCK || move.category === MoveCategory.RECYCLE_STOCK) {
      pileElFor('stock')?.classList.add('hint-highlight');
    } else {
      cardElFor(move.card)?.classList.add('hint-highlight');
      pileElFor(move.target, move.targetIndex)?.classList.add('hint-highlight');
    }
    renderHintMessage(hintMoveSegments(move));
    hintMessage.classList.remove('hidden');
  }

  // First press shows the highest-priority progressing move (foundation >
  // reveals a hidden card > other progressing tableau move > stock/waste,
  // see rankMoves); each press after that advances to the next-highest,
  // wrapping past the end - a browse through every progressing move in
  // priority order, not just a single fixed "best move" popup. rankMoves
  // only ever reorders exactly what it's given - it can't add, drop, or
  // invent a move, so there's no separate board analysis for it to
  // disagree with; getProgressingMoves is what actually decides which
  // legal moves are worth showing at all.
  function showHint() {
    if (!hintMoves) {
      const moves = rankMoves(state, getProgressingMoves(state, getDrawCount()));
      if (!moves.length) {
        hintMessage.textContent = 'No useful moves are available.';
        hintMessage.classList.remove('hidden');
        return;
      }
      hintMoves = moves;
      hintIndex = 0;
    } else {
      hintIndex = (hintIndex + 1) % hintMoves.length;
    }
    showHintMove(hintMoves[hintIndex]);
  }

  hintBtn.addEventListener('click', showHint);

  // ---------- auto finish ----------
  //
  // Repeatedly sends whatever's currently exposed and foundation-eligible
  // home, one card at a time, reusing getLegalMoves (the same shared engine
  // Hint and the abandon dialog read from) and executeClickMove (the same
  // function a manual click already uses) - not a second rules or animation
  // implementation. autoFinishAvailable lives in game-logic.js since it's a
  // pure function of state - see it there for the exact rule.

  let autoFinishRunning = false;
  let autoFinishStopRequested = false;

  // Auto Finish's own per-card motion shape: gentle release -> strong,
  // dominant acceleration -> a very short, soft landing. No single
  // cubic-bezier can hold near-max velocity for most of the journey and
  // still land in a short, non-abrupt stop (a bezier's deceleration phase
  // is inherently proportional to how sharp it is - it either lands slowly
  // or stops dead). Built instead as evenly time-spaced sample points
  // (offset -> distance-fraction of the straight-line travel) that
  // glideGhostsTo turns into real WAAPI keyframes at animate time,
  // multiplying by each card's actual pixel delta - the same dense-
  // position-sampling technique victory.js already uses for paths a single
  // easing curve can't express, not a new pattern. AUTO_FINISH_LANDING_T
  // samples are close enough together (a few ms apart at these durations)
  // that linear interpolation between them reads as smooth, so this never
  // depends on per-keyframe CSS easing support - safer for Mobile Safari.
  const AUTO_FINISH_LANDING_T = 0.87;   // accelerating phase covers this fraction of TIME...
  const AUTO_FINISH_LANDING_D = 0.97;   // ...and this fraction of DISTANCE; the rest is the short landing
  const AUTO_FINISH_ACCEL_POWER = 2.3;  // higher = gentler start, more of the distance saved for late in the accelerating phase
  const AUTO_FINISH_MOVE_SAMPLES = 12;
  function autoFinishDistanceAt(t) {
    if (t <= AUTO_FINISH_LANDING_T) {
      const u = t / AUTO_FINISH_LANDING_T;
      return AUTO_FINISH_LANDING_D * Math.pow(u, AUTO_FINISH_ACCEL_POWER); // ease-in: gentle release -> strong acceleration
    }
    const u = (t - AUTO_FINISH_LANDING_T) / (1 - AUTO_FINISH_LANDING_T);
    return AUTO_FINISH_LANDING_D + (1 - AUTO_FINISH_LANDING_D) * (1 - (1 - u) * (1 - u)); // ease-out-quad: brief, soft settle
  }
  const AUTO_FINISH_MOVE_PROFILE = Array.from({ length: AUTO_FINISH_MOVE_SAMPLES + 1 }, (_, i) => {
    const offset = i / AUTO_FINISH_MOVE_SAMPLES;
    return { offset, distance: offset === 1 ? 1 : autoFinishDistanceAt(offset) };
  });

  // Glide duration jitters ±AUTO_FINISH_GLIDE_JITTER_MS per card so
  // consecutive glides don't read as mechanically identical; deliberately
  // *not* a function of run progress - that's cadence's job below. Manual
  // click-to-move, drag, King swap, and King cascade are all untouched,
  // still MOVE_GLIDE_MS and the plain-transition path, since none of them
  // pass duration/moveProfile through options.
  const AUTO_FINISH_GLIDE_MS = 200;
  const AUTO_FINISH_GLIDE_JITTER_MS = 10;
  function autoFinishGlideDuration() {
    return AUTO_FINISH_GLIDE_MS + (Math.random() * 2 - 1) * AUTO_FINISH_GLIDE_JITTER_MS;
  }

  // Cadence: the delay between move *starts* - independent of the glide
  // duration above. A continuous curve over how far through the run we are
  // (exact, not estimated: totalMoves is every card not yet on a
  // foundation the instant a run starts, and since Auto Finish only ever
  // starts once the whole tableau is face-up with an empty stock, every one
  // of those cards is guaranteed to eventually move - see
  // autoFinishAvailable in game-logic.js). ^EASE_POWER biases the curve to
  // stay near INTERVAL_START_MS through the opening cards, then fall away
  // faster toward INTERVAL_END_MS in roughly the last handful - "calm, then
  // flowing, then a quick final run" - rather than a linear ramp or
  // discrete steps.
  //
  // The interval starts *above* AUTO_FINISH_GLIDE_MS and ends *well below*
  // it, by design: early on each card visibly finishes settling with a
  // small gap before the next leaves; late in the run several cards can be
  // mid-glide simultaneously (interval ~115ms vs a ~200ms glide), which is
  // what turns the tail into a flowing, layered cascade rather than a
  // strict move-stop-move-stop sequence - no separate overlap mechanism
  // needed, it falls straight out of this one relationship. (An earlier
  // version of this pacing curve stayed permanently below the glide
  // duration and only ever got more overlapped - crossing that threshold
  // via a hardcoded step table read as a jerky rhythm flip. This crosses it
  // too, but via one continuous curve, which is what actually reads as
  // smooth: a single easing relationship, not an abrupt table lookup.)
  const AUTO_FINISH_INTERVAL_START_MS = 238;
  const AUTO_FINISH_INTERVAL_END_MS = 115;
  const AUTO_FINISH_INTERVAL_JITTER_MS = 6;
  const AUTO_FINISH_INTERVAL_EASE_POWER = 2.5;
  function autoFinishInterval(completedMoves, totalMoves) {
    const progress = totalMoves > 1 ? Math.min(completedMoves / (totalMoves - 1), 1) : 1;
    const eased = Math.pow(progress, AUTO_FINISH_INTERVAL_EASE_POWER);
    const base = AUTO_FINISH_INTERVAL_START_MS - eased * (AUTO_FINISH_INTERVAL_START_MS - AUTO_FINISH_INTERVAL_END_MS);
    return base + (Math.random() * 2 - 1) * AUTO_FINISH_INTERVAL_JITTER_MS;
  }

  function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

  function setAutoFinishControlsDisabled(disabled) {
    undoBtn.disabled = disabled; // re-derived correctly by updateMoves() in stopAutoFinish when re-enabling
    newGameBtn.disabled = disabled;
    restartBtn.disabled = disabled;
    hintBtn.disabled = disabled;
  }

  function onAutoFinishKeydown(e) {
    if (e.key === 'Escape') { e.preventDefault(); autoFinishStopRequested = true; }
  }

  async function runAutoFinish() {
    // Exact, not estimated - see autoFinishInterval's own comment above.
    const totalMoves = 52 - state.foundations.reduce((a, p) => a + p.length, 0);
    let i = 0;
    while (!autoFinishStopRequested) {
      const move = nextAutoFinishMove(state);
      if (!move) break;
      const stack = getStackFrom(state, move.source, move.sourceIndex, move.card);
      executeClickMove(stack, move.source, move.sourceIndex, 'foundation', move.targetIndex, {
        recordHistory: false,
        duration: autoFinishGlideDuration(),
        moveProfile: AUTO_FINISH_MOVE_PROFILE,
      });
      await sleep(autoFinishInterval(i++, totalMoves));
    }
    stopAutoFinish();
  }

  function startAutoFinish() {
    if (autoFinishRunning || !autoFinishAvailable(state)) return;
    cancelActiveDrag();
    clearGhosts();
    resetTableauClickMemory();
    clearHint();
    pushHistory(); // the one grouped snapshot for the whole run
    autoFinishRunning = true;
    autoFinishStopRequested = false;
    autoFinishBtnLabel.textContent = 'Stop';
    autoFinishBtn.classList.add('flash'); // brief one-shot pulse so starting reads as intentional, not sudden
    autoFinishBtn.classList.add('ready'); // already on from being available pre-click (see updateAutoFinishReady) - set again defensively so a run always has the glow regardless of how it was started
    autoFinishBtn.classList.add('running'); // a visibly stronger treatment than .ready alone - actively happening, not just available
    setAutoFinishControlsDisabled(true);
    document.addEventListener('keydown', onAutoFinishKeydown, true);
    runAutoFinish();
  }

  // No end-of-run message in any case: not on a win (the overlay is the
  // payoff), not on a manual stop (return to play quietly), and not on
  // running out of moves either - the board itself shows why it stopped,
  // and staying silent avoids any risk of reading as "stuck."
  function stopAutoFinish() {
    autoFinishRunning = false;
    autoFinishStopRequested = false;
    autoFinishBtnLabel.textContent = 'Auto Finish';
    autoFinishBtn.classList.remove('flash'); // so the next start re-triggers the animation rather than being a no-op class toggle
    autoFinishBtn.classList.remove('running');
    document.removeEventListener('keydown', onAutoFinishKeydown, true);
    // Resolves disabled/.ready for the button itself regardless of won -
    // unlike undoBtn/newGameBtn/restartBtn/hintBtn below, autoFinishBtn was
    // never part of the win-lock (setAutoFinishControlsDisabled doesn't
    // touch it), and a just-won board always has autoFinishAvailable(state)
    // === false anyway, so this always resolves to "off" there.
    updateAutoFinishReady();
    // A run that just ended in victory must NOT hand control back to the
    // toolbar - checkWin() has already locked it (synchronously, the instant
    // the winning move committed) specifically to close the window where a
    // grouped Auto Finish run's own end-of-run re-enable would otherwise
    // race the celebration's pending pause and let Undo become clickable on
    // a won board. The toolbar's only re-enable path once won is
    // newGame()/restart()/undo().
    if (!won) {
      setAutoFinishControlsDisabled(false);
      updateMoves(); // re-derives undoBtn.disabled and Moves text
    }
  }

  autoFinishBtn.addEventListener('click', () => {
    if (autoFinishRunning) autoFinishStopRequested = true;
    else startAutoFinish();
  });
  document.querySelectorAll('.pile.foundation').forEach(el => {
    // The common solitaire double-click-a-foundation convention; no-op via
    // the same guards when unavailable or already running.
    el.addEventListener('dblclick', startAutoFinish);
  });

  // ---------- King-column cascade (press-and-hold an empty tableau column) ----------
  //
  // A board-rearrangement convenience, not a real Klondike move - see
  // computeKingCascade in game-logic.js for the full rationale and the
  // deterministic left-then-right, fully-chained-once-a-side-is-chosen
  // rule it implements. Everything here just turns that plan into real
  // moves: one grouped pushHistory()/moveCount for the whole chain, then
  // each column-move reuses executeClickMove exactly like a normal tableau
  // move (ghost glide, face-down flip detection, all included for free),
  // just with recordHistory/countMove both suppressed per step.

  let kingCascadeRunning = false;
  // A gentle, jittered ramp rather than a flat interval - moves.length is
  // known exactly upfront (computeKingCascade already returned the whole
  // plan), so this is index-through-a-known-total, not a running estimate
  // like Auto Finish's own cadence. Kept deliberately calmer than Auto
  // Finish (which favors a fast, flowing cascade of many individual cards):
  // this moves whole columns, and chains are typically short (2-4), so the
  // point is still to read as one column at a time, just without the dead-
  // flat, metronomic beat a single fixed constant produced.
  const KING_CASCADE_STEP_START_MS = MOVE_GLIDE_MS + 60;
  const KING_CASCADE_STEP_END_MS = MOVE_GLIDE_MS - 20;
  const KING_CASCADE_STEP_JITTER_MS = 10;
  function kingCascadeStepDelay(index, total) {
    const progress = total > 1 ? Math.min(index / (total - 1), 1) : 1;
    const base = KING_CASCADE_STEP_START_MS - progress * (KING_CASCADE_STEP_START_MS - KING_CASCADE_STEP_END_MS);
    return base + (Math.random() * 2 - 1) * KING_CASCADE_STEP_JITTER_MS;
  }

  function runKingCascadeStep(fromIndex, toIndex) {
    const col = state.tableau[fromIndex];
    const king = col.find(c => c.faceUp);
    const stack = getStackFrom(state, 'tableau', fromIndex, king);
    executeClickMove(stack, 'tableau', fromIndex, 'tableau', toIndex, { recordHistory: false, countMove: false });
  }

  async function runKingCascade(moves) {
    for (let i = 0; i < moves.length; i++) {
      runKingCascadeStep(moves[i].from, moves[i].to);
      if (i < moves.length - 1) await sleep(kingCascadeStepDelay(i, moves.length));
    }
    kingCascadeRunning = false;
    if (!won) {
      setAutoFinishControlsDisabled(false);
      updateMoves();
    }
  }

  // Called once a press-and-hold on an empty column completes - see the
  // pointerdown/hold gesture below, the only path that ever calls this.
  // Guards stay here too (not just at hold-start) since board state could
  // in principle change over the hold's own ~450ms window.
  function triggerKingCascade(emptyIndex) {
    if (dragCtx || isDrawing || autoFinishRunning || kingCascadeRunning) return;
    if (state.tableau[emptyIndex].length) return;
    const moves = computeKingCascade(state, emptyIndex);
    if (!moves.length) return;

    resetTableauClickMemory();
    clearHint();
    expandedColumnIndex = null;
    pushHistory(); // one grouped snapshot for the whole chain, regardless of length
    moveCount++; // counts as exactly one move, no matter how many columns shift
    updateMoves();

    kingCascadeRunning = true;
    setAutoFinishControlsDisabled(true); // closes the same kind of mid-animation Undo race Auto Finish already had to close
    runKingCascade(moves);
  }

  // ---------- King-cascade press-and-hold gesture ----------
  //
  // A plain tap used to trigger the cascade instantly - easy to fire by
  // accident (a stray brush against an empty column reads identically to a
  // deliberate one, and gives zero warning either way). Holding instead:
  // the column visibly lights up (.cascade-charging, see style.css) over
  // KING_CASCADE_HOLD_MS, only committing if the hold survives the whole
  // window without releasing or moving away - an accidental touch almost
  // never lasts that long, and even when it does, the glow gives a clear
  // "something is about to happen" beat to back out of. Pointerdown/move/
  // up/cancel, matching how card dragging already distinguishes a tap from
  // a drag (see startDrag) - never a native 'click' for this feature.
  const KING_CASCADE_HOLD_MS = 450; // keep in sync with .pile.cascade-charging's transition duration in style.css
  // Looser than DRAG_THRESHOLD_PX on purpose - a still finger naturally
  // drifts more over a 450ms hold than over a quick tap's press-release, so
  // reusing that tighter threshold here would cancel genuine holds from
  // ordinary hand tremor.
  const KING_CASCADE_HOLD_CANCEL_PX = 12;

  let kingCascadeHoldPointerId = null;
  let kingCascadeHoldTimer = null;
  let kingCascadeHoldEl = null;
  let kingCascadeHoldEligible = false; // false: tracking a plain tap for reject-bounce feedback, not actually charging
  let kingCascadeHoldStartX = 0;
  let kingCascadeHoldStartY = 0;

  function cancelKingCascadeHold() {
    if (kingCascadeHoldTimer) { clearTimeout(kingCascadeHoldTimer); kingCascadeHoldTimer = null; }
    if (kingCascadeHoldEl) kingCascadeHoldEl.classList.remove('cascade-charging');
    kingCascadeHoldEl = null;
    kingCascadeHoldPointerId = null;
    window.removeEventListener('pointermove', onKingCascadeHoldMove);
    window.removeEventListener('pointerup', onKingCascadeHoldEnd);
    window.removeEventListener('pointercancel', cancelKingCascadeHold);
  }

  function onKingCascadeHoldMove(e) {
    if (e.pointerId !== kingCascadeHoldPointerId) return;
    const dist = Math.hypot(e.clientX - kingCascadeHoldStartX, e.clientY - kingCascadeHoldStartY);
    if (dist > KING_CASCADE_HOLD_CANCEL_PX) cancelKingCascadeHold(); // drifted away - not a deliberate hold (or tap) anymore
  }

  function onKingCascadeHoldEnd(e) {
    if (e.pointerId !== kingCascadeHoldPointerId) return;
    const el = kingCascadeHoldEl;
    const wasReject = el && !kingCascadeHoldEligible;
    cancelKingCascadeHold(); // released before the timer fired either way - no cascade
    if (wasReject) bounceEmptyColumn(el); // a genuine tap with nothing eligible still gets acknowledged
  }

  function bounceEmptyColumn(el) {
    el.classList.remove('touch-bounce');
    void el.offsetWidth; // force reflow so re-adding the class restarts the animation
    el.classList.add('touch-bounce');
  }

  function onKingCascadePointerDown(e, emptyIndex, el) {
    if (dragCtx || isDrawing || autoFinishRunning || kingCascadeRunning || kingCascadeHoldPointerId !== null) return;
    if (e.button !== undefined && e.button !== 0) return;
    if (state.tableau[emptyIndex].length) return;
    e.preventDefault();

    kingCascadeHoldPointerId = e.pointerId;
    kingCascadeHoldStartX = e.clientX;
    kingCascadeHoldStartY = e.clientY;
    kingCascadeHoldEl = el;
    kingCascadeHoldEligible = computeKingCascade(state, emptyIndex).length > 0;
    window.addEventListener('pointermove', onKingCascadeHoldMove);
    window.addEventListener('pointerup', onKingCascadeHoldEnd);
    window.addEventListener('pointercancel', cancelKingCascadeHold);

    if (kingCascadeHoldEligible) {
      el.classList.add('cascade-charging');
      kingCascadeHoldTimer = setTimeout(() => {
        cancelKingCascadeHold();
        triggerKingCascade(emptyIndex);
      }, KING_CASCADE_HOLD_MS);
    }
    // Not eligible: no timer, no glow - just tracked so a genuine tap-and-
    // release (not a drift-away) can still bounce, in onKingCascadeHoldEnd.
  }

  document.querySelectorAll('.pile.column').forEach(el => {
    el.addEventListener('pointerdown', e => onKingCascadePointerDown(e, parseInt(el.dataset.index, 10), el));
  });

  // Each entry pairs the state snapshot with moveCount at that instant,
  // rather than just the state - undo() restores both directly instead of
  // assuming every entry represents exactly one move. That assumption holds
  // for a single click/drag move, but not for a grouped multi-move entry
  // (see commitMove's recordHistory option, used by Auto Finish to push one
  // entry for an entire run).
  function pushHistory() {
    history.push({ state: cloneState(state), moveCount });
    if (history.length > 200) history.shift();
  }

  function undo() {
    if (!history.length) return;
    cancelActiveDrag();
    clearGhosts();
    cleanupVictoryCelebration();
    resetTableauClickMemory();
    expandedColumnIndex = null;
    const entry = history.pop();
    state = entry.state;
    moveCount = entry.moveCount;
    // Defensive, not reachable via the UI today: once won, checkWin() has
    // already disabled Undo along with the rest of the toolbar, and nothing
    // re-enables it except newGame()/restart()/undo() themselves - so this
    // function can no longer actually run in a won state. Kept anyway
    // (matching newGame/restart) in case some future path calls undo()
    // directly - resetting won/hiding the message is a harmless no-op when
    // the game wasn't won to begin with.
    won = false;
    winMessage.classList.add('hidden');
    setAutoFinishControlsDisabled(false);
    updateMoves();
    render();
  }

  // The button glows (.ready) any time it's enabled - not just while a run
  // is actually in progress - so it reads as an invitation the instant Auto
  // Finish becomes possible, before the player has touched it. Also called
  // unconditionally at the end of a run (see stopAutoFinish) since a won
  // game skips updateMoves() entirely, and disabled/.ready still need to
  // resolve to "off" in that case (autoFinishAvailable(state) is false once
  // there's nothing left to move).
  function updateAutoFinishReady() {
    autoFinishBtn.disabled = !autoFinishAvailable(state);
    autoFinishBtn.classList.toggle('ready', !autoFinishBtn.disabled);
  }

  function updateMoves() {
    movesEl.textContent = `Moves: ${moveCount}`;
    // While a run is in progress, undoBtn/autoFinishBtn's disabled state is
    // owned by startAutoFinish/stopAutoFinish (or triggerKingCascade/
    // runKingCascade) instead - this runs on every single commitMove,
    // including each individual Auto Finish or King-cascade step, so
    // without this guard it would silently re-enable Undo mid-run.
    if (!autoFinishRunning && !kingCascadeRunning) {
      undoBtn.disabled = history.length === 0;
      updateAutoFinishReady();
    }
  }

  // The one place elapsed seconds become an "m:ss" string - used by the
  // header timer, the victory screen, and the Stats panel, so all three
  // can never disagree on formatting. No hour rollover (matches this
  // function's own prior inline behavior in both places it used to be
  // duplicated) - a solitaire game realistically never runs that long.
  function formatTime(totalSeconds) {
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  function tick() {
    if (won || !startTime) return;
    const secs = Math.floor((Date.now() - startTime) / 1000);
    timerEl.textContent = `Time: ${formatTime(secs)}`;
  }

  // ---------- rendering ----------

  function render() {
    renderStock();
    renderWaste();
    for (let i = 0; i < 4; i++) renderFoundation(i);
    // Resolved once per render, not per column - same three values feed
    // every column's compression calc (see computeTableauTops).
    const cascadeDown = getCascadeDown();
    const cascadeUp = getCascadeUp();
    const cardHeight = getCardHeight();
    // Set *before* the column loop below, not after: on iPhone landscape
    // this class is what makes the bottom toolbar hide itself (see
    // style.css), and renderTableauCol's own getTableauAvailableHeight call
    // needs to see that change on this exact render pass, not the next one.
    // Toggling expandedColumnIndex doesn't go through a resize/orientation
    // event, so the normal cache (invalidated only by those - see
    // invalidateLayoutCache) would otherwise keep returning whatever the
    // toolbar's reserved height was before inspection started right up
    // until the next resize happened to come along.
    const isInspecting = expandedColumnIndex !== null;
    if (isInspecting !== lastRenderedInspecting) {
      lastRenderedInspecting = isInspecting;
      cachedToolbarReservedHeight = null;
    }
    // Lets the page scroll far enough to reach an expanded column's
    // overflowing bottom card (see the html/body.tableau-inspecting rule) -
    // only while one is actually expanded, never otherwise. Both html and
    // body need the class: document.scrollingElement is html, so it has to
    // grow too, not just body, or an expanded column can still overflow
    // past what's actually reachable by scrolling.
    document.documentElement.classList.toggle('tableau-inspecting', isInspecting);
    document.body.classList.toggle('tableau-inspecting', isInspecting);
    for (let i = 0; i < 7; i++) renderTableauCol(i, cascadeDown, cascadeUp, cardHeight);
    checkWin();
  }

  function makeCardEl(card, faceUp) {
    const el = document.createElement('div');
    el.className = `card ${faceUp ? 'face-up' : 'face-down'}`;
    el.dataset.id = card.id;
    const img = document.createElement('img');
    img.draggable = false;
    img.decoding = 'sync'; // hold the paint until decoded, rather than showing blank then popping in
    if (faceUp) {
      img.src = cardImageSrc(card);
      img.alt = `${RANK_LABELS[card.rank]} of ${card.suit}`;
      attachImageFallback(img, cardPngFallbackSrc(card));
    } else {
      img.src = getCardBackSrc();
      img.alt = 'face-down card';
      attachImageFallback(img, backPngFallbackSrc(getCardBackDesignId()));
    }
    el.appendChild(img);
    return el;
  }

  function renderStock() {
    const el = document.getElementById('stock');
    el.innerHTML = '';
    if (state.stock.length) {
      const card = state.stock[state.stock.length - 1];
      const cardEl = makeCardEl(card, false);
      cardEl.classList.add('not-draggable');
      el.appendChild(cardEl);
    } else {
      const hint = document.createElement('div');
      hint.className = 'empty-hint';
      hint.textContent = '↺';
      el.appendChild(hint);
    }
    el.onclick = onStockClick;
  }

  function renderWaste() {
    const el = document.getElementById('waste');
    el.innerHTML = '';
    const n = state.waste.length;
    if (!n) return;
    const visibleStart = Math.max(0, n - 3);
    for (let i = visibleStart; i < n; i++) {
      const card = state.waste[i];
      const cardEl = makeCardEl(card, true);
      cardEl.style.left = `${(i - visibleStart) * 16}px`;
      cardEl.style.zIndex = i;
      if (i === n - 1) {
        attachCardInteractions(cardEl, card, 'waste', null);
      } else {
        cardEl.classList.add('not-draggable');
      }
      el.appendChild(cardEl);
    }
  }

  // peekBehindTop: a foundation pile only ever has one real DOM element (its
  // top card) - a plain render() can't "reveal the card underneath" once a
  // drag lifts that element, because state.foundations hasn't actually
  // changed yet (moves only commit on drop). This renders the *next* card
  // down instead, as a static, non-interactive preview, so lifting a card
  // off a foundation shows the pile continuing underneath it rather than
  // going empty until the drop resolves. Only ever called mid-drag; a
  // normal render() (peekBehindTop: false) always follows once the drag
  // resolves, whether committed or cancelled.
  function renderFoundation(i, { peekBehindTop = false } = {}) {
    const el = document.getElementById(`foundation-${i}`);
    el.innerHTML = '';
    el.dataset.placeholder = 'A'; // any Ace may start any slot — no suit is pinned to a position
    const pile = state.foundations[i];
    if (peekBehindTop) {
      if (pile.length < 2) return; // nothing left underneath - correctly empty
      const cardEl = makeCardEl(pile[pile.length - 2], true);
      cardEl.classList.add('not-draggable');
      el.appendChild(cardEl);
      return;
    }
    if (pile.length) {
      const card = pile[pile.length - 1];
      const cardEl = makeCardEl(card, true);
      attachCardInteractions(cardEl, card, 'foundation', i);
      el.appendChild(cardEl);
    }
  }

  // Small toggle badge for a compressed column - a separate element with
  // its own click handler, not a click-area carved out of the column
  // background, because in heavy compression a card's own (full-size) box
  // already covers nearly the entire visual stack, leaving no reliable
  // "background" pixel to target. Placed top-right, clear of the corner
  // rank/suit index (which sits top-left on every card in this deck), with
  // a z-index above every card in the column so it's always reachable
  // regardless of how many cards overlap that spot - and a stopPropagation
  // so a tap here can never also register as a click on whatever card sits
  // underneath it.
  function createExpandToggle(i, isExpanded) {
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'tableau-expand-toggle';
    const label = isExpanded ? 'Collapse column' : 'Expand column';
    toggle.setAttribute('aria-label', label);
    toggle.title = label;
    toggle.textContent = isExpanded ? '▴' : '▾'; // ▴ collapse / ▾ expand
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleColumnExpanded(i);
    });
    return toggle;
  }

  function toggleColumnExpanded(i) {
    expandedColumnIndex = expandedColumnIndex === i ? null : i;
    render();
    // render() rebuilds every tableau card element, which would otherwise
    // silently drop an already-showing hint glow - same fix as the resize
    // reflow uses, for the same reason.
    if (hintMoves) showHintMove(hintMoves[hintIndex]);
  }

  function renderTableauCol(i, cascadeDown, cascadeUp, cardHeight) {
    const el = document.getElementById(`tableau-${i}`);
    el.innerHTML = '';
    const col = state.tableau[i];
    // Fixed by the layout above it (same for every column, since they all
    // sit in one row) - this compression never moves it, so it's cached
    // like the other measurements above rather than force-read via
    // getBoundingClientRect() on all 7 columns every single render().
    if (cachedColTop === null) cachedColTop = el.getBoundingClientRect().top;
    const realAvailableHeight = getTableauAvailableHeight(cachedColTop);
    const faceUpFlags = col.map(c => c.faceUp);
    const compressed = columnWouldCompress(faceUpFlags, realAvailableHeight, cascadeDown, cascadeUp, cardHeight);
    const isExpanded = i === expandedColumnIndex;
    // The only place expanded state actually does anything: feed the same
    // computeTableauTops call Infinity instead of the real measured room,
    // which is exactly the "already fits" branch it already has - not a
    // second spacing system, just a different input to the one that exists.
    const tops = computeTableauTops(faceUpFlags, isExpanded ? Infinity : realAvailableHeight, cascadeDown, cascadeUp, cardHeight);
    col.forEach((card, idx) => {
      const cardEl = makeCardEl(card, card.faceUp);
      cardEl.style.top = `${tops[idx]}px`;
      cardEl.style.zIndex = idx;
      if (card.faceUp) {
        attachCardInteractions(cardEl, card, 'tableau', i);
      } else {
        cardEl.classList.add('not-draggable');
      }
      el.appendChild(cardEl);
    });
    // Absolutely-positioned cards (every card here) contribute nothing to
    // a normal-flow ancestor's height on their own - min-height alone
    // can't grow to fit them, regardless of how far past it their `top`
    // pushes them. Explicitly sizing the expanded column itself to its
    // real extent is what gives html/body.tableau-inspecting's own
    // height:auto (see style.css) something genuine to grow around further
    // up the tree - without this, an expanded column's overflowing bottom
    // card renders past the fold but is never actually reachable by
    // scrolling, confirmed by measurement. Reset for every other column
    // (including one that was expanded a moment ago and just collapsed),
    // so nothing but the currently-expanded column ever carries this.
    el.style.height = isExpanded ? `${tops[tops.length - 1] + cardHeight}px` : '';
    el.classList.toggle('expanded', isExpanded);
    if (compressed) el.appendChild(createExpandToggle(i, isExpanded));
  }

  // ---------- game rules ----------
  // canPlaceOnFoundation, anyFoundationFor, canPlaceOnTableau, getStackFrom,
  // resolveClickDestination, and applyMove all live in game-logic.js so
  // they're testable without a DOM.

  function createFlipGhost(card, rect, zIndex) {
    const wrapper = document.createElement('div');
    wrapper.className = 'flip-ghost';
    wrapper.style.left = `${rect.left}px`;
    wrapper.style.top = `${rect.top}px`;
    wrapper.style.width = `${rect.width}px`;
    wrapper.style.height = `${rect.height}px`;
    wrapper.style.zIndex = zIndex;

    const inner = document.createElement('div');
    inner.className = 'flip-inner';

    const front = document.createElement('div');
    front.className = 'flip-face flip-front';
    const frontImg = document.createElement('img');
    frontImg.decoding = 'sync';
    frontImg.src = getCardBackSrc();
    frontImg.alt = 'face-down card';
    attachImageFallback(frontImg, backPngFallbackSrc(getCardBackDesignId()));
    front.appendChild(frontImg);

    const back = document.createElement('div');
    back.className = 'flip-face flip-back';
    const backImg = document.createElement('img');
    backImg.decoding = 'sync';
    backImg.src = cardImageSrc(card);
    backImg.alt = `${RANK_LABELS[card.rank]} of ${card.suit}`;
    attachImageFallback(backImg, cardPngFallbackSrc(card));
    back.appendChild(backImg);

    inner.appendChild(front);
    inner.appendChild(back);
    wrapper.appendChild(inner);
    document.getElementById('drag-layer').appendChild(wrapper);
    return { wrapper, inner };
  }

  // Deals cards from the stock rect to wherever they actually landed in the
  // waste fan, flipping face-down to face-up in flight. Each card is
  // staggered slightly so a 3-card draw reads as dealt, not dumped.
  // A CSS transition retargeted mid-flight is NOT velocity-continuous -
  // the moment a new target/duration is set, the browser starts that new
  // easing curve's own velocity profile from scratch (ease-out-smooth
  // starts fast), regardless of how slow the old transition had already
  // decelerated to by then. Chaining two transitions (a landing, then a
  // separate spread) always produces a kick at the handoff no matter how
  // the timing is tuned - the only way to guarantee a truly smooth glide
  // is a single, uninterrupted transition per card. That's what this
  // does: one continuous glide straight from the stock to each card's
  // real fanned slot, while the flip happens as a separate, synchronized
  // motion on top - "unit" comes from the flip firing at the same
  // instant for every card, not from an intermediate stop along the way.
  // onCardRevealed(card, destRect), if given, fires the instant each card's
  // ghost is swapped for its real element - i.e. exactly when that card
  // actually becomes visible, per-card, not once for the whole batch.
  function animateDraw(cards, originRect, onCardRevealed) {
    const ghosts = cards.map((card, i) => {
      const el = document.querySelector(`.card[data-id="${card.id}"]`);
      if (!el) return null; // covered by a later card in the same draw; nothing to animate
      const destRect = el.getBoundingClientRect();
      el.style.visibility = 'hidden';

      // A small held-stack offset per card, independent of the real fan
      // spacing - just enough that a 3-card draw visibly reads as a
      // packet of cards, not a single card, at the moment it's dealt.
      const stackOrigin = {
        left: originRect.left + i * DEAL_STACK_OFFSET_PX,
        top: originRect.top - i * DEAL_STACK_OFFSET_PX,
        width: originRect.width,
        height: originRect.height,
      };
      const { wrapper, inner } = createFlipGhost(card, stackOrigin, 1000 + i);
      return { card, el, wrapper, inner, stackOrigin, destRect };
    }).filter(Boolean);

    if (!ghosts.length) return;

    // The flip: every card turns face-up together, at the exact same
    // instant, regardless of where each one currently is along its glide.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      ghosts.forEach(g => g.inner.classList.add('flipped'));
    }));

    // The glide: each card's one and only translate transition, straight
    // to its real destination - started a beat after the last so a
    // multi-card draw still reads as a dealt sequence, not one glide.
    ghosts.forEach((g, i) => {
      const startDelay = i * SPREAD_STAGGER_MS;
      setTimeout(() => {
        g.wrapper.style.transition = `translate ${DEAL_TRAVEL_MS}ms var(--ease-out-smooth)`;
        g.wrapper.style.translate = `${g.destRect.left - g.stackOrigin.left}px ${g.destRect.top - g.stackOrigin.top}px`;
      }, startDelay);

      setTimeout(() => {
        g.wrapper.remove();
        g.el.style.visibility = '';
        if (onCardRevealed) onCardRevealed(g.card, g.destRect);
      }, startDelay + DEAL_TRAVEL_MS + 30);
    });
  }

  // Which tableau card, if any, is about to be exposed by moving `stack`
  // off of `sourceIndex` - read-only, mirrors flipNewTopIfNeeded's own
  // logic (game-logic.js) without mutating anything, so it can be called
  // *before* applyMove to know what to hold face-down for the reveal.
  function peekCardToFlip(source, sourceIndex, stack) {
    if (source !== 'tableau') return null;
    const col = state.tableau[sourceIndex];
    const idx = col.findIndex(c => c.id === stack[0].id);
    const newTop = col[idx - 1];
    return (newTop && !newTop.faceUp) ? newTop : null;
  }

  // Holds a newly-exposed tableau card face-down for a beat, then turns
  // it with the same 3D flip used for dealing from the stock - reused
  // as-is, just with no travel (the wrapper never gets a translate, so
  // it stays put at the real card's own position).
  function animateTableauFlip(card) {
    const el = document.querySelector(`.card[data-id="${card.id}"]`);
    if (!el) return;
    const rect = el.getBoundingClientRect();
    el.style.visibility = 'hidden';

    const { wrapper, inner } = createFlipGhost(card, rect, 900);
    inner.style.transition = `transform ${TABLEAU_FLIP_MS}ms var(--ease-in-out-smooth)`; // overrides .flip-inner's default duration (shared with the deal animation) for just this reveal

    setTimeout(() => {
      inner.classList.add('flipped');
    }, TABLEAU_FLIP_PAUSE_MS);

    setTimeout(() => {
      wrapper.remove();
      el.style.visibility = '';
    }, TABLEAU_FLIP_PAUSE_MS + TABLEAU_FLIP_MS + 30);
  }

  function findWasteCard(id) {
    return state.waste.find(c => String(c.id) === id);
  }

  // A plain, statically-positioned image ghost in the drag layer - no
  // transition of its own. Callers decide whether (and how) it moves.
  function createPositionedGhost(imgSrc, rect, zIndex, fallbackSrc) {
    const wrapper = document.createElement('div');
    wrapper.className = 'gather-ghost';
    wrapper.style.left = `${rect.left}px`;
    wrapper.style.top = `${rect.top}px`;
    wrapper.style.width = `${rect.width}px`;
    wrapper.style.height = `${rect.height}px`;
    wrapper.style.zIndex = zIndex;
    const img = document.createElement('img');
    img.src = imgSrc;
    img.draggable = false;
    if (fallbackSrc) attachImageFallback(img, fallbackSrc);
    wrapper.appendChild(img);
    document.getElementById('drag-layer').appendChild(wrapper);
    return wrapper;
  }

  // Draw 3's draw animation: cards already visible in the waste before this
  // click must not move, slide, fade, or vanish - only the newly drawn
  // cards animate, arriving on top of whatever was already there. render()
  // has already rebuilt #waste to its final state, which means any old
  // card no longer in the visible-3 window is already gone from the real
  // DOM by the time this runs - so this drops in a completely static,
  // untransitioned stand-in at each such card's exact prior on-screen
  // position (never animated, just holding the spot) underneath the
  // incoming cards, then runs the ordinary animateDraw for those. There's
  // no gather/collapse phase at all here, which also means dealing starts
  // the instant the stock is clicked instead of after a pre-gather delay.
  //
  // Each stand-in is removed the instant the card landing on its exact
  // spot is actually revealed (via animateDraw's per-card callback), not
  // once for the whole batch at the end - the three new cards reveal
  // staggered, one at a time, so a single end-of-batch removal would leave
  // a stand-in sitting on top of an already-revealed real card (which has
  // a much lower z-index) for the rest of the batch, reading as that old
  // card "flickering back in" right after the new one had already landed.
  // Matched by final screen position rather than by array/order index, so
  // this stays correct even in the rare case (near the end of the stock)
  // where an old card survives into the new fan instead of being displaced.
  function animateWasteDrawForDrawThree(drawn, stockRect, oldRectsById, onDone, arrivalMs) {
    const stillRealIds = new Set(Array.from(document.querySelectorAll('#waste .card')).map(el => el.dataset.id));

    const standIns = [];
    oldRectsById.forEach((oldRect, id) => {
      if (stillRealIds.has(id)) return; // still genuinely there; nothing to stand in for
      const card = findWasteCard(id);
      if (card) standIns.push({ el: createPositionedGhost(cardImageSrc(card), oldRect, 400, cardPngFallbackSrc(card)), rect: oldRect });
    });

    animateDraw(drawn, stockRect, (card, destRect) => {
      for (let i = standIns.length - 1; i >= 0; i--) {
        if (Math.round(standIns[i].rect.left) === Math.round(destRect.left) && Math.round(standIns[i].rect.top) === Math.round(destRect.top)) {
          standIns[i].el.remove();
          standIns.splice(i, 1);
        }
      }
    });

    setTimeout(() => {
      standIns.forEach(s => s.el.remove()); // safety net - should normally be empty by now
      onDone();
    }, arrivalMs);
  }

  // Fixes the flash where already-visible waste cards would instantly snap
  // to their new fanned position - or vanish outright, if they fall out of
  // renderWaste's "last 3 cards" window - the moment render() rebuilds the
  // waste pile's DOM. Every waste card at the moment of a draw is exactly
  // one of three things: departing (visible before, not after - tucked
  // under the pile), surviving (visible before *and* after, just at a new
  // fan offset - a Draw 1 continuation), or arriving (newly drawn this
  // turn). All three get identified in one pass right after the normal
  // synchronous render() call - state truth never changes, this is a
  // purely cosmetic overlay using the same ghost/hide-the-real-element
  // pattern already used everywhere else in this file. Phase A gathers
  // whatever was already visible into the pile's own squared base
  // position; Phase B lets survivors continue on to their real slot while
  // arrivals get the existing, unmodified animateDraw (flip + one
  // continuous glide from the stock).
  //
  // Draw 3 never actually has survivors (three new cards always fully
  // displace up to three old ones), so it uses the simpler, unanimated
  // stand-in approach above instead - see animateWasteDrawForDrawThree.
  // This gather/settle version remains exactly as it was for Draw 1, which
  // wasn't part of that request.
  function animateWasteDraw(drawn, stockRect, oldRectsById, onDone) {
    const arrivalMs = (drawn.length - 1) * SPREAD_STAGGER_MS + DEAL_TRAVEL_MS + 30;

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      // render() already left the correct final state on screen - nothing
      // was hidden, so there's nothing to animate or clean up.
      onDone();
      return;
    }

    if (getDrawCount() === 3) {
      animateWasteDrawForDrawThree(drawn, stockRect, oldRectsById, onDone, arrivalMs);
      return;
    }

    const wasteBaseRect = document.getElementById('waste').getBoundingClientRect();
    const newWasteEls = Array.from(document.querySelectorAll('#waste .card'));
    const drawnIds = new Set(drawn.map(c => String(c.id)));

    const survivors = newWasteEls
      .filter(el => !drawnIds.has(el.dataset.id) && oldRectsById.has(el.dataset.id))
      .map(el => ({
        el,
        imgSrc: el.querySelector('img').src,
        oldRect: oldRectsById.get(el.dataset.id),
        newRect: el.getBoundingClientRect(),
      }));
    const survivorIds = new Set(survivors.map(s => s.el.dataset.id));

    const departures = [];
    oldRectsById.forEach((oldRect, id) => {
      if (drawnIds.has(id) || survivorIds.has(id)) return;
      const card = findWasteCard(id);
      if (card) departures.push({ card, oldRect });
    });

    if (!survivors.length && !departures.length) {
      // Nothing was visible before this draw (e.g. the very first draw of
      // a fresh deal) - no gather phase needed, this is just a normal deal.
      animateDraw(drawn, stockRect);
      setTimeout(onDone, arrivalMs);
      return;
    }

    survivors.forEach(s => { s.el.style.visibility = 'hidden'; });

    const survivorGhosts = survivors.map((s, i) => createPositionedGhost(s.imgSrc, s.oldRect, 500 + i));
    const departureGhosts = departures.map((d, i) =>
      createPositionedGhost(cardImageSrc(d.card), d.oldRect, 400 + i, cardPngFallbackSrc(d.card))
    );

    // Phase A: gather - everything already visible glides to the pile's
    // own squared position at once. Arrivals don't exist yet at this
    // point - they're still conceptually at the stock.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      survivorGhosts.forEach((wrapper, i) => {
        const s = survivors[i];
        wrapper.style.transition = `translate ${GATHER_MS}ms var(--ease-out-smooth)`;
        wrapper.style.translate = `${wasteBaseRect.left - s.oldRect.left}px ${wasteBaseRect.top - s.oldRect.top}px`;
      });
      departureGhosts.forEach((wrapper, i) => {
        const d = departures[i];
        wrapper.style.transition = `translate ${GATHER_MS}ms var(--ease-out-smooth)`;
        wrapper.style.translate = `${wasteBaseRect.left - d.oldRect.left}px ${wasteBaseRect.top - d.oldRect.top}px`;
      });
    }));

    setTimeout(() => {
      // Departures are tucked under the pile now - nothing more to do.
      departureGhosts.forEach(w => w.remove());

      // Survivors continue on to their real final fanned position, as one
      // group - they were already sitting together a moment ago, no need
      // for a per-card stagger on this short hop.
      survivorGhosts.forEach((wrapper, i) => {
        const s = survivors[i];
        wrapper.style.transition = `translate ${SURVIVOR_SETTLE_MS}ms var(--ease-out-smooth)`;
        wrapper.style.translate = `${s.newRect.left - s.oldRect.left}px ${s.newRect.top - s.oldRect.top}px`;
      });
      setTimeout(() => {
        survivorGhosts.forEach((wrapper, i) => {
          wrapper.remove();
          survivors[i].el.style.visibility = '';
        });
      }, SURVIVOR_SETTLE_MS + 30);

      // Arrivals: the existing, unmodified deal animation.
      animateDraw(drawn, stockRect);

      const settleMs = SURVIVOR_SETTLE_MS + 30;
      setTimeout(onDone, Math.max(arrivalMs, settleMs));
    }, GATHER_MS);
  }

  let isDrawing = false; // guards against a rapid repeated stock tap interrupting or duplicating an in-flight draw transition

  function onStockClick() {
    if (isDrawing || autoFinishRunning) return;
    if (state.stock.length) {
      isDrawing = true;
      const stockRect = document.getElementById('stock').getBoundingClientRect();
      const oldRectsById = new Map(
        Array.from(document.querySelectorAll('#waste .card')).map(el => [el.dataset.id, el.getBoundingClientRect()])
      );
      resetTableauClickMemory();
      clearHint();
      pushHistory();
      const n = Math.min(getDrawCount(), state.stock.length);
      const drawn = [];
      for (let i = 0; i < n; i++) {
        const card = state.stock.pop();
        card.faceUp = true;
        state.waste.push(card);
        drawn.push(card);
      }
      moveCount++;
      updateMoves();
      render();
      animateWasteDraw(drawn, stockRect, oldRectsById, () => { isDrawing = false; });
    } else if (state.waste.length) {
      resetTableauClickMemory();
      clearHint();
      pushHistory();
      while (state.waste.length) {
        const card = state.waste.pop();
        card.faceUp = false;
        state.stock.push(card);
      }
      moveCount++;
      updateMoves();
      render();
    }
  }

  // Mutates state + re-renders immediately, regardless of how long the
  // matching ghost animation takes. Keeping game state synchronous means
  // the next interaction is never blocked waiting on an in-flight
  // animation to finish.
  //
  // recordHistory defaults to true for every normal move. Auto Finish passes
  // false for each card in a run after pushing one history entry itself up
  // front, so the whole run undoes as a single grouped action instead of one
  // entry per card - see startAutoFinish/runAutoFinish.
  // countMove: false lets a caller commit a state change (with its own
  // ghost/glide animation, flip-detection, etc. all still applying
  // normally) without incrementing the move counter - used by the King-
  // cascade feature (see triggerKingCascade) so a multi-column chain
  // reaction still counts as exactly one move overall, with the actual
  // increment happening once, up front, by the caller. updateMoves() still
  // runs regardless, so toolbar state (Undo, Auto Finish availability)
  // stays live at every intermediate step either way.
  function commitMove(cards, source, sourceIndex, target, targetIndex, { recordHistory = true, countMove = true } = {}) {
    resetTableauClickMemory();
    clearHint();
    // A card leaving or landing in the expanded column means whatever's
    // showing there is about to change - never leave a stale expanded
    // layout up over a column whose contents just moved out from under it.
    if (expandedColumnIndex !== null
      && ((source === 'tableau' && sourceIndex === expandedColumnIndex)
        || (target === 'tableau' && targetIndex === expandedColumnIndex))) {
      expandedColumnIndex = null;
    }
    if (recordHistory) pushHistory();
    const cardToFlip = peekCardToFlip(source, sourceIndex, cards);
    applyMove(state, cards, source, sourceIndex, target, targetIndex);
    if (countMove) moveCount++;
    updateMoves();
    render();
    if (cardToFlip) animateTableauFlip(cardToFlip);
  }

  function isValidDropTarget(pileEl, stack, source, sourceIndex) {
    if (!pileEl) return false;
    const target = pileEl.dataset.pile;
    const targetIndex = pileEl.dataset.index !== undefined ? parseInt(pileEl.dataset.index, 10) : null;
    if (target === 'foundation') {
      return stack.length === 1 && canPlaceOnFoundation(state, stack[0], targetIndex);
    }
    if (target === 'tableau') {
      if (source === 'tableau' && sourceIndex === targetIndex) return false;
      // A King never legally lands on a non-empty column under normal rules
      // (see canPlaceOnTableau), so this can only ever add a drop target in
      // situations that were already illegal - never loosens real Klondike
      // legality.
      return canPlaceOnTableau(state, stack[0], targetIndex)
        || isKingColumnSwap(state, stack, source, sourceIndex, targetIndex);
    }
    return false;
  }

  // Predicts where cards not yet in the DOM will land - called before
  // commitMove, so state.tableau[targetIndex] is still the pre-move column.
  // Uses computeTableauTops, the exact function renderTableauCol itself
  // uses, on "the real column plus these incoming cards" - not a
  // lighter-weight approximation - so a drop into an already-compressed
  // column (or one about to become compressed once these cards land)
  // predicts the same position the next render() will actually produce.
  function computeDestRects(target, targetIndex, count) {
    if (target === 'foundation') {
      return [document.getElementById(`foundation-${targetIndex}`).getBoundingClientRect()];
    }
    const colEl = document.getElementById(`tableau-${targetIndex}`);
    const colRect = colEl.getBoundingClientRect();
    const cascadeDown = getCascadeDown();
    const cascadeUp = getCascadeUp();
    const cardHeight = getCardHeight();
    const existingFlags = state.tableau[targetIndex].map(c => c.faceUp);
    const incomingFlags = new Array(count).fill(true); // only face-up sequences are ever dropped
    const availableHeight = getTableauAvailableHeight(colRect.top);
    const tops = computeTableauTops(existingFlags.concat(incomingFlags), availableHeight, cascadeDown, cascadeUp, cardHeight);
    return tops.slice(existingFlags.length).map(top => ({ left: colRect.left, top: colRect.top + top }));
  }

  // Sibling to computeDestRects, for a King-column swap: the incoming
  // column isn't appended onto whatever's already at targetIndex, it
  // *replaces* it outright, and the two columns can carry different
  // face-down counts - so this needs the full incoming faceUpFlags (not
  // just the visible run) to get the face-up run's vertical offsets right.
  // revealCount trims the result to just the entries actually animated
  // (the face-up tail - always the last revealCount entries, since a
  // column's face-down cards are always a contiguous prefix).
  function computeColumnDestRects(fullFaceUpFlags, colIndex, revealCount) {
    const colEl = document.getElementById(`tableau-${colIndex}`);
    const colRect = colEl.getBoundingClientRect();
    const cascadeDown = getCascadeDown();
    const cascadeUp = getCascadeUp();
    const cardHeight = getCardHeight();
    const availableHeight = getTableauAvailableHeight(colRect.top);
    const tops = computeTableauTops(fullFaceUpFlags, availableHeight, cascadeDown, cascadeUp, cardHeight);
    return tops.slice(fullFaceUpFlags.length - revealCount).map(top => ({ left: colRect.left, top: colRect.top + top }));
  }

  // The King-column swap: a board-layout convenience, not a real Klondike
  // move (see isKingColumnSwap in game-logic.js for why it's kept entirely
  // outside getLegalMoves). Reuses the exact ghost/glide pipeline a normal
  // drop uses, run twice - once for the already-in-flight dragged stack,
  // once for a freshly-created ghost of the target column's own cards -
  // so both columns visibly cross-slide into each other's position rather
  // than teleporting. One pushHistory() + one state mutation + one
  // moveCount++ makes the whole swap a single undoable move.
  function commitKingColumnSwap(sourceIndex, targetIndex, stack, ghosts, originRects) {
    const targetCol = state.tableau[targetIndex];
    const targetFaceUpCount = targetCol.filter(c => c.faceUp).length;
    const targetStack = targetCol.slice(targetCol.length - targetFaceUpCount);
    const targetOriginEls = targetStack.map(c => document.querySelector(`.card[data-id="${c.id}"]`)).filter(Boolean);
    const targetOriginRects = targetOriginEls.map(el => el.getBoundingClientRect());
    // No lift here - unlike the dragged stack, nobody physically picked
    // this column up, so it glides flat from the start (glideGhostsTo
    // resets any lift to flat anyway, but there's no reason to apply one
    // just to immediately undo it).
    const targetGhosts = createGhostStack(targetStack, targetOriginRects);
    targetOriginEls.forEach(el => { el.style.visibility = 'hidden'; });

    // Read before mutating - both columns' post-swap contents are exactly
    // each other's current (pre-swap) contents.
    const sourceFullFlags = state.tableau[sourceIndex].map(c => c.faceUp);
    const targetFullFlags = targetCol.map(c => c.faceUp);
    const destForDraggedStack = computeColumnDestRects(sourceFullFlags, targetIndex, stack.length);
    const destForTargetStack = computeColumnDestRects(targetFullFlags, sourceIndex, targetStack.length);

    resetTableauClickMemory();
    clearHint();
    if (expandedColumnIndex === sourceIndex || expandedColumnIndex === targetIndex) {
      expandedColumnIndex = null;
    }
    pushHistory();
    applyKingColumnSwap(state, sourceIndex, targetIndex);
    moveCount++;
    updateMoves();
    render();

    const revealDragged = hideDestElements(stack, 'tableau', targetIndex, null);
    const revealTarget = hideDestElements(targetStack, 'tableau', sourceIndex, null);
    glideGhostsTo(ghosts, originRects, destForDraggedStack, MOVE_GLIDE_MS, revealDragged);
    glideGhostsTo(targetGhosts, targetOriginRects, destForTargetStack, MOVE_GLIDE_MS, revealTarget);
  }

  // A small "acknowledged, but nowhere to go" nudge for a click/tap that
  // can't turn into a move - re-triggerable on repeat clicks (forces a
  // reflow before re-adding the class, since re-adding an already-present
  // class is a no-op and wouldn't restart a CSS animation on its own).
  function bounceCard(card) {
    const el = document.querySelector(`.card[data-id="${card.id}"]`);
    if (!el) return;
    el.classList.remove('touch-bounce');
    void el.offsetWidth;
    el.classList.add('touch-bounce');
  }

  // Click-to-move: a single click on a movable exposed card sends it to its
  // next legal destination (see resolveClickDestination in game-logic.js
  // for the exact priority order). Reuses the same ghost/glide machinery as
  // drag-and-drop so the motion reads identically either way.
  function tryClickMove(card, source, sourceIndex) {
    if (dragCtx) return;
    const stack = getStackFrom(state, source, sourceIndex, card);
    if (!stack.length) { bounceCard(card); return; }
    const lead = stack[0];
    const lastTableauDest = source === 'tableau' && tableauClickMemory && tableauClickMemory.cardId === lead.id
      ? tableauClickMemory.destIndex
      : null;
    const dest = resolveClickDestination(state, lead, source, sourceIndex, stack.length, lastTableauDest);
    if (!dest) { bounceCard(lead); return; }
    executeClickMove(stack, source, sourceIndex, dest.type, dest.index);
  }

  function executeClickMove(stack, source, sourceIndex, target, targetIndex, options) {
    const originEls = stack.map(c => document.querySelector(`.card[data-id="${c.id}"]`)).filter(Boolean);
    if (originEls.length !== stack.length) return; // DOM out of sync with state; bail rather than animate garbage
    const originRects = originEls.map(el => el.getBoundingClientRect());
    originEls.forEach(el => { el.style.visibility = 'hidden'; });

    // No lift, no pause - nobody physically picked this card up, so it
    // glides flat from the instant it's committed.
    const ghosts = createGhostStack(stack, originRects);

    const destRects = computeDestRects(target, targetIndex, stack.length);
    const previousTopCard = target === 'foundation' ? currentFoundationTop(targetIndex) : null;
    // Auto Finish passes its own {duration, moveProfile} for a gentler,
    // less mechanical glide over a long run - see AUTO_FINISH_MOVE_PROFILE
    // and autoFinishGlideDuration(). Every other caller (manual
    // click-to-move, King cascade) passes neither, so both fall back to the
    // values every other glide in the game already uses. Recorded into
    // lastMoveGlideMs *before* commitMove, since checkWin() (called
    // synchronously inside commitMove's render()) reads it to know how long
    // to wait for this exact move's glide before starting the victory
    // pause/celebration.
    const glideMs = options?.duration ?? MOVE_GLIDE_MS;
    lastMoveGlideMs = glideMs;
    commitMove(stack, source, sourceIndex, target, targetIndex, options); // clears tableauClickMemory — re-set below if this continues a cycle
    if (source === 'tableau' && target === 'tableau') {
      tableauClickMemory = { cardId: stack[0].id, destIndex: targetIndex };
    }
    const revealDest = hideDestElements(stack, target, targetIndex, previousTopCard);

    glideGhostsTo(ghosts, originRects, destRects, glideMs, revealDest, undefined, options?.moveProfile);
  }

  // Bottom-of-Settings easter egg (see versionLink): instantly overwrites
  // the board with a legitimately-solved deck and re-renders, so checkWin()
  // - completely unmodified - detects the same "all 52 on foundations" win
  // it always does and runs the real celebration pipeline. This never
  // touches win-detection itself; it only fabricates the state win-detection
  // already knows how to recognize. moveCount/startTime are left alone, so
  // the celebration's stats line still reflects the game actually played.
  function forceWinForTesting() {
    settingsOverlay.classList.add('hidden');
    if (won) {
      // Let an already-finished (or in-progress) celebration reset first,
      // so a repeated click always produces a fresh one instead of a no-op.
      cleanupVictoryCelebration();
      won = false;
    }
    cancelActiveDrag();
    clearGhosts();
    resetTableauClickMemory();
    clearHint();
    expandedColumnIndex = null;
    state.stock = [];
    state.waste = [];
    state.tableau = [[], [], [], [], [], [], []];
    let forcedId = 0;
    state.foundations = SUITS.map(suit => {
      const pile = [];
      for (let rank = 1; rank <= 13; rank++) {
        pile.push({ id: forcedId++, suit: suit.key, color: suit.color, rank, faceUp: true });
      }
      return pile;
    });
    skipNextStatsRecord = true; // this "win" took zero real moves - see the flag's own declaration
    render();
  }

  // Win-detection condition/timing is untouched from before this feature -
  // still exactly `total === 52 && !won`, still flips `won` synchronously
  // inside the same render() the winning move committed. The only change is
  // what happens after: the toolbar locks immediately (closing a real race -
  // see stopAutoFinish's own comment) and the celebration is scheduled
  // rather than shown immediately, since the winning move's own glide is
  // very likely still in flight at this exact instant.
  function checkWin() {
    const total = state.foundations.reduce((a, p) => a + p.length, 0);
    if (total === 52 && !won) {
      won = true;
      const secs = Math.floor((Date.now() - startTime) / 1000);
      // recordWin() lives on the same guarded `!won` branch that already
      // guarantees this whole block runs exactly once per game, no matter
      // how many times render()/checkWin() get called afterward - the same
      // guarantee that already prevents the celebration itself from
      // double-firing, reused here rather than a second ad-hoc guard.
      // forceWinForTesting's fabricated win still gets a preview via the
      // same pure applyWin() the real recordWin() is built on - it just
      // never persists, so the easter egg shows an honest preview of what
      // a real win would look like without inflating real stats.
      const drawModeKey = currentDrawModeKey();
      const statsResult = skipNextStatsRecord
        ? applyWin(getStatsForMode(drawModeKey), secs, moveCount)
        : recordWin(drawModeKey, secs, moveCount);
      skipNextStatsRecord = false;
      pendingWinResult = { moveCount, secs, statsResult };
      setAutoFinishControlsDisabled(true);

      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const personality = generateVictoryPersonality(reducedMotion);
      // lastMoveGlideMs + 30 matches glideGhostsTo's own ghost-removal buffer
      // for *this exact move's* actual duration - the winning move's card
      // must have visually landed before the celebration captures any
      // positions or hides any real card. Reading the tracked duration
      // rather than assuming MOVE_GLIDE_MS matters now that Auto Finish's
      // final, accelerating cards can glide faster than that default.
      const glideSettleMs = lastMoveGlideMs + 30;
      celebrationTimer = setTimeout(() => runVictoryCelebrationSequence(personality), glideSettleMs + personality.pauseMs);
    }
  }

  // ---------- victory celebration ----------
  //
  // Purely visual, and strictly downstream of checkWin() already having
  // decided the game is won - nothing here ever mutates `state`, `history`,
  // or calls anything from game-logic.js. All 52 cards are read once from
  // state.foundations (already correct, per the real rules) to build
  // temporary clone elements; the real board is only ever hidden, never
  // touched. victory.js owns all the randomness/decision-making (personality
  // + per-card behavior plans); everything below just turns that into real
  // pixels, elements, and Web Animations API calls.

  function runVictoryCelebrationSequence(personality) {
    celebrationTimer = null;
    if (!won) return; // defense in depth - nothing today can reach this while won, but cheap insurance against a future path
    if (personality.reducedMotion) {
      showVictoryMessage(personality.messageEntrance);
    } else {
      createVictoryCelebration(personality);
    }
  }

  // translate/rotate/scale composed into one `transform` string per
  // keyframe - rotationAxis 'xy' splits the turn across rotateX/rotateY for
  // a tumbling look; 'x'/'y' alone need the wrapper's perspective (see
  // .celebration-card--3d) to actually read as 3D rather than a squish.
  function buildCelebrationTransform({ dx, dy, rotDeg, axis, scale }) {
    let rotationPart;
    if (axis === 'x') rotationPart = `rotateX(${rotDeg}deg)`;
    else if (axis === 'y') rotationPart = `rotateY(${rotDeg}deg)`;
    else if (axis === 'xy') rotationPart = `rotateX(${rotDeg * 0.6}deg) rotateY(${rotDeg * 0.6}deg)`;
    else rotationPart = `rotate(${rotDeg}deg)`;
    return `translate(${dx}px, ${dy}px) ${rotationPart} scale(${scale})`;
  }

  // One WAAPI keyframe object. opacity/offset are only included when given,
  // so behaviors that never fade (most of them - once a card is off-viewport
  // it's already invisible) don't carry a pointless constant-1 opacity track.
  function kf(dx, dy, rotDeg, axis, scale, opacity, offset) {
    const entry = { transform: buildCelebrationTransform({ dx, dy, rotDeg, axis, scale }) };
    if (opacity !== undefined) entry.opacity = opacity;
    if (offset !== undefined) entry.offset = offset;
    return entry;
  }

  // ---------- per-behavior keyframe generators ----------
  //
  // Each of these owns its own motion grammar - not just different distance/
  // rotation magnitudes layered on one shared translate+rotate+fade formula.
  // animateCelebrationCard (below) just picks the right one and hands it the
  // already-computed pixel geometry; nothing here is a special case bolted
  // onto a shared path; every behavior is its own function, so the "how many
  // genuinely distinct things can happen" question is answered by how many
  // functions exist here, not by how many parameter combinations there are.

  // Nearly no horizontal movement; nearly all the vertical distance is
  // covered in the back half of the duration (a real ease-in-like weight,
  // expressed as keyframe placement, not just a CSS easing string);
  // rotation grows with it rather than starting at speed.
  function createFallKeyframes(plan, viewport) {
    const dyEnd = viewport.height * (0.85 + plan.distanceFactor * 0.6);
    const dxEnd = viewport.width * 0.05 * plan.signA * plan.secondaryFactor;
    const rotEnd = plan.rotationTurns * 360;
    return [
      kf(0, 0, 0, 'z', 1, undefined, 0),
      kf(dxEnd * 0.12, dyEnd * 0.1, rotEnd * 0.06, 'z', 1, undefined, 0.4),
      kf(dxEnd * 0.4, dyEnd * 0.45, rotEnd * 0.35, 'z', 1, undefined, 0.7),
      kf(dxEnd, dyEnd, rotEnd, 'z', 1, undefined, 1),
    ];
  }

  // Strong lateral travel, almost flat (tiny vertical drop), fast constant
  // spin - a genuinely different shape from FALL: mostly linear/decelerating
  // rather than accelerating, like something thrown that's losing momentum
  // to air resistance rather than gaining it to gravity.
  function createFrisbeeKeyframes(plan, viewport) {
    const dxEnd = viewport.width * (1.0 + plan.distanceFactor) * plan.signA;
    const dyEnd = viewport.height * 0.1 * plan.secondaryFactor;
    const rotEnd = plan.rotationTurns * 360 * 1.3;
    return [
      kf(0, 0, 0, 'z', 1, undefined, 0),
      kf(dxEnd * 0.55, dyEnd * 0.4, rotEnd * 0.5, 'z', 1, undefined, 0.45),
      kf(dxEnd, dyEnd, rotEnd, 'z', 1, undefined, 1),
    ];
  }

  // Explosive: most of the distance is covered in the FRONT of the
  // duration (front-loaded keyframes), minimal rotation ("mostly straight
  // trajectory"), short overall duration already comes from
  // BEHAVIOR_PROFILES.LAUNCH's own low duration range - "shoots violently
  // offscreen almost immediately." TOSS below is the slower, arcing
  // cousin this used to double as (via an arcLaunch flag) - now its own
  // behavior with its own duration range, so LAUNCH itself can stay fast.
  function createLaunchKeyframes(plan, viewport) {
    const rad = (plan.exitAngleDeg ?? 270) * Math.PI / 180;
    const dist = viewport.diagonal * (1.1 + plan.distanceFactor);
    const dxEnd = Math.cos(rad) * dist;
    const dyEnd = Math.sin(rad) * dist;
    const rotEnd = plan.rotationTurns * 360 * 0.35;
    return [
      kf(0, 0, 0, 'z', 1, undefined, 0),
      kf(dxEnd * 0.72, dyEnd * 0.72, rotEnd * 0.6, 'z', 1, undefined, 0.28),
      kf(dxEnd, dyEnd, rotEnd, 'z', 1, undefined, 1),
    ];
  }

  // TOSS: a real up-then-over-then-down parabola - a peak keyframe well
  // above the final resting dy, reached early, followed by the ballistic
  // fall to dxEnd/dyEnd. Powers fountain mode; genuinely longer-lived than
  // LAUNCH (see BEHAVIOR_PROFILES.TOSS), not just a slower version of it.
  function createTossKeyframes(plan, viewport) {
    const rad = (plan.exitAngleDeg ?? 270) * Math.PI / 180;
    const dist = viewport.diagonal * (1.1 + plan.distanceFactor);
    const dxEnd = Math.cos(rad) * dist;
    const dyEnd = Math.sin(rad) * dist;
    const rotEnd = plan.rotationTurns * 360 * 0.5;
    const peakDy = -viewport.height * (0.55 + plan.distanceFactor * 0.35);
    const peakDx = dxEnd * 0.3;
    return [
      kf(0, 0, 0, 'z', 1, undefined, 0),
      kf(peakDx, peakDy, rotEnd * 0.3, 'z', 1, undefined, 0.4),
      kf(dxEnd * 0.7, peakDy * 0.15, rotEnd * 0.7, 'z', 1, undefined, 0.75),
      kf(dxEnd, dyEnd, rotEnd, 'z', 1, undefined, 1),
    ];
  }

  // Slow, steady (linear) downward drift with a very fast continuous spin
  // and an actual side-to-side wander - alternating sign on the x offset at
  // each waypoint, not a single diagonal line.
  function createHelicopterKeyframes(plan, viewport) {
    const dyEnd = viewport.height * (0.75 + plan.distanceFactor * 0.5);
    const wander = viewport.width * 0.06 * (0.4 + plan.secondaryFactor);
    const rotEnd = plan.rotationTurns * 360 * 1.6;
    return [
      kf(0, 0, 0, 'z', 1, undefined, 0),
      kf(wander * plan.signA, dyEnd * 0.3, rotEnd * 0.3, 'z', 1, undefined, 0.3),
      kf(-wander * plan.signA, dyEnd * 0.62, rotEnd * 0.62, 'z', 1, undefined, 0.62),
      kf(wander * plan.signA * 0.5, dyEnd, rotEnd, 'z', 1, undefined, 1),
    ];
  }

  // Very little travel; scale grows large ("fills a large part of the
  // screen"); stays fully opaque until late, then vanishes fast - reads as
  // flying toward the viewer, not away from the board.
  function createPopKeyframes(plan, viewport) {
    const jitter = viewport.width * 0.015 * plan.secondaryFactor;
    return [
      kf(0, 0, 0, 'z', 1, 1, 0),
      kf(jitter * plan.signA, jitter * plan.signB, 0, 'z', plan.scaleTarget * 0.6, 1, 0.6),
      kf(jitter * plan.signA * 1.3, jitter * plan.signB * 1.3, 0, 'z', plan.scaleTarget, 1, 0.85),
      kf(jitter * plan.signA * 1.3, jitter * plan.signB * 1.3, 0, 'z', plan.scaleTarget, 0, 1),
    ];
  }

  // Stays exactly where it started (dx/dy always 0, per spec: "does NOT fly
  // offscreen") and collapses toward nothing, with a small spin flourish as
  // it goes - the opposite silhouette from POP despite both being
  // "in-place" behaviors.
  function createShrinkKeyframes(plan) {
    const rotEnd = plan.rotationTurns * 180;
    return [
      kf(0, 0, 0, 'z', 1, 1, 0),
      kf(0, 0, rotEnd * 0.5, 'z', 0.45, 1, 0.55),
      kf(0, 0, rotEnd, 'z', 0, 0, 1),
    ];
  }

  // Dominated by 3D rotation at a steady (linear) cadence, so it reads as a
  // repeated flip-flip-flip rather than one spin; translation is real but
  // secondary - noticeably less distance than FALL/LAUNCH/FRISBEE.
  function createFlipKeyframes(plan, viewport) {
    const rad = (plan.exitAngleDeg ?? 90) * Math.PI / 180;
    const dist = viewport.diagonal * (0.35 + plan.distanceFactor * 0.35);
    const dxEnd = Math.cos(rad) * dist;
    const dyEnd = Math.sin(rad) * dist;
    const rotEnd = plan.rotationTurns * 360 * 1.5;
    const axis = plan.rotationAxis === 'y' ? 'y' : 'x';
    return [
      kf(0, 0, 0, axis, 1, undefined, 0),
      kf(dxEnd * 0.33, dyEnd * 0.33, rotEnd * 0.33, axis, 1, undefined, 0.33),
      kf(dxEnd * 0.66, dyEnd * 0.66, rotEnd * 0.66, axis, 1, undefined, 0.66),
      kf(dxEnd, dyEnd, rotEnd, axis, 1, undefined, 1),
    ];
  }

  // Combined X/Y 3D rotation on an irregular (not straight) path - each
  // waypoint gets its own small lateral nudge, so the trajectory itself
  // wobbles rather than just spinning while traveling in a line. Distinct
  // from FLIP by using both axes together (a genuine tumble, not a flat
  // flip) and from HELICOPTER by being 3D rather than a flat Z-spin.
  function createTumbleKeyframes(plan, viewport) {
    const rad = (plan.exitAngleDeg ?? 90) * Math.PI / 180;
    const dist = viewport.diagonal * (0.8 + plan.distanceFactor);
    const dxEnd = Math.cos(rad) * dist;
    const dyEnd = Math.sin(rad) * dist;
    const rotEnd = plan.rotationTurns * 360 * 1.3;
    const wob = viewport.width * 0.045 * (0.4 + plan.secondaryFactor);
    return [
      kf(0, 0, 0, 'xy', 1, undefined, 0),
      kf(dxEnd * 0.22 + wob * plan.signA, dyEnd * 0.18 - wob * plan.signB * 0.5, rotEnd * 0.25, 'xy', 1, undefined, 0.22),
      kf(dxEnd * 0.5 - wob * plan.signA * 0.7, dyEnd * 0.48 + wob * plan.signB, rotEnd * 0.55, 'xy', 1, undefined, 0.5),
      kf(dxEnd * 0.78 + wob * plan.signA * 0.4, dyEnd * 0.78 - wob * plan.signB * 0.3, rotEnd * 0.82, 'xy', 1, undefined, 0.78),
      kf(dxEnd, dyEnd, rotEnd, 'xy', 1, undefined, 1),
    ];
  }

  // A real multi-turn parametric spiral: as t goes 0->1, the card sweeps
  // 1.5-4 full turns around the direct line toward its target while the
  // sweep's own radius shrinks to 0 right as it arrives - several visible
  // turns, not a straight path with one bowed midpoint.
  function createSpiralKeyframes(plan, viewport, startRect, focalPoint) {
    const cx = startRect.left + startRect.width / 2;
    const cy = startRect.top + startRect.height / 2;
    let targetX, targetY;
    if (focalPoint) {
      targetX = focalPoint.xFrac * viewport.width;
      targetY = focalPoint.yFrac * viewport.height;
    } else {
      const rad = (plan.exitAngleDeg ?? 0) * Math.PI / 180;
      targetX = cx + Math.cos(rad) * viewport.diagonal * plan.distanceFactor;
      targetY = cy + Math.sin(rad) * viewport.diagonal * plan.distanceFactor;
    }
    const baseDx = targetX - cx;
    const baseDy = targetY - cy;
    const totalTurns = 1.5 + plan.secondaryFactor * 2.5;
    const ampBase = Math.max(50, Math.hypot(baseDx, baseDy) * 0.32);
    const rotEnd = plan.rotationTurns * 360;
    const steps = 10;
    const keyframes = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const theta = t * totalTurns * 2 * Math.PI;
      const amp = ampBase * (1 - t);
      const perpX = -Math.sin(theta) * amp;
      const perpY = Math.cos(theta) * amp;
      const scale = 1 - (1 - plan.scaleTarget) * t;
      const opacity = t < 0.8 ? 1 : 1 - (t - 0.8) / 0.2;
      keyframes.push(kf(baseDx * t + perpX, baseDy * t + perpY, rotEnd * t, 'z', scale, opacity, t));
    }
    return keyframes;
  }

  // Initially almost motionless (most of the DURATION covers only a sliver
  // of the DISTANCE), then a dramatic accelerating rush over the final
  // fraction, converging with the other VACUUM cards on the same focal
  // point while shrinking in step - what makes a Black Hole win read as
  // "everything getting sucked into one spot," not "cards flying off in
  // random directions that happen to share a target."
  function createVacuumKeyframes(plan, viewport, startRect, focalPoint) {
    const cx = startRect.left + startRect.width / 2;
    const cy = startRect.top + startRect.height / 2;
    const targetX = focalPoint ? focalPoint.xFrac * viewport.width : viewport.width / 2;
    const targetY = focalPoint ? focalPoint.yFrac * viewport.height : viewport.height / 2;
    const dxEnd = (targetX - cx) * plan.distanceFactor;
    const dyEnd = (targetY - cy) * plan.distanceFactor;
    const rotEnd = plan.rotationTurns * 360;
    return [
      kf(0, 0, 0, 'z', 1, 1, 0),
      kf(dxEnd * 0.05, dyEnd * 0.05, rotEnd * 0.08, 'z', 0.94, 1, 0.55),
      kf(dxEnd * 0.3, dyEnd * 0.3, rotEnd * 0.35, 'z', 0.6, 1, 0.8),
      kf(dxEnd, dyEnd, rotEnd, 'z', plan.scaleTarget, 0, 1),
    ];
  }

  // The calm counterpart to FRISBEE: a steady, low-energy glide in one
  // consistent direction with only a slight, constant tilt (never a spin)
  // and no scale change - keyframes are evenly spaced (no front/back-loaded
  // easing baked into their placement) so the motion itself reads as
  // constant-speed sliding, not acceleration or deceleration. Powers
  // tableTip ("someone tipped the table") and shows up as gravity's rare
  // calm rebel too.
  function createSlideKeyframes(plan, viewport) {
    const rad = (plan.exitAngleDeg ?? 90) * Math.PI / 180;
    const dist = viewport.diagonal * (0.9 + plan.distanceFactor * 0.55);
    const dxEnd = Math.cos(rad) * dist;
    const dyEnd = Math.sin(rad) * dist;
    const rotEnd = plan.rotationTurns * 360;
    return [
      kf(0, 0, 0, 'z', 1, undefined, 0),
      kf(dxEnd * 0.35, dyEnd * 0.35, rotEnd * 0.4, 'z', 1, undefined, 0.35),
      kf(dxEnd * 0.7, dyEnd * 0.7, rotEnd * 0.75, 'z', 1, undefined, 0.7),
      kf(dxEnd, dyEnd, rotEnd, 'z', 1, undefined, 1),
    ];
  }

  // Lazy, near-weightless wander - the longest-lived behavior by design
  // ("5-8 seconds" per BEHAVIOR_PROFILES.DRIFT). Barely any rotation
  // (a real float doesn't tumble); a gentle multi-point meander rather
  // than a straight line, ending in a fade since a genuinely lazy drift
  // may not travel far enough to clear the viewport on its own.
  function createDriftKeyframes(plan, viewport) {
    const netDx = viewport.width * 0.5 * plan.distanceFactor * plan.signA;
    const netDy = viewport.height * (0.4 + plan.distanceFactor * 0.5);
    const wander = viewport.width * 0.08 * (0.5 + plan.secondaryFactor);
    const rotEnd = plan.rotationTurns * 90;
    return [
      kf(0, 0, 0, 'z', 1, 1, 0),
      kf(wander * plan.signB, netDy * 0.2, rotEnd * 0.2, 'z', 1, 1, 0.25),
      kf(-wander * plan.signB * 0.7, netDy * 0.45, rotEnd * 0.45, 'z', 1, 1, 0.5),
      kf(wander * plan.signB * 0.5, netDy * 0.75, rotEnd * 0.75, 'z', 1, 1, 0.8),
      kf(netDx, netDy, rotEnd, 'z', 1, 0, 1),
    ];
  }

  // Falls, hits an implied floor, bounces back up part of the way, falls
  // again, continues off the bottom - a genuine non-monotonic down/up/down
  // silhouette (WAAPI keyframes are just timed snapshots, not a physics
  // engine, so nothing stops dy from going down-up-down across the
  // sequence), not a single monotonic fall like FALL/TUMBLE.
  function createBounceKeyframes(plan, viewport) {
    const dxEnd = viewport.width * 0.18 * plan.distanceFactor * plan.signA;
    const floorDy = viewport.height * (0.78 + plan.distanceFactor * 0.15);
    const bounceUpDy = floorDy * 0.72;
    const finalDy = viewport.height * (1.15 + plan.distanceFactor * 0.4);
    const rotEnd = plan.rotationTurns * 360 * 0.6;
    return [
      kf(0, 0, 0, 'z', 1, undefined, 0),
      kf(dxEnd * 0.3, floorDy, rotEnd * 0.35, 'z', 1, undefined, 0.42),
      kf(dxEnd * 0.55, bounceUpDy, rotEnd * 0.55, 'z', 1, undefined, 0.62),
      kf(dxEnd * 0.8, floorDy * 1.05, rotEnd * 0.8, 'z', 1, undefined, 0.8),
      kf(dxEnd, finalDy, rotEnd, 'z', 1, undefined, 1),
    ];
  }

  // Paper-like: an irregular side-to-side ROCK on the way down, not a
  // continuous spin - rotation is expressed directly in degrees of sway
  // (alternating sign each waypoint) rather than accumulating turns, so it
  // reads as tipping back and forth rather than spinning while falling.
  // plan.rotationTurns only scales the rock's amplitude here.
  function createFlutterKeyframes(plan, viewport) {
    const dyEnd = viewport.height * (0.85 + plan.distanceFactor * 0.5);
    const sway = viewport.width * 0.12 * (0.6 + plan.secondaryFactor);
    const rock = (10 + Math.abs(plan.rotationTurns) * 40) * plan.signB;
    return [
      kf(0, 0, 0, 'z', 1, undefined, 0),
      kf(sway * plan.signA, dyEnd * 0.18, rock, 'z', 1, undefined, 0.15),
      kf(-sway * plan.signA * 0.8, dyEnd * 0.38, -rock, 'z', 1, undefined, 0.35),
      kf(sway * plan.signA * 0.9, dyEnd * 0.58, rock * 0.9, 'z', 1, undefined, 0.55),
      kf(-sway * plan.signA * 0.6, dyEnd * 0.8, -rock * 0.8, 'z', 1, undefined, 0.78),
      kf(sway * plan.signA * 0.3, dyEnd, rock * 0.5, 'z', 1, undefined, 1),
    ];
  }

  const CELEBRATION_KEYFRAME_GENERATORS = {
    FALL: createFallKeyframes,
    FRISBEE: createFrisbeeKeyframes,
    LAUNCH: createLaunchKeyframes,
    HELICOPTER: createHelicopterKeyframes,
    POP: createPopKeyframes,
    SHRINK: createShrinkKeyframes,
    FLIP: createFlipKeyframes,
    TUMBLE: createTumbleKeyframes,
    SPIRAL: createSpiralKeyframes,
    VACUUM: createVacuumKeyframes,
    SLIDE: createSlideKeyframes,
    TOSS: createTossKeyframes,
    DRIFT: createDriftKeyframes,
    BOUNCE: createBounceKeyframes,
    FLUTTER: createFlutterKeyframes,
  };

  // The only place a card plan's normalized (angle/distance-factor/turns)
  // values become real pixels - viewport is captured once by the caller,
  // never re-read mid-animation. Only transform/opacity are ever animated
  // (no top/left/width), and only via the Web Animations API - several
  // behaviors (SPIRAL's real multi-turn curve, VACUUM's time-weighted
  // convergence) need genuine multi-keyframe paths a plain CSS transition
  // can't express; everything still stays GPU-compositable, same cost class
  // as the rest of the app's transition-based glides.
  // Tracks the returned Animation in activeCelebrationAnimations (so
  // cleanupVictoryCelebration can cancel it immediately, whenever it's
  // called) and removes this card's own wrapper element the moment ITS
  // animation naturally finishes - no coordinated "celebration over" event,
  // every card just cleans up after itself on its own clock. If the
  // animation is cancelled instead (cleanup ran first), .finished rejects
  // and this is a no-op - cleanup already handles the DOM/array teardown
  // in that case.
  function animateCelebrationCard(el, plan, viewport, startRect, focalPoint) {
    const generator = CELEBRATION_KEYFRAME_GENERATORS[plan.behavior];
    const keyframes = generator(plan, viewport, startRect, focalPoint);
    const animation = el.animate(keyframes, { duration: plan.durationMs, delay: plan.delayMs, easing: plan.easing, fill: 'forwards' });
    activeCelebrationAnimations.push(animation);
    animation.finished
      .then(() => {
        activeCelebrationAnimations = activeCelebrationAnimations.filter(a => a !== animation);
        el.parentElement?.remove(); // the wrapper (.celebration-card) - el itself is the inner card
      })
      .catch(() => {});
  }

  // Captures each foundation pile's REAL top card geometry (not the pile
  // container's - its own border inset means the two rects don't match,
  // which is exactly what made the old clone appear to jump) and builds
  // every clone from that single source of truth: the top card (depthFromTop
  // 0) gets zero offset, so it lands pixel-for-pixel where the real card
  // was; cards further down the pile (never individually rendered - only
  // the top card of a foundation ever has a real DOM element) get a small
  // offset scaled by *how far they are from the top*, for a "thick deck"
  // look without displacing the one card that's actually visible.
  //
  // Two-frame handoff: clones are built and positioned while the real top
  // cards are STILL visible; only after that's had a chance to paint
  // (double rAF) do the real cards hide and the animations actually start -
  // there's never a frame where the swap itself is visible.
  function createVictoryCelebration(personality) {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    viewport.diagonal = Math.hypot(viewport.width, viewport.height);

    const plans = assignCardBehaviors(state.foundations, personality);
    const plansById = new Map(plans.map(p => [p.cardId, p]));

    celebrationLayer.innerHTML = ''; // defensive - should already be empty

    const realTopEls = [];
    const built = [];

    state.foundations.forEach((pile) => {
      if (!pile.length) return;
      const topCard = pile[pile.length - 1];
      const topEl = document.querySelector(`.card[data-id="${topCard.id}"]`);
      if (!topEl) return;
      const topRect = topEl.getBoundingClientRect(); // the real, single source of truth for this pile's position
      realTopEls.push(topEl);

      pile.forEach((card) => {
        const plan = plansById.get(card.id);
        if (!plan) return;

        const offsetPx = Math.min(plan.depthFromTop, 8) * 0.6;
        const startRect = {
          left: topRect.left - offsetPx,
          top: topRect.top + offsetPx,
          width: topRect.width,
          height: topRect.height,
        };

        const wrapper = document.createElement('div');
        wrapper.className = plan.needsPerspective ? 'celebration-card celebration-card--3d' : 'celebration-card';
        wrapper.style.left = `${startRect.left}px`;
        wrapper.style.top = `${startRect.top}px`;
        wrapper.style.width = `${startRect.width}px`;
        wrapper.style.height = `${startRect.height}px`;
        wrapper.style.zIndex = String(1000 + plan.stackOffsetIndex); // higher = shallower = painted in front, matching a real stack

        const inner = makeCardEl(card, true);
        inner.classList.add('celebration-card-inner');
        wrapper.appendChild(inner);
        celebrationLayer.appendChild(wrapper);

        built.push({ plan, el: inner, startRect });
      });
    });

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        realTopEls.forEach(el => { el.style.visibility = 'hidden'; });
        built.forEach(({ plan, el, startRect }) => {
          animateCelebrationCard(el, plan, viewport, startRect, personality.focalPoint);
        });
      });
    });

    // Fixed, short delay from right here (celebration start) - deliberately
    // NOT derived from plans' own delay/duration in any way. The cards are
    // the celebration, not an intro gating the message; whatever's still
    // mid-flight (most of the deck, typically, given BEHAVIOR_PROFILES'
    // multi-second durations) just keeps going undisturbed behind/around
    // the message - see showVictoryMessage's own comment for why it never
    // touches celebrationLayer.
    celebrationTimer = setTimeout(() => showVictoryMessage(personality.messageEntrance), MESSAGE_DELAY_AFTER_CELEBRATION_START_MS);
  }

  // Reveals the on-felt win message: no modal, just the headline/button/
  // stats appearing on top of the STILL-RUNNING card celebration (deliberately
  // - see createVictoryCelebration's own comment on why this is scheduled
  // early rather than after the cards finish). Never touches
  // celebrationLayer - #win-message (z-index 2000) already renders above
  // #celebration-layer (z-index 1100) with no background of its own, so the
  // cards stay fully visible behind/around the text without any extra work
  // here. pendingWinResult carries the exact moveCount/elapsed-time snapshot
  // from the instant checkWin() fired, so the displayed stats can never
  // drift from what was true at the winning move itself.
  // Renders one record row: an ordinary "Fastest: 2:11"-style readout, or -
  // if this specific win just broke that specific record - a trophy line
  // instead. Never both for the same record. formattedRecordValue is
  // already-formatted text (formatTime()'s output, or a plain move count).
  function renderRecordRow(el, isNewRecord, trophyText, ordinaryLabel, formattedRecordValue) {
    el.textContent = isNewRecord ? trophyText : `${ordinaryLabel}: ${formattedRecordValue}`;
    el.classList.toggle('win-record-trophy', isNewRecord);
  }

  function showVictoryMessage(entrance) {
    winEmoji.textContent = pickHeadline();
    const result = pendingWinResult || { moveCount, secs: 0, statsResult: null };
    winResultLine.textContent = `${formatTime(result.secs)} · ${result.moveCount} moves`;

    const stats = result.statsResult;
    if (stats) {
      winHeadline.textContent = `WIN #${stats.winNumber}`;
      winPlaysLine.textContent = `${stats.stats.plays} Plays`;
      // Win #1 has nothing yet to compare against - this game's own result
      // IS the new baseline, so showing it again as a "record" line right
      // below the result line would just be a redundant echo.
      const showRecords = stats.winNumber > 1;
      winRecords.classList.toggle('hidden', !showRecords);
      if (showRecords) {
        renderRecordRow(winRecordTime, stats.isNewFastest, '🏆 NEW FASTEST TIME', 'Fastest', formatTime(stats.stats.fastestTimeSeconds));
        renderRecordRow(winRecordMoves, stats.isNewFewestMoves, '🏆 NEW FEWEST MOVES', 'Fewest moves', stats.stats.fewestMoves);
      }
    } else {
      // Defensive fallback only - checkWin() always produces a statsResult
      // (a real recordWin() or, for the forceWinForTesting preview path, an
      // unsaved applyWin()); this just keeps the screen sane if it's ever
      // reached some other way.
      winHeadline.textContent = '';
      winPlaysLine.textContent = '';
      winRecords.classList.add('hidden');
    }

    winMessage.className = `win-enter-${entrance}`; // replaces "hidden" outright - single source of truth for this element's visual state
  }

  // The single authoritative teardown path - the only place anything
  // celebration-related actually gets cancelled/removed. Idempotent,
  // DOM/timer/animation-only - never touches button/toolbar state (that's
  // newGame/restart/undo's job, since the toolbar should stay locked
  // through the whole won state, not just the celebration's own duration -
  // see checkWin). Safe to call even when nothing is showing. Called at the
  // top of newGame()/restart()/undo() so every path back into a live game
  // tears any in-progress or already-finished celebration down cleanly and
  // *immediately* - deliberately not waiting for anything to finish first,
  // since cards can now genuinely still be mid-flight (up to ~8s in) when
  // this runs. Cancelling every tracked Animation (rather than just
  // clearing the DOM out from under them) is what guarantees no orphaned
  // callback from THIS run's cards can fire during the next game -
  // animateCelebrationCard's own .finished handler treats a cancelled
  // animation as a no-op (see its .catch there).
  function cleanupVictoryCelebration() {
    if (celebrationTimer) {
      clearTimeout(celebrationTimer);
      celebrationTimer = null;
    }
    activeCelebrationAnimations.forEach(animation => animation.cancel());
    activeCelebrationAnimations = [];
    celebrationLayer.innerHTML = '';
    winMessage.className = 'hidden';
    document.querySelectorAll('#foundations .card').forEach(el => { el.style.visibility = ''; });
  }

  // ---------- dragging ----------

  let dragCtx = null;

  // Click-to-move is driven entirely by the pointer lifecycle below (see
  // onDragEnd's "not moved" branch) rather than a separate native `click`
  // listener. A native click after a preventDefault()-ed pointerdown is
  // reliable on desktop, but that exact sequence is a known source of
  // cross-browser/touch inconsistency — deriving "was this a tap" from our
  // own pointerdown/pointerup pair sidesteps it entirely and behaves
  // identically for mouse, trackpad, and touch.
  function attachCardInteractions(cardEl, card, source, sourceIndex) {
    cardEl.addEventListener('pointerdown', (e) => startDrag(e, card, source, sourceIndex), { passive: false });
  }

  function createGhostStack(cards, rects) {
    const dragLayer = document.getElementById('drag-layer');
    const wrappers = [];
    const visuals = [];
    cards.forEach((c, i) => {
      const rect = rects[i];
      const wrapper = document.createElement('div');
      wrapper.className = 'drag-ghost';
      wrapper.style.left = `${rect.left}px`;
      wrapper.style.top = `${rect.top}px`;
      wrapper.style.width = `${rect.width}px`;
      wrapper.style.height = `${rect.height}px`;
      wrapper.style.zIndex = 1000 + i;
      const visual = makeCardEl(c, true);
      visual.classList.add('drag-visual');
      wrapper.appendChild(visual);
      dragLayer.appendChild(wrapper);
      wrappers.push(wrapper);
      visuals.push(visual);
    });
    return { wrappers, visuals };
  }

  // Glides ghosts from baseRects to destRects: a clean, flat position
  // slide - the only thing that animates is position. Any lift/scale/tilt a
  // ghost picked up while actively held (see .lifted, and the live
  // velocity-rotation in processDragFrame) settles back to rest *instantly*,
  // before the position glide starts - never eased alongside it, so
  // unlifting can never read as part of the card's travel (an arc, bounce,
  // or grow). A programmatic glide (click-to-move, Auto Finish, King-swap's
  // own un-dragged ghost) was never lifted in the first place, so this
  // reset is a harmless no-op there - one glide implementation for every
  // trigger.
  //
  // moveProfile (Auto Finish only - every other caller omits it and gets
  // the plain CSS-transition path below, unchanged) is an array of
  // {offset, distance} sample points - see AUTO_FINISH_MOVE_PROFILE - used
  // to build real WAAPI keyframes here, multiplying each sample's distance
  // fraction by this specific card's actual pixel delta. A single
  // cubic-bezier transition can't express "gentle release, dominant
  // acceleration, then a short soft landing" - the WAAPI path is the one
  // place that shape is actually assembled from the profile.
  function glideGhostsTo(ghosts, baseRects, destRects, ms, onDone, easing = 'var(--ease-out-smooth)', moveProfile = null) {
    const { wrappers, visuals } = ghosts;
    visuals.forEach(visual => {
      visual.style.transition = 'none';
      visual.classList.remove('lifted');
      visual.style.rotate = '0deg';
      visual.offsetHeight; // commit the instant reset before the transition below can pick it up
      visual.style.transition = '';
    });
    wrappers.forEach((wrapper, i) => {
      const dx = destRects[i].left - baseRects[i].left;
      const dy = destRects[i].top - baseRects[i].top;
      if (moveProfile) {
        wrapper.animate(
          moveProfile.map(p => ({ offset: p.offset, translate: `${dx * p.distance}px ${dy * p.distance}px` })),
          { duration: ms, fill: 'forwards' },
        );
      } else {
        wrapper.style.transition = `translate ${ms}ms ${easing}`;
        wrapper.style.translate = `${dx}px ${dy}px`;
      }
    });
    setTimeout(() => {
      wrappers.forEach(w => w.remove());
      if (onDone) onDone();
    }, ms + 30);
  }

  function currentFoundationTop(targetIndex) {
    const pile = state.foundations[targetIndex];
    return pile.length ? pile[pile.length - 1] : null;
  }

  // commitMove's render() paints the real cards at their destination
  // immediately, before the matching ghost has finished flying there —
  // without this, both are visible at once and it reads as two cards.
  // Hides the just-rendered destination elements; call the returned
  // function once the ghost covering them is gone.
  //
  // A foundation destination needs one thing more: renderFoundation only
  // ever keeps the pile's current top card in the DOM (unlike a tableau
  // column, which still shows every earlier card underneath), so hiding
  // the just-landed card there leaves the whole pile looking like it
  // vanished, not just the newest card. previousTopCard (whatever was on
  // top before this move, or null for an empty pile) gets a static
  // stand-in at that same slot for the same window, so the existing pile
  // stays visible right up until the incoming card actually arrives.
  function hideDestElements(cards, target, targetIndex, previousTopCard) {
    const els = cards.map(c => document.querySelector(`.card[data-id="${c.id}"]`)).filter(Boolean);
    els.forEach(el => { el.style.visibility = 'hidden'; });

    let standIn = null;
    if (target === 'foundation' && previousTopCard) {
      const rect = document.getElementById(`foundation-${targetIndex}`).getBoundingClientRect();
      standIn = createPositionedGhost(cardImageSrc(previousTopCard), rect, 300, cardPngFallbackSrc(previousTopCard));
    }

    return () => {
      if (standIn) standIn.remove();
      els.forEach(el => { el.style.visibility = ''; });
    };
  }

  function clearGhosts() {
    document.getElementById('drag-layer').innerHTML = '';
  }

  function removeDragListeners() {
    window.removeEventListener('pointermove', onDragMove);
    window.removeEventListener('pointerup', onDragEnd);
    window.removeEventListener('pointercancel', onDragCancel);
  }

  function cancelActiveDrag() {
    if (!dragCtx) return;
    removeDragListeners();
    if (dragCtx.hoverTarget) dragCtx.hoverTarget.classList.remove('drop-target-active');
    dragCtx = null;
  }

  // The browser fires this instead of pointerup when it takes the gesture
  // away from us (e.g. iOS deciding — despite touch-action — that this is
  // a system gesture) or the interaction is otherwise interrupted. Without
  // handling it, dragCtx would stay stuck forever and, since startDrag
  // bails out whenever dragCtx is already set, silently break every future
  // tap and drag until a reload.
  function onDragCancel(e) {
    if (dragCtx && dragCtx.pointerId !== e.pointerId) return;
    removeDragListeners();
    if (!dragCtx) return;
    const { ghosts, originEls, hoverTarget, moved, source, sourceIndex } = dragCtx;
    dragCtx = null;
    if (hoverTarget) hoverTarget.classList.remove('drop-target-active');
    ghosts.wrappers.forEach(w => w.remove());
    if (moved) {
      // A foundation's origin element was replaced by the peek-render above,
      // not just hidden - restoring visibility on it would be a no-op, so
      // the real top card needs a proper re-render instead.
      if (source === 'foundation') renderFoundation(sourceIndex);
      else originEls.forEach(el => { el.style.visibility = ''; });
    } // unmoved: origin was never hidden
  }

  function startDrag(e, card, source, sourceIndex) {
    if (dragCtx || autoFinishRunning || kingCascadeHoldPointerId !== null) return;
    if (e.button !== undefined && e.button !== 0) return;
    const stack = getStackFrom(state, source, sourceIndex, card);
    if (!stack.length) return;

    const originContainer = e.currentTarget.parentElement;
    const originEls = stack.map(c => originContainer.querySelector(`[data-id="${c.id}"]`)).filter(Boolean);
    if (!originEls.length) return;

    e.preventDefault();
    const originRects = originEls.map(el => el.getBoundingClientRect());

    const ghosts = createGhostStack(stack, originRects);

    dragCtx = {
      stack, source, sourceIndex, ghosts, originEls, originRects,
      pointerId: e.pointerId,
      startX: e.clientX, startY: e.clientY,
      latestX: e.clientX, latestY: e.clientY,
      lastX: e.clientX, lastT: performance.now(),
      rafPending: false,
      hoverTarget: null,
      moved: false,
    };

    window.addEventListener('pointermove', onDragMove, { passive: false });
    window.addEventListener('pointerup', onDragEnd);
    window.addEventListener('pointercancel', onDragCancel);
  }

  function onDragMove(e) {
    if (!dragCtx || e.pointerId !== dragCtx.pointerId) return;
    // Belt-and-suspenders alongside touch-action: none — keeps Safari from
    // ever starting a page scroll/pan mid-drag.
    e.preventDefault();
    dragCtx.latestX = e.clientX;
    dragCtx.latestY = e.clientY;
    if (!dragCtx.rafPending) {
      dragCtx.rafPending = true;
      requestAnimationFrame(processDragFrame);
    }
  }

  // Coalesces potentially many pointermove events into one update per
  // display frame: position tracking, velocity-based rotation, and
  // drop-target hover detection all happen here, together.
  function processDragFrame() {
    if (!dragCtx) return;
    dragCtx.rafPending = false;
    const { latestX, latestY, startX, startY, ghosts, stack, source, sourceIndex } = dragCtx;

    // A plain tap/click never fires pointermove, so this only runs once
    // real dragging starts — meaning a tap never hides the original card
    // or shows the ghost. The distance gate below additionally absorbs
    // incidental jitter during a tap, so a near-motionless press+release
    // still resolves as a click-move rather than a micro-drag.
    if (!dragCtx.moved) {
      const dist = Math.hypot(latestX - startX, latestY - startY);
      if (dist < DRAG_THRESHOLD_PX) return;
      dragCtx.moved = true;
      dragCtx.originEls.forEach(el => { el.style.visibility = 'hidden'; });
      if (source === 'foundation') renderFoundation(sourceIndex, { peekBehindTop: true });
      ghosts.visuals.forEach(v => v.classList.add('lifted'));
    }

    const dx = latestX - startX;
    const dy = latestY - startY;
    ghosts.wrappers.forEach(w => { w.style.translate = `${dx}px ${dy}px`; });

    const now = performance.now();
    const dt = now - dragCtx.lastT;
    if (dt > 0) {
      const vx = (latestX - dragCtx.lastX) / dt;
      const angle = Math.max(-MAX_ROTATE_DEG, Math.min(MAX_ROTATE_DEG, (vx / ROTATE_VELOCITY_PX_MS) * MAX_ROTATE_DEG));
      ghosts.visuals.forEach(v => { v.style.rotate = `${angle}deg`; });
      dragCtx.lastX = latestX;
      dragCtx.lastT = now;
    }

    const pileEl = pileContainerAt(latestX, latestY);
    const valid = isValidDropTarget(pileEl, stack, source, sourceIndex);
    const newTarget = valid ? pileEl : null;
    if (newTarget !== dragCtx.hoverTarget) {
      if (dragCtx.hoverTarget) dragCtx.hoverTarget.classList.remove('drop-target-active');
      if (newTarget) newTarget.classList.add('drop-target-active');
      dragCtx.hoverTarget = newTarget;
    }
  }

  function pileContainerAt(x, y) {
    const piles = document.querySelectorAll('.pile[data-pile]');
    let best = null;
    piles.forEach(el => {
      const r = el.getBoundingClientRect();
      const extendedBottom = el.classList.contains('column') ? r.bottom + 300 : r.bottom;
      if (x >= r.left && x <= r.right && y >= r.top && y <= extendedBottom) {
        best = el;
      }
    });
    return best;
  }

  function onDragEnd(e) {
    if (dragCtx && dragCtx.pointerId !== e.pointerId) return;
    removeDragListeners();
    if (!dragCtx) return;
    const { stack, source, sourceIndex, ghosts, originRects, originEls, hoverTarget, moved } = dragCtx;
    dragCtx = null;

    if (!moved) {
      // Never crossed the drag threshold: a tap/click, not a drag. The
      // ghost never became visible (still exactly overlapping the
      // untouched original), so just discard it and hand off to
      // click-to-move directly — no native click event involved.
      ghosts.wrappers.forEach(w => w.remove());
      tryClickMove(stack[0], source, sourceIndex);
      return;
    }

    if (hoverTarget) hoverTarget.classList.remove('drop-target-active');
    const pileEl = pileContainerAt(e.clientX, e.clientY);
    const valid = isValidDropTarget(pileEl, stack, source, sourceIndex);

    if (valid) {
      const target = pileEl.dataset.pile;
      const targetIndex = parseInt(pileEl.dataset.index, 10);
      if (target === 'tableau' && isKingColumnSwap(state, stack, source, sourceIndex, targetIndex)) {
        commitKingColumnSwap(sourceIndex, targetIndex, stack, ghosts, originRects);
        return;
      }
      const destRects = computeDestRects(target, targetIndex, stack.length);
      const previousTopCard = target === 'foundation' ? currentFoundationTop(targetIndex) : null;
      lastMoveGlideMs = MOVE_GLIDE_MS; // see its declaration - this drag-drop is the other path (besides executeClickMove) that can complete a win
      commitMove(stack, source, sourceIndex, target, targetIndex);
      const revealDest = hideDestElements(stack, target, targetIndex, previousTopCard);
      glideGhostsTo(ghosts, originRects, destRects, MOVE_GLIDE_MS, revealDest);
    } else {
      // See onDragCancel's comment: a foundation's origin element was
      // replaced by the peek-render, not just hidden, so it needs a real
      // re-render rather than a visibility restore.
      if (source === 'foundation') renderFoundation(sourceIndex);
      else originEls.forEach(el => { el.style.visibility = ''; });
      glideGhostsTo(ghosts, originRects, originRects, MOVE_GLIDE_MS);
    }
  }

  // ---------- settings panel ----------

  function renderPreferenceOptionPreview(option) {
    // Image-backed options (card back, card style) show the actual asset,
    // scaled down by CSS; a future non-image preference (table surface
    // color?) can supply previewColor instead and get a flat swatch -
    // renderSettingsPanel itself never needs to know which kind a given
    // section uses. previewSrc is a function rather than a plain string so
    // it's read lazily here (when the panel actually renders) rather than
    // at PREFERENCE_SECTIONS definition time - this is also the only place
    // in the app that fetches the three unselected card-back colors, and
    // only because the player opened Settings.
    if (option.previewSrc) {
      const img = document.createElement('img');
      img.src = option.previewSrc();
      img.alt = option.label;
      img.draggable = false;
      // A real on-board card gets its background from .card.face-up/
      // .card.face-down (#ded9ca - see those rules' own comments on why),
      // which this preview button isn't. Most card art only needs that for
      // a thin sliver around its own rounded corners, invisible either way,
      // but several Clean-condition face and back designs leave much more
      // of their own background transparent, relying on exactly this fill
      // - true for both sections that use previewSrc today (Cards, Card
      // Back), and any future one that's also real card art.
      img.classList.add('settings-option-card-preview');
      return img;
    }
    // Deal Style's preview: a small fan of N card backs (reusing whichever
    // back color the player has already chosen, so the two preferences
    // stay visually consistent with each other).
    if (option.previewCards) {
      const fan = document.createElement('div');
      fan.className = 'settings-option-fan';
      for (let i = 0; i < option.previewCards; i++) {
        const img = document.createElement('img');
        img.src = getCardBackSrc();
        img.alt = '';
        img.draggable = false;
        img.className = 'settings-option-fan-card';
        // Offset from center rather than raw index, so a single card (Draw
        // 1) lands upright and centered instead of picking up a stray tilt.
        img.style.setProperty('--offset', i - (option.previewCards - 1) / 2);
        fan.appendChild(img);
      }
      return fan;
    }
    const swatch = document.createElement('div');
    swatch.className = 'settings-option-swatch';
    swatch.style.background = option.previewColor;
    return swatch;
  }

  // Every card currently showing face-up on the board - exactly the set
  // render() is about to redraw, and therefore exactly (and only) what
  // needs to be warm in a newly chosen collection to switch Cards with no
  // blank-card flash. Deliberately NOT the full 52-card deck: this game
  // supports more collections over time, and eagerly warming an entire
  // inactive collection on every switch (let alone every session) would
  // scale badly once there are more than two. Covered tableau cards and
  // whatever's left in the stock stay cold in the new collection until
  // something actually reveals them, same as they were cold in the
  // original collection at the start of this session - switching Cards
  // doesn't change that contract, it only means "on demand" now also
  // covers cards that happen to already be face-up.
  function visibleFaceUpCards() {
    const cards = [];
    state.waste.slice(Math.max(0, state.waste.length - 3)).forEach(c => cards.push(c));
    state.foundations.forEach(pile => { if (pile.length) cards.push(pile[pile.length - 1]); });
    state.tableau.forEach(col => col.forEach(c => { if (c.faceUp) cards.push(c); }));
    return cards;
  }

  // Resolves once every given URL has either loaded and decoded, or
  // failed - never rejects, so a single broken fetch can't hang a switch
  // (render()'s own attachImageFallback covers a real failure the same
  // way it always does). Used only to bridge the instant between picking
  // a new Cards/Card Back option and applying it, so that instant never
  // shows a blank card mid-load.
  function preloadUrls(urls) {
    return Promise.all(urls.map(url => new Promise(resolve => {
      const img = new Image();
      img.onload = img.onerror = resolve;
      img.src = url;
      if (img.decode) img.decode().then(resolve, resolve);
    })));
  }

  // Rebuilds the whole panel from PREFERENCE_SECTIONS every time it's
  // opened or a choice changes - cheap (a handful of small buttons), and
  // means a newly added section just appears with no other code to
  // update, matching how the rest of this file re-renders on any change.
  function renderSettingsPanel() {
    settingsSections.innerHTML = '';
    for (const section of PREFERENCE_SECTIONS) {
      const current = currentPreferenceOption(section);

      const sectionEl = document.createElement('div');
      sectionEl.className = 'settings-section';

      const heading = document.createElement('h3');
      heading.className = 'settings-section-label';
      heading.textContent = section.label;
      sectionEl.appendChild(heading);

      const optionsRow = document.createElement('div');
      optionsRow.className = 'settings-options';
      for (const option of section.options) {
        const optionBtn = document.createElement('button');
        optionBtn.type = 'button';
        optionBtn.className = 'settings-option';
        optionBtn.classList.toggle('settings-option--stack', section.variant === 'stack');
        optionBtn.classList.toggle('settings-option--text', section.variant === 'text');
        optionBtn.classList.toggle('selected', option.id === current.id);
        optionBtn.setAttribute('aria-label', option.label);
        if (section.variant === 'text') {
          // No card art here - Cards is the one section where the choice
          // itself (Worn vs New) is the whole point, not a design being
          // compared visually, so a plain label reads more clearly than a
          // small king-of-spades sample would.
          optionBtn.textContent = option.label;
        } else {
          optionBtn.appendChild(renderPreferenceOptionPreview(option));
          if (section.variant === 'stack') {
            const label = document.createElement('span');
            label.className = 'settings-option-label';
            label.textContent = option.label;
            optionBtn.appendChild(label);
          }
        }
        optionBtn.addEventListener('click', () => {
          if (option.id === current.id) return;
          if (section.key === 'cardStyle') {
            // Switching collections is different from every other
            // preference here: it's the entire visible board's worth of
            // faces, plus the selected back's condition, in art the
            // browser may never have fetched before (a Settings preview
            // only ever warms the CLEAN back - see the cardBack section's
            // previewSrc - so the worn variant of whatever's selected is
            // still cold the first time a player switches to Worn).
            // Waiting for exactly that (visibleFaceUpCards + the one back
            // URL, not the whole deck) to be decode-ready before flipping
            // the preference over is what keeps this from reading as a
            // blank-card flash. See preloadUrls for the "never hangs"
            // guarantee.
            const urls = visibleFaceUpCards().map(card => cardImageSrc(card, option.id));
            urls.push(backImageSrc(getCardBackDesignId(), option.id));
            preloadUrls(urls).then(() => {
              setPreference(section.key, option.id);
              renderSettingsPanel();
              render();
            });
            return;
          }
          if (section.key === 'cardBack') {
            // Same gap as above, from the other direction: this design's
            // preview tile was only ever fetched as CLEAN art, so if the
            // player is currently on Worn faces, its worn variant is still
            // cold the instant they pick it. One image, not the whole set.
            preloadUrls([backImageSrc(option.id, getActiveCollection())]).then(() => {
              setPreference(section.key, option.id);
              renderSettingsPanel();
              render();
            });
            return;
          }
          setPreference(section.key, option.id);
          renderSettingsPanel(); // move the selected-highlight
          render(); // apply immediately - e.g. face-down cards pick up the new back right away
        });
        optionsRow.appendChild(optionBtn);
      }
      sectionEl.appendChild(optionsRow);
      settingsSections.appendChild(sectionEl);
    }
  }

  settingsBtn.addEventListener('click', () => {
    renderSettingsPanel();
    settingsOverlay.classList.remove('hidden');
  });
  settingsCloseBtn.addEventListener('click', () => settingsOverlay.classList.add('hidden'));
  versionLink.textContent = `v${APP_VERSION}`;
  versionLink.addEventListener('click', forceWinForTesting);
  settingsOverlay.addEventListener('click', e => {
    if (e.target === settingsOverlay) settingsOverlay.classList.add('hidden');
  });

  // ---------- stats panel ----------

  function renderStatRow(label, value) {
    const row = document.createElement('div');
    row.className = 'stats-row';
    const labelEl = document.createElement('div');
    labelEl.className = 'stats-row-label';
    labelEl.textContent = label;
    const valueEl = document.createElement('div');
    valueEl.className = 'stats-row-value';
    valueEl.textContent = value;
    row.appendChild(labelEl);
    row.appendChild(valueEl);
    return row;
  }

  // modeKey is purely a view filter here - selecting Draw 1 while playing
  // a Draw 3 game (or vice versa) never touches the live drawCount
  // preference, only which stored records this screen displays. Reads
  // straight from stats.js's own API (getStatsForMode), never raw
  // localStorage and never recomputes records itself.
  function renderStatsPanel(modeKey) {
    statsDraw1Btn.classList.toggle('selected', modeKey === 'draw1');
    statsDraw3Btn.classList.toggle('selected', modeKey === 'draw3');

    const modeLabel = modeKey === 'draw1' ? 'Draw 1' : 'Draw 3';
    const stats = getStatsForMode(modeKey);

    statsRows.innerHTML = '';
    statsRows.appendChild(renderStatRow(`${modeLabel} Plays`, String(stats.plays)));
    statsRows.appendChild(renderStatRow(`${modeLabel} Wins`, String(stats.wins)));
    statsRows.appendChild(renderStatRow('Fastest Time', stats.fastestTimeSeconds != null ? formatTime(stats.fastestTimeSeconds) : '—'));
    statsRows.appendChild(renderStatRow('Fewest Moves', stats.fewestMoves != null ? String(stats.fewestMoves) : '—'));
    statsRows.appendChild(renderStatRow('Last Win', stats.lastWin ? `${formatTime(stats.lastWin.timeSeconds)} · ${stats.lastWin.moves} moves` : '—'));
  }

  // One level "into" Settings, not a separate destination - see index.html.
  // Opens on whichever mode is currently selected in Settings; from there
  // the two mode buttons are a pure local view toggle (see renderStatsPanel).
  statsLink.addEventListener('click', () => {
    settingsOverlay.classList.add('hidden');
    renderStatsPanel(currentDrawModeKey());
    statsOverlay.classList.remove('hidden');
  });
  function closeStatsPanel() {
    statsOverlay.classList.add('hidden');
    settingsOverlay.classList.remove('hidden');
  }
  statsCloseBtn.addEventListener('click', closeStatsPanel);
  statsOverlay.addEventListener('click', e => {
    if (e.target === statsOverlay) closeStatsPanel();
  });
  statsDraw1Btn.addEventListener('click', () => renderStatsPanel('draw1'));
  statsDraw3Btn.addEventListener('click', () => renderStatsPanel('draw3'));

  // ---------- controls ----------

  undoBtn.addEventListener('click', undo);
  newGameBtn.addEventListener('click', () => guardAbandon('newGame', newGame));
  restartBtn.addEventListener('click', () => guardAbandon('restart', restart));
  winNewGameBtn.addEventListener('click', newGame); // starting again from the win screen is never gated

  timerHandle = setInterval(tick, 500);

  // Recomputes tableau cascade compression whenever the viewport's usable
  // height changes - covers portrait/landscape rotation and any other
  // resize. Debounced since resize fires rapidly; skipped entirely while a
  // drag/draw/Auto Finish run is actively in progress, the same guard
  // every other state-changing entry point already uses - it simply
  // catches up on the next resize or interaction rather than risk
  // rebuilding DOM out from under an active gesture. Re-shows the current
  // hint highlight afterward, if one was up - render() rebuilds every
  // tableau card element, which would otherwise silently drop the glow.
  let reflowHandle = null;
  function scheduleTableauReflow() {
    if (reflowHandle) clearTimeout(reflowHandle);
    reflowHandle = setTimeout(() => {
      reflowHandle = null;
      // A resize/rotation can interrupt an in-progress drag or King-cascade
      // hold in ways iOS doesn't always report cleanly - onDragCancel's own
      // comment already notes pointercancel isn't guaranteed when iOS
      // decides a gesture belongs to it instead (which a physical rotation
      // very much can). Left unhandled, a drag stuck mid-air here means its
      // ghost never gets swept and, for a foundation source, the pile stays
      // frozen on its "card underneath" peek-render (see renderFoundation's
      // peekBehindTop) - permanently, since nothing else ever calls back in
      // to finish that gesture. Rather than hope every drag/hold resolves
      // itself before the viewport reshapes under it, force both closed
      // unconditionally on every reflow - cheap and idempotent when neither
      // was actually active, and the render() below (when it runs) rebuilds
      // the foundation/tableau fresh from state either way, correcting any
      // peek-render or hidden-origin staleness a cancelled drag leaves behind.
      cancelActiveDrag();
      cancelKingCascadeHold();
      clearGhosts();
      if (isDrawing || autoFinishRunning || kingCascadeRunning) return;
      // A resize/rotation recalculates every column's compression from
      // scratch - an expanded column's "should this fit at normal spacing"
      // premise no longer holds once the viewport itself has changed. The
      // cached layout measurements (see invalidateLayoutCache) are exactly
      // as stale as that premise, for the same reason - clear them too.
      expandedColumnIndex = null;
      invalidateLayoutCache();
      render();
      if (hintMoves) showHintMove(hintMoves[hintIndex]);
    }, 120);
  }
  window.addEventListener('resize', scheduleTableauReflow);
  window.addEventListener('orientationchange', scheduleTableauReflow);

  newGame();
  backgroundPreloadRemaining(); // only schedules idle-time work - the board above is already rendered and interactive
})();

// ---------- update checking ----------
// Independent of game state (a reload discards the current board — there's
// no save/restore — so this deliberately never reloads on its own, only
// on request), so it lives outside the game IIFE entirely.
(() => {
  const CHECK_FILES = ['index.html', 'script.js', 'style.css'];
  const CHECK_INTERVAL_MS = 60000;

  const bar = document.getElementById('update-bar');
  const reloadBtn = document.getElementById('updateReloadBtn');
  const dismissBtn = document.getElementById('updateDismissBtn');

  let baseline = null;
  let dismissed = false;

  // A composite "fingerprint" of the deployed files. Netlify (and most
  // static hosts/CDNs) serve content-derived ETags, so a file untouched by
  // a deploy keeps the same tag and only genuinely changed files shift it —
  // checking several files this way catches an update regardless of which
  // one actually changed, without needing a hand-maintained version number.
  async function fetchFingerprint() {
    try {
      const responses = await Promise.all(
        CHECK_FILES.map(f => fetch(f, { method: 'HEAD', cache: 'no-store' }))
      );
      if (responses.some(r => !r.ok)) return null;
      return responses
        .map(r => r.headers.get('etag') || r.headers.get('last-modified') || '')
        .join('|');
    } catch {
      return null; // offline, blocked, etc. — just skip this check
    }
  }

  async function checkForUpdate() {
    if (dismissed) return;
    const tag = await fetchFingerprint();
    if (!tag) return;
    if (baseline === null) {
      baseline = tag; // first successful check establishes the baseline
      return;
    }
    if (tag !== baseline) {
      bar.classList.remove('hidden');
    }
  }

  reloadBtn.addEventListener('click', () => location.reload());
  dismissBtn.addEventListener('click', () => {
    dismissed = true;
    bar.classList.add('hidden');
  });

  checkForUpdate();
  setInterval(checkForUpdate, CHECK_INTERVAL_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkForUpdate();
  });
})();
