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
} from './game-logic.js';
import { getPreference, setPreference } from './preferences.js';
import { shuffle } from './shuffle.js';

(() => {
  const SUITS = [
    { key: 'hearts', file: 'heart', color: 'red', symbol: '♥' },
    { key: 'diamonds', file: 'diamond', color: 'red', symbol: '♦' },
    { key: 'clubs', file: 'club', color: 'black', symbol: '♣' },
    { key: 'spades', file: 'spade', color: 'black', symbol: '♠' },
  ];
  const RANK_LABELS = ['', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  const RANK_FILES = ['', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'jack', 'queen', 'king'];

  // Two pre-rendered art tiers ship on disk (assets/cards/mobile at
  // ~175x250, assets/cards/full at the original 350x500, both WebP) so a
  // phone never has to download or decode pixels many times larger than
  // it can actually show. Decided once, here, from whatever the viewport
  // happens to be at load - and never recomputed - so an in-progress
  // game can't have cards change resolution out from under it on
  // rotation/resize. Keys off the same 720px breakpoint style.css uses
  // for its own mobile layout (so --card-w already reflects it), then
  // double-checks the actual physical pixel need against the mobile
  // tier's native resolution - this is what keeps a landscape-rotated
  // phone (viewport width > 720 despite being a phone) safely on the
  // full tier instead of upscaling a too-small mobile asset.
  // --card-w is itself a calc()-with-100vw expression on mobile (see
  // resolveCssLength below, defined later in this file but hoisted -
  // function declarations are available to code above them in the same
  // scope), so it's resolved through a real element rather than parsed
  // as text.
  const ASSET_TIER = (() => {
    const cardWpx = resolveCssLength('var(--card-w)') || 84;
    const neededPhysicalPx = cardWpx * (window.devicePixelRatio || 1);
    const MOBILE_TIER_NATIVE_PX = 175;
    return (window.innerWidth <= 720 && neededPhysicalPx <= MOBILE_TIER_NATIVE_PX) ? 'mobile' : 'full';
  })();

  // Cache-buster on every card image URL, not a build/deploy version -
  // bump this by hand whenever the card art itself changes. It's what
  // lets Netlify give assets/cards/{mobile,full}/* a year-long immutable
  // Cache-Control (see netlify.toml) without a stale deck getting stuck
  // in a returning player's cache: a version bump mints new URLs, which
  // are cache misses by construction, while every URL that didn't change
  // keeps serving instantly from cache forever.
  const ASSET_VERSION = 'v1';

  function cardImageSrc(card) {
    const suit = SUITS.find(s => s.key === card.suit);
    return `assets/cards/${ASSET_TIER}/${suit.file}_${RANK_FILES[card.rank]}.webp?v=${ASSET_VERSION}`;
  }

  function backImageSrc(colorId) {
    return `assets/cards/${ASSET_TIER}/back-${colorId}.webp?v=${ASSET_VERSION}`;
  }

  // The original full-resolution PNGs stay on disk as a graceful
  // fallback target - untiered and unversioned, so they're guaranteed to
  // exist regardless of ASSET_TIER or a WebP request failing/being
  // unsupported. See attachImageFallback for where these get wired up.
  function cardPngFallbackSrc(card) {
    const suit = SUITS.find(s => s.key === card.suit);
    return `assets/cards/${suit.file}_${RANK_FILES[card.rank]}.png`;
  }

  function backPngFallbackSrc(colorId) {
    return `assets/cards/back-${colorId}.png`;
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
  // future preference (table surface, card face style, ...) should only
  // ever mean adding another entry here, an appearance-reading helper
  // like getCardBackSrc, and the render-time call sites that use it -
  // never new settings-panel plumbing.
  const PREFERENCE_SECTIONS = [
    {
      key: 'cardBack',
      label: 'Card Back',
      default: 'red',
      options: [
        { id: 'red', label: 'Red', previewSrc: () => backImageSrc('red') },
        { id: 'blue', label: 'Blue', previewSrc: () => backImageSrc('blue') },
        { id: 'green', label: 'Green', previewSrc: () => backImageSrc('green') },
        { id: 'purple', label: 'Purple', previewSrc: () => backImageSrc('purple') },
      ],
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

  // Falls back to the section's first option if a stored value doesn't
  // match any current option (e.g. an option was renamed/removed in a
  // later update) - never lets a stale preference break rendering.
  function currentPreferenceOption(section) {
    const chosenId = getPreference(section.key, section.default);
    return section.options.find(o => o.id === chosenId) ?? section.options[0];
  }

  function getCardBackColorId() {
    return currentPreferenceOption(findPreferenceSection('cardBack')).id;
  }

  function getCardBackSrc() {
    return backImageSrc(getCardBackColorId());
  }

  // Read live from the preference on every draw rather than cached in a
  // local variable - single source of truth, same pattern as
  // getCardBackSrc, so a Settings change takes effect on the very next
  // stock click with nothing to keep in sync.
  function getDrawCount() {
    return parseInt(currentPreferenceOption(findPreferenceSection('drawCount')).id, 10);
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
  const DROP_MS = 100;
  const ROTATE_MS = 90;
  const MAX_ROTATE_DEG = 1.6;
  const ROTATE_VELOCITY_PX_MS = 1.6; // pointer speed (px/ms) that reaches MAX_ROTATE_DEG
  const FLIP_MS = 260; // keep in sync with .flip-inner's transition duration in style.css - the whole dealt packet flips together, in place, over this long
  const DEAL_STACK_OFFSET_PX = 3; // per-card offset while held at the stock, so a 3-card draw visibly reads as a small packet rather than a single card
  const DEAL_TRAVEL_MS = 340; // each card's one continuous glide, straight from the stock to its real fanned slot
  const SPREAD_STAGGER_MS = 50; // delay before each successive card's glide starts, so a multi-card draw still reads as a sequence rather than one glide
  const GATHER_MS = 120; // waste-pile draw transition: already-visible cards squaring up into the pile before the next batch deals
  const SURVIVOR_SETTLE_MS = 180; // waste-pile draw transition: a still-visible card's short hop from the gathered pile out to its new fanned slot
  const DRAG_THRESHOLD_PX = 4; // pointer movement below this counts as a click, not a drag
  const CLICK_LIFT_MS = 60; // brief lift before a click-move starts gliding
  const CLICK_MOVE_MS = 190; // click-move glide duration (+ CLICK_LIFT_MS ≈ 250ms total) - slow enough for the ease-out to actually read as a glide, not a snap
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

  // The gap after a tableau card depends on its own face - a back only
  // needs to show a sliver of its top border, while a face needs enough
  // exposed to read the corner's rank and the top of its suit pip.
  function getCascadeDown() {
    return resolveCssLength('var(--cascade-down)');
  }

  function getCascadeUp() {
    return resolveCssLength('var(--cascade-up)');
  }

  function getCardHeight() {
    return resolveCssLength('var(--card-h)');
  }

  // How much vertical room a tableau column actually has, from its own
  // current top (wherever the existing header/top-row layout puts it -
  // untouched by any of this) down to the bottom of the *safe*, visible
  // viewport - past the home-indicator/notch safe area, with a little
  // breathing room so the bottom card isn't flush against the edge.
  const TABLEAU_BOTTOM_MARGIN_PX = 10;
  function getTableauAvailableHeight(colTop) {
    const safeBottom = resolveCssLength('env(safe-area-inset-bottom, 0px)');
    return Math.max(0, window.innerHeight - safeBottom - TABLEAU_BOTTOM_MARGIN_PX - colTop);
  }

  // The one place a tableau column's per-card vertical offsets are computed
  // from scratch - renderTableauCol uses it for the real column, and
  // computeDestRects uses it to predict where cards not yet in the DOM will
  // land, so the two can never disagree. Everything else (drag, click-move,
  // the flip reveal, hint highlighting) reads a card's real position back
  // out of the DOM via getBoundingClientRect() rather than recomputing it,
  // so it automatically inherits whatever this function decided.
  //
  // Three-phase accordion, cheapest concession first:
  // 1. Normal spacing, if the whole column already fits top to bottom -
  //    true for every desktop/portrait/short-column case.
  // 2. Otherwise, compress face-down gaps first, toward a near-zero floor -
  //    they carry no information, so they're the first to give.
  // 3. If that alone isn't enough, compress face-up gaps too: first toward
  //    a floor that still shows the corner rank/suit, and only past that -
  //    a genuinely extreme case - toward near-total overlap.
  // Within a tier every gap shrinks by the same amount, so a column
  // compresses evenly instead of some cards staying spaced while others
  // jump straight to minimum. The bottom card's own top always lands at
  // exactly availableHeight - cardHeight once any compression kicks in,
  // since every phase targets that sum precisely rather than approximating.
  function computeTableauTops(faceUpFlags, availableHeight, cascadeDown, cascadeUp, cardHeight) {
    const n = faceUpFlags.length;
    if (n === 0) return [];
    if (n === 1) return [0];

    const gaps = faceUpFlags.slice(0, n - 1).map(faceUp => faceUp ? cascadeUp : cascadeDown);
    const naturalGapSum = gaps.reduce((a, b) => a + b, 0);

    if (naturalGapSum + cardHeight > availableHeight) {
      let excess = naturalGapSum - Math.max(0, availableHeight - cardHeight);

      const minDown = Math.min(cascadeDown, Math.max(2, cascadeDown * 0.2));
      const minUpInformative = Math.min(cascadeUp, cascadeUp * 0.7);
      const minUpExtreme = Math.min(minUpInformative, Math.max(3, cascadeUp * 0.12));

      const downIdx = [], upIdx = [];
      faceUpFlags.slice(0, n - 1).forEach((faceUp, i) => (faceUp ? upIdx : downIdx).push(i));

      // Shrinks every gap in `idx` toward `floor` by an equal amount,
      // absorbing as much of `excess` as that tier's slack allows.
      const shrinkTier = (idx, floor) => {
        if (excess <= 0 || !idx.length) return;
        const slack = idx.reduce((a, i) => a + (gaps[i] - floor), 0);
        const used = Math.min(excess, slack);
        if (used <= 0) return;
        const perGap = used / idx.length;
        idx.forEach(i => { gaps[i] -= perGap; });
        excess -= used;
      };

      shrinkTier(downIdx, minDown);
      shrinkTier(upIdx, minUpInformative);
      shrinkTier(upIdx, minUpExtreme);

      // Pathological fallback: even minimum spacing everywhere doesn't fit
      // (an unrealistic number of cards for the available room). Rather
      // than overflow, scale every remaining gap toward zero uniformly -
      // the bottom card stays reachable even if middle cards fully overlap.
      if (excess > 0.5 && gaps.length) {
        const remaining = gaps.reduce((a, g) => a + g, 0);
        if (remaining > 0) {
          const ratio = Math.max(0, 1 - excess / remaining);
          for (let i = 0; i < gaps.length; i++) gaps[i] *= ratio;
        }
      }
    }

    const tops = [0];
    for (let i = 0; i < gaps.length; i++) tops.push(tops[i] + gaps[i]);
    return tops;
  }

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
  const newGameBtn = document.getElementById('newGameBtn');
  const restartBtn = document.getElementById('restartBtn');
  const winOverlay = document.getElementById('win-overlay');
  const winStats = document.getElementById('win-stats');
  const winNewGameBtn = document.getElementById('winNewGameBtn');
  const settingsBtn = document.getElementById('settingsBtn');
  const settingsOverlay = document.getElementById('settings-overlay');
  const settingsCloseBtn = document.getElementById('settingsCloseBtn');
  const settingsSections = document.getElementById('settings-sections');
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
    resetTableauClickMemory();
    clearHint();
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
    winOverlay.classList.add('hidden');
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
    resetTableauClickMemory();
    clearHint();
    state = cloneState(initialDeal);
    history = [];
    moveCount = 0;
    won = false;
    winOverlay.classList.add('hidden');
    startTime = Date.now();
    updateMoves();
    render();
  }

  // ---------- abandon-game confirmation ----------

  const ABANDON_COPY = {
    // Which of these two shows depends on classifyMove (game-logic.js) - see
    // guardAbandon below. Visibility of the dialog itself is a separate,
    // unrelated question (needsAbandonConfirmation). No message on the
    // stuck case is deliberate - "no more useful moves" doesn't need a
    // second sentence explaining itself the way "are you sure?" does.
    newGame: {
      meaningful: { title: 'Quitting?', message: 'There are still moves available, are you sure?', confirmLabel: 'Shuffle Me a New Game' },
      stuck: { title: 'No more useful moves!', message: '', confirmLabel: 'Shuffle Me a New Game' },
    },
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
  // `action` immediately when nothing would actually be lost, otherwise
  // shows the modal with action-specific wording and only runs it if the
  // player confirms via the modal's own destructive button.
  function guardAbandon(actionKey, action) {
    if (!needsAbandonConfirmation(state, history.length, won)) {
      action();
      return;
    }
    if (actionKey === 'newGame') {
      const meaningful = getProgressingMoves(state, getDrawCount()).length > 0;
      showConfirm({ ...(meaningful ? ABANDON_COPY.newGame.meaningful : ABANDON_COPY.newGame.stuck), onConfirm: action });
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
    // commitMove calls this on every move, including each Auto Finish step -
    // while a run is in progress the status bar is showing "Auto
    // Finishing…", owned by startAutoFinish/stopAutoFinish, not the hint.
    if (!autoFinishRunning) {
      hintMessage.classList.add('hidden');
      hintMessage.textContent = '';
    }
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
  // Eases in over the first few cards, then settles - a purely cosmetic
  // pacing curve; CLICK_LIFT_MS/CLICK_MOVE_MS (the glide itself, reused
  // unchanged from click-to-move) aren't touched. executeClickMove doesn't
  // return a Promise/take a completion callback today, so this is a fixed
  // delay rather than awaiting the actual animation.
  const AUTO_FINISH_STEP_MS = [260, 220, 190];
  const AUTO_FINISH_STEP_MS_FLOOR = 175;
  function autoFinishStepDelay(i) { return AUTO_FINISH_STEP_MS[i] ?? AUTO_FINISH_STEP_MS_FLOOR; }
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
    let i = 0;
    while (!autoFinishStopRequested) {
      const move = getLegalMoves(state).find(m => m.category === MoveCategory.FOUNDATION_MOVE);
      if (!move) break;
      const stack = getStackFrom(state, move.source, move.sourceIndex, move.card);
      executeClickMove(stack, move.source, move.sourceIndex, 'foundation', move.targetIndex, { recordHistory: false });
      await sleep(autoFinishStepDelay(i++));
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
    autoFinishBtn.textContent = 'Stop';
    autoFinishBtn.classList.add('flash'); // brief one-shot pulse so starting reads as intentional, not sudden
    setAutoFinishControlsDisabled(true);
    document.addEventListener('keydown', onAutoFinishKeydown, true);
    hintMessage.textContent = 'Auto Finishing…';
    hintMessage.classList.remove('hidden');
    runAutoFinish();
  }

  // No end-of-run message in any case: not on a win (the overlay is the
  // payoff), not on a manual stop (return to play quietly), and not on
  // running out of moves either - the board itself shows why it stopped,
  // and staying silent avoids any risk of reading as "stuck."
  function stopAutoFinish() {
    autoFinishRunning = false;
    autoFinishStopRequested = false;
    autoFinishBtn.textContent = 'Auto Finish';
    autoFinishBtn.classList.remove('flash'); // so the next start re-triggers the animation rather than being a no-op class toggle
    document.removeEventListener('keydown', onAutoFinishKeydown, true);
    setAutoFinishControlsDisabled(false);
    updateMoves(); // re-derives undoBtn.disabled and autoFinishBtn's own disabled state
    hintMessage.classList.add('hidden');
    hintMessage.textContent = '';
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
    resetTableauClickMemory();
    const entry = history.pop();
    state = entry.state;
    moveCount = entry.moveCount;
    // Pre-existing gap, not previously reachable often enough to notice:
    // undo() never reset the win state, so undoing back across a win left
    // the "You win!" overlay showing over a board that was, once again,
    // still in play. Grouped Auto Finish undo makes "win, then undo the
    // whole run" a routine path rather than an edge case, so it needs to
    // behave the same as newGame()/restart() here - always reset, since
    // hiding an already-hidden overlay is a harmless no-op when the game
    // wasn't won to begin with.
    won = false;
    winOverlay.classList.add('hidden');
    updateMoves();
    render();
  }

  function updateMoves() {
    movesEl.textContent = `Moves: ${moveCount}`;
    // While a run is in progress, undoBtn/autoFinishBtn's disabled state is
    // owned by startAutoFinish/stopAutoFinish instead - this runs on every
    // single commitMove, including each individual Auto Finish step, so
    // without this guard it would silently re-enable Undo mid-run.
    if (!autoFinishRunning) {
      undoBtn.disabled = history.length === 0;
      autoFinishBtn.disabled = !autoFinishAvailable(state);
    }
  }

  function tick() {
    if (won || !startTime) return;
    const secs = Math.floor((Date.now() - startTime) / 1000);
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    timerEl.textContent = `Time: ${m}:${s.toString().padStart(2, '0')}`;
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
      attachImageFallback(img, backPngFallbackSrc(getCardBackColorId()));
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

  function renderFoundation(i) {
    const el = document.getElementById(`foundation-${i}`);
    el.innerHTML = '';
    el.dataset.placeholder = 'A'; // any Ace may start any slot — no suit is pinned to a position
    const pile = state.foundations[i];
    if (pile.length) {
      const card = pile[pile.length - 1];
      const cardEl = makeCardEl(card, true);
      attachCardInteractions(cardEl, card, 'foundation', i);
      el.appendChild(cardEl);
    }
  }

  function renderTableauCol(i, cascadeDown, cascadeUp, cardHeight) {
    const el = document.getElementById(`tableau-${i}`);
    el.innerHTML = '';
    const col = state.tableau[i];
    const colTop = el.getBoundingClientRect().top; // fixed by the layout above it - this compression never moves it
    const availableHeight = getTableauAvailableHeight(colTop);
    const tops = computeTableauTops(col.map(c => c.faceUp), availableHeight, cascadeDown, cascadeUp, cardHeight);
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
    attachImageFallback(frontImg, backPngFallbackSrc(getCardBackColorId()));
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
  function commitMove(cards, source, sourceIndex, target, targetIndex, { recordHistory = true } = {}) {
    resetTableauClickMemory();
    clearHint();
    if (recordHistory) pushHistory();
    const cardToFlip = peekCardToFlip(source, sourceIndex, cards);
    applyMove(state, cards, source, sourceIndex, target, targetIndex);
    moveCount++;
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
      return canPlaceOnTableau(state, stack[0], targetIndex);
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

  // Click-to-move: a single click on a movable exposed card sends it to its
  // next legal destination (see resolveClickDestination in game-logic.js
  // for the exact priority order). Reuses the same ghost/glide machinery as
  // drag-and-drop so the motion reads identically either way.
  function tryClickMove(card, source, sourceIndex) {
    if (dragCtx) return;
    const stack = getStackFrom(state, source, sourceIndex, card);
    if (!stack.length) return;
    const lead = stack[0];
    const lastTableauDest = source === 'tableau' && tableauClickMemory && tableauClickMemory.cardId === lead.id
      ? tableauClickMemory.destIndex
      : null;
    const dest = resolveClickDestination(state, lead, source, sourceIndex, stack.length, lastTableauDest);
    if (!dest) return;
    executeClickMove(stack, source, sourceIndex, dest.type, dest.index);
  }

  function executeClickMove(stack, source, sourceIndex, target, targetIndex, options) {
    const originEls = stack.map(c => document.querySelector(`.card[data-id="${c.id}"]`)).filter(Boolean);
    if (originEls.length !== stack.length) return; // DOM out of sync with state; bail rather than animate garbage
    const originRects = originEls.map(el => el.getBoundingClientRect());
    originEls.forEach(el => { el.style.visibility = 'hidden'; });

    const ghosts = createGhostStack(stack, originRects);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      ghosts.visuals.forEach(v => v.classList.add('lifted'));
    }));

    const destRects = computeDestRects(target, targetIndex, stack.length);
    commitMove(stack, source, sourceIndex, target, targetIndex, options); // clears tableauClickMemory — re-set below if this continues a cycle
    if (source === 'tableau' && target === 'tableau') {
      tableauClickMemory = { cardId: stack[0].id, destIndex: targetIndex };
    }
    const revealDest = hideDestElements(stack);

    setTimeout(() => {
      glideGhostsTo(ghosts, originRects, destRects, CLICK_MOVE_MS, target === 'foundation', revealDest);
    }, CLICK_LIFT_MS);
  }

  function checkWin() {
    const total = state.foundations.reduce((a, p) => a + p.length, 0);
    if (total === 52 && !won) {
      won = true;
      const secs = Math.floor((Date.now() - startTime) / 1000);
      winStats.textContent = `${moveCount} moves, ${Math.floor(secs / 60)}:${(secs % 60).toString().padStart(2, '0')}`;
      winOverlay.classList.remove('hidden');
    }
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

  // Glides ghosts from baseRects to destRects (position), while easing
  // their visual lift/scale/rotate back to rest. Foundation landings use
  // a slight overshoot easing on the visual only — never on the flight
  // path itself, so the trajectory stays clean.
  function glideGhostsTo(ghosts, baseRects, destRects, ms, isFoundationDrop, onDone) {
    const { wrappers, visuals } = ghosts;
    const settleEase = isFoundationDrop ? 'var(--ease-bounce)' : 'var(--ease-out-smooth)';
    wrappers.forEach((wrapper, i) => {
      wrapper.style.transition = `translate ${ms}ms var(--ease-out-smooth)`;
      wrapper.style.translate = `${destRects[i].left - baseRects[i].left}px ${destRects[i].top - baseRects[i].top}px`;
    });
    visuals.forEach(visual => {
      visual.style.transition = `translate ${ms}ms ${settleEase}, scale ${ms}ms ${settleEase}, rotate ${ROTATE_MS}ms ease-out`;
      visual.classList.remove('lifted');
      visual.style.rotate = '0deg';
    });
    setTimeout(() => {
      wrappers.forEach(w => w.remove());
      if (onDone) onDone();
    }, ms + 30);
  }

  // commitMove's render() paints the real cards at their destination
  // immediately, before the matching ghost has finished flying there —
  // without this, both are visible at once and it reads as two cards.
  // Hides the just-rendered destination elements; call the returned
  // function once the ghost covering them is gone.
  function hideDestElements(cards) {
    const els = cards.map(c => document.querySelector(`.card[data-id="${c.id}"]`)).filter(Boolean);
    els.forEach(el => { el.style.visibility = 'hidden'; });
    return () => { els.forEach(el => { el.style.visibility = ''; }); };
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
    const { ghosts, originEls, hoverTarget, moved } = dragCtx;
    dragCtx = null;
    if (hoverTarget) hoverTarget.classList.remove('drop-target-active');
    ghosts.wrappers.forEach(w => w.remove());
    if (moved) originEls.forEach(el => { el.style.visibility = ''; }); // unmoved: origin was never hidden
  }

  function startDrag(e, card, source, sourceIndex) {
    if (dragCtx || autoFinishRunning) return;
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
      const destRects = computeDestRects(target, targetIndex, stack.length);
      commitMove(stack, source, sourceIndex, target, targetIndex);
      const revealDest = hideDestElements(stack);
      glideGhostsTo(ghosts, originRects, destRects, DROP_MS, target === 'foundation', revealDest);
    } else {
      originEls.forEach(el => { el.style.visibility = ''; });
      glideGhostsTo(ghosts, originRects, originRects, DROP_MS, false);
    }
  }

  // ---------- settings panel ----------

  function renderPreferenceOptionPreview(option) {
    // Image-backed options (card back, and presumably card face style
    // later) show the actual asset, scaled down by CSS; a future
    // non-image preference (table surface color?) can supply
    // previewColor instead and get a flat swatch - renderSettingsPanel
    // itself never needs to know which kind a given section uses.
    // previewSrc is a function rather than a plain string so it's read
    // lazily here (when the panel actually renders) rather than at
    // PREFERENCE_SECTIONS definition time - this is also the only place
    // in the app that fetches the three unselected card-back colors, and
    // only because the player opened Settings.
    if (option.previewSrc) {
      const img = document.createElement('img');
      img.src = option.previewSrc();
      img.alt = option.label;
      img.draggable = false;
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
        optionBtn.classList.toggle('selected', option.id === current.id);
        optionBtn.setAttribute('aria-label', option.label);
        optionBtn.appendChild(renderPreferenceOptionPreview(option));
        if (section.variant === 'stack') {
          const label = document.createElement('span');
          label.className = 'settings-option-label';
          label.textContent = option.label;
          optionBtn.appendChild(label);
        }
        optionBtn.addEventListener('click', () => {
          if (option.id === current.id) return;
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
  settingsOverlay.addEventListener('click', e => {
    if (e.target === settingsOverlay) settingsOverlay.classList.add('hidden');
  });

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
      if (dragCtx || isDrawing || autoFinishRunning) return;
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
