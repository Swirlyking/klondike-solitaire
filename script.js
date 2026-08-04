import {
  canPlaceOnFoundation,
  anyFoundationFor,
  canPlaceOnTableau,
  getStackFrom,
  resolveClickDestination,
  applyMove,
  cloneState,
} from './game-logic.js';
import { getPreference, setPreference } from './preferences.js';

(() => {
  const SUITS = [
    { key: 'hearts', file: 'heart', color: 'red' },
    { key: 'diamonds', file: 'diamond', color: 'red' },
    { key: 'clubs', file: 'club', color: 'black' },
    { key: 'spades', file: 'spade', color: 'black' },
  ];
  const RANK_LABELS = ['', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  const RANK_FILES = ['', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'jack', 'queen', 'king'];

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
        { id: 'red', label: 'Red', previewSrc: 'assets/cards/back-red.png' },
        { id: 'blue', label: 'Blue', previewSrc: 'assets/cards/back-blue.png' },
        { id: 'green', label: 'Green', previewSrc: 'assets/cards/back-green.png' },
        { id: 'purple', label: 'Purple', previewSrc: 'assets/cards/back-purple.png' },
      ],
    },
    {
      key: 'drawCount',
      label: 'Deal Style',
      default: '1',
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

  function getCardBackSrc() {
    return currentPreferenceOption(findPreferenceSection('cardBack')).previewSrc;
  }

  // Read live from the preference on every draw rather than cached in a
  // local variable - single source of truth, same pattern as
  // getCardBackSrc, so a Settings change takes effect on the very next
  // stock click with nothing to keep in sync.
  function getDrawCount() {
    return parseInt(currentPreferenceOption(findPreferenceSection('drawCount')).id, 10);
  }

  function cardImageSrc(card) {
    const suit = SUITS.find(s => s.key === card.suit);
    return `assets/cards/${suit.file}_${RANK_FILES[card.rank]}.png`;
  }

  // render() recreates every card's <img> element on every single move, even
  // for piles that didn't change — a fresh <img> decodes asynchronously by
  // default, so mobile browsers can paint it blank for a frame before the
  // decoded bitmap is ready. Pre-decoding every face here means that by the
  // time makeCardEl creates a new <img> pointing at the same URL, the decode
  // is already done and it paints immediately instead of flashing blank.
  // Every card-back color gets preloaded too (not just the active one) so
  // switching in Settings mid-game never flashes either.
  function preloadCardImages() {
    const urls = [];
    for (const suit of SUITS) {
      for (let rank = 1; rank <= 13; rank++) {
        urls.push(cardImageSrc({ suit: suit.key, rank }));
      }
    }
    for (const section of PREFERENCE_SECTIONS) {
      for (const option of section.options) {
        if (option.previewSrc) urls.push(option.previewSrc);
      }
    }
    urls.forEach(src => {
      const img = new Image();
      img.src = src;
      if (img.decode) img.decode().catch(() => {});
    });
  }
  preloadCardImages(); // fire immediately so decoding is well underway before the first render, let alone the first move

  // Animation tuning.
  const DROP_MS = 100;
  const ROTATE_MS = 90;
  const MAX_ROTATE_DEG = 1.6;
  const ROTATE_VELOCITY_PX_MS = 1.6; // pointer speed (px/ms) that reaches MAX_ROTATE_DEG
  const FLIP_MS = 220;
  const DEAL_STAGGER_MS = 70; // per-card delay when dealing more than one, so a 3-draw visibly cascades
  const DRAG_THRESHOLD_PX = 4; // pointer movement below this counts as a click, not a drag
  const CLICK_LIFT_MS = 50; // brief lift before a click-move starts gliding
  const CLICK_MOVE_MS = 140; // click-move glide duration (+ CLICK_LIFT_MS ≈ 190ms total)

  // The gap after a tableau card depends on its own face - a back only
  // needs to show a sliver of its top border, while a face needs enough
  // exposed to read the corner's rank and the top of its suit pip.
  function getCascadeDown() {
    return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--cascade-down'));
  }

  function getCascadeUp() {
    return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--cascade-up'));
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
  const newGameBtn = document.getElementById('newGameBtn');
  const restartBtn = document.getElementById('restartBtn');
  const winOverlay = document.getElementById('win-overlay');
  const winStats = document.getElementById('win-stats');
  const winNewGameBtn = document.getElementById('winNewGameBtn');
  const settingsBtn = document.getElementById('settingsBtn');
  const settingsOverlay = document.getElementById('settings-overlay');
  const settingsCloseBtn = document.getElementById('settingsCloseBtn');
  const settingsSections = document.getElementById('settings-sections');

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

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
    state = cloneState(initialDeal);
    history = [];
    moveCount = 0;
    won = false;
    winOverlay.classList.add('hidden');
    startTime = Date.now();
    updateMoves();
    render();
  }

  function pushHistory() {
    history.push(cloneState(state));
    if (history.length > 200) history.shift();
  }

  function undo() {
    if (!history.length) return;
    cancelActiveDrag();
    clearGhosts();
    resetTableauClickMemory();
    state = history.pop();
    moveCount = Math.max(0, moveCount - 1);
    updateMoves();
    render();
  }

  function updateMoves() {
    movesEl.textContent = `Moves: ${moveCount}`;
    undoBtn.disabled = history.length === 0;
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
    for (let i = 0; i < 7; i++) renderTableauCol(i);
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
    } else {
      img.src = getCardBackSrc();
      img.alt = 'face-down card';
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

  function renderTableauCol(i) {
    const el = document.getElementById(`tableau-${i}`);
    el.innerHTML = '';
    const col = state.tableau[i];
    const cascadeDown = getCascadeDown();
    const cascadeUp = getCascadeUp();
    let top = 0;
    col.forEach((card, idx) => {
      const cardEl = makeCardEl(card, card.faceUp);
      cardEl.style.top = `${top}px`;
      cardEl.style.zIndex = idx;
      if (card.faceUp) {
        attachCardInteractions(cardEl, card, 'tableau', i);
      } else {
        cardEl.classList.add('not-draggable');
      }
      el.appendChild(cardEl);
      // How much of *this* card peeks out is what determines where the next
      // one starts - a back only needs its top-border sliver, a face needs
      // enough to read the corner index.
      top += card.faceUp ? cascadeUp : cascadeDown;
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
    front.appendChild(frontImg);

    const back = document.createElement('div');
    back.className = 'flip-face flip-back';
    const backImg = document.createElement('img');
    backImg.decoding = 'sync';
    backImg.src = cardImageSrc(card);
    backImg.alt = `${RANK_LABELS[card.rank]} of ${card.suit}`;
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
  function animateDraw(cards, originRect) {
    cards.forEach((card, i) => {
      const el = document.querySelector(`.card[data-id="${card.id}"]`);
      if (!el) return; // covered by a later card in the same draw; nothing to animate
      const destRect = el.getBoundingClientRect();
      el.style.visibility = 'hidden';

      const { wrapper, inner } = createFlipGhost(card, originRect, 1000 + i);
      const delay = i * DEAL_STAGGER_MS;

      setTimeout(() => {
        // Double rAF so the un-flipped, un-translated start state paints
        // before the transition target changes.
        requestAnimationFrame(() => requestAnimationFrame(() => {
          wrapper.style.translate = `${destRect.left - originRect.left}px ${destRect.top - originRect.top}px`;
          inner.classList.add('flipped');
        }));
      }, delay);

      setTimeout(() => {
        wrapper.remove();
        el.style.visibility = '';
      }, delay + FLIP_MS + 60);
    });
  }

  function onStockClick() {
    if (state.stock.length) {
      const stockRect = document.getElementById('stock').getBoundingClientRect();
      resetTableauClickMemory();
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
      animateDraw(drawn, stockRect);
    } else if (state.waste.length) {
      resetTableauClickMemory();
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
  function commitMove(cards, source, sourceIndex, target, targetIndex) {
    resetTableauClickMemory();
    pushHistory();
    applyMove(state, cards, source, sourceIndex, target, targetIndex);
    moveCount++;
    updateMoves();
    render();
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

  function computeDestRects(target, targetIndex, count) {
    if (target === 'foundation') {
      return [document.getElementById(`foundation-${targetIndex}`).getBoundingClientRect()];
    }
    const colEl = document.getElementById(`tableau-${targetIndex}`);
    const colRect = colEl.getBoundingClientRect();
    // Every card landing here is face-up (only face-up sequences can be
    // dropped on a tableau column), and so is whatever it's landing on top
    // of - but cards further down that existing pile may be face-down,
    // each with their own smaller gap (see renderTableauCol), so the
    // existing top card's *actual* rendered position - not index * a
    // single cascade constant - is the only reliable base to build on.
    const cascadeUp = getCascadeUp();
    const existingCards = colEl.children;
    // Expressed as "one cascadeUp step above the first new card's slot" in
    // both branches, so the loop below can add (i + 1) * cascadeUp uniformly
    // regardless of whether the column already had cards in it.
    const baseTop = existingCards.length
      ? existingCards[existingCards.length - 1].getBoundingClientRect().top
      : colRect.top - cascadeUp;
    const rects = [];
    for (let i = 0; i < count; i++) {
      rects.push({ left: colRect.left, top: baseTop + cascadeUp * (i + 1) });
    }
    return rects;
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

  function executeClickMove(stack, source, sourceIndex, target, targetIndex) {
    const originEls = stack.map(c => document.querySelector(`.card[data-id="${c.id}"]`)).filter(Boolean);
    if (originEls.length !== stack.length) return; // DOM out of sync with state; bail rather than animate garbage
    const originRects = originEls.map(el => el.getBoundingClientRect());
    originEls.forEach(el => { el.style.visibility = 'hidden'; });

    const ghosts = createGhostStack(stack, originRects);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      ghosts.visuals.forEach(v => v.classList.add('lifted'));
    }));

    const destRects = computeDestRects(target, targetIndex, stack.length);
    commitMove(stack, source, sourceIndex, target, targetIndex); // clears tableauClickMemory — re-set below if this continues a cycle
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
    if (dragCtx) return;
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
    if (option.previewSrc) {
      const img = document.createElement('img');
      img.src = option.previewSrc;
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
  newGameBtn.addEventListener('click', newGame);
  restartBtn.addEventListener('click', restart);
  winNewGameBtn.addEventListener('click', newGame);

  timerHandle = setInterval(tick, 500);

  newGame();
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
