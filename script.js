(() => {
  const SUITS = [
    { key: 'hearts', file: 'heart', glyph: '♥', color: 'red' },
    { key: 'diamonds', file: 'diamond', glyph: '♦', color: 'red' },
    { key: 'clubs', file: 'club', glyph: '♣', color: 'black' },
    { key: 'spades', file: 'spade', glyph: '♠', color: 'black' },
  ];
  const RANK_LABELS = ['', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  const RANK_FILES = ['', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'jack', 'queen', 'king'];
  const CARD_BACK_SRC = 'assets/cards/back.png';

  function cardImageSrc(card) {
    const suit = SUITS.find(s => s.key === card.suit);
    return `assets/cards/${suit.file}_${RANK_FILES[card.rank]}.png`;
  }

  let state = null;
  let drawCount = 1;
  let history = [];
  let moveCount = 0;
  let startTime = null;
  let timerHandle = null;
  let won = false;

  const boardEl = document.getElementById('board');
  const movesEl = document.getElementById('moves');
  const timerEl = document.getElementById('timer');
  const undoBtn = document.getElementById('undoBtn');
  const drawModeBtn = document.getElementById('drawModeBtn');
  const newGameBtn = document.getElementById('newGameBtn');
  const winOverlay = document.getElementById('win-overlay');
  const winStats = document.getElementById('win-stats');
  const winNewGameBtn = document.getElementById('winNewGameBtn');

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

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function newGame() {
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
    history = [];
    moveCount = 0;
    won = false;
    winOverlay.classList.add('hidden');
    startTime = Date.now();
    updateMoves();
    render();
  }

  function cloneState(s) {
    return JSON.parse(JSON.stringify(s));
  }

  function pushHistory() {
    history.push(cloneState(state));
    if (history.length > 200) history.shift();
  }

  function undo() {
    if (!history.length) return;
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
    if (faceUp) {
      img.src = cardImageSrc(card);
      img.alt = `${RANK_LABELS[card.rank]} of ${card.suit}`;
    } else {
      img.src = CARD_BACK_SRC;
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
        attachDrag(cardEl, card, 'waste', null);
        cardEl.ondblclick = () => tryAutoToFoundation(card, 'waste', null);
      } else {
        cardEl.classList.add('not-draggable');
      }
      el.appendChild(cardEl);
    }
  }

  function renderFoundation(i) {
    const el = document.getElementById(`foundation-${i}`);
    el.innerHTML = '';
    el.dataset.suitGlyph = SUITS[i].glyph;
    const pile = state.foundations[i];
    if (pile.length) {
      const card = pile[pile.length - 1];
      const cardEl = makeCardEl(card, true);
      attachDrag(cardEl, card, 'foundation', i);
      el.appendChild(cardEl);
    }
  }

  function renderTableauCol(i) {
    const el = document.getElementById(`tableau-${i}`);
    el.innerHTML = '';
    const col = state.tableau[i];
    const cascade = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--cascade'));
    col.forEach((card, idx) => {
      const cardEl = makeCardEl(card, card.faceUp);
      cardEl.style.top = `${idx * cascade}px`;
      cardEl.style.zIndex = idx;
      if (card.faceUp) {
        attachDrag(cardEl, card, 'tableau', i);
        if (idx === col.length - 1) {
          cardEl.ondblclick = () => tryAutoToFoundation(card, 'tableau', i);
        }
      } else {
        cardEl.classList.add('not-draggable');
      }
      el.appendChild(cardEl);
    });
  }

  // ---------- game rules ----------

  function canPlaceOnFoundation(card, foundationIndex) {
    const pile = state.foundations[foundationIndex];
    if (SUITS[foundationIndex].key !== card.suit) return false;
    if (!pile.length) return card.rank === 1;
    return pile[pile.length - 1].rank === card.rank - 1;
  }

  function anyFoundationFor(card) {
    for (let i = 0; i < 4; i++) {
      if (canPlaceOnFoundation(card, i)) return i;
    }
    return -1;
  }

  function canPlaceOnTableau(card, colIndex) {
    const col = state.tableau[colIndex];
    if (!col.length) return card.rank === 13;
    const top = col[col.length - 1];
    if (!top.faceUp) return false;
    return top.color !== card.color && top.rank === card.rank + 1;
  }

  function onStockClick() {
    if (state.stock.length) {
      pushHistory();
      const n = Math.min(drawCount, state.stock.length);
      for (let i = 0; i < n; i++) {
        const card = state.stock.pop();
        card.faceUp = true;
        state.waste.push(card);
      }
      moveCount++;
      updateMoves();
      render();
    } else if (state.waste.length) {
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

  function flipNewTopIfNeeded(colIndex) {
    const col = state.tableau[colIndex];
    if (col.length && !col[col.length - 1].faceUp) {
      col[col.length - 1].faceUp = true;
    }
  }

  function removeFromSource(source, sourceIndex, card) {
    if (source === 'waste') {
      state.waste.pop();
    } else if (source === 'foundation') {
      state.foundations[sourceIndex].pop();
    } else if (source === 'tableau') {
      const col = state.tableau[sourceIndex];
      const idx = col.findIndex(c => c.id === card.id);
      const removed = col.splice(idx);
      flipNewTopIfNeeded(sourceIndex);
      return removed;
    }
    return [card];
  }

  function tryAutoToFoundation(card, source, sourceIndex) {
    const fi = anyFoundationFor(card);
    if (fi === -1) return;
    pushHistory();
    removeFromSource(source, sourceIndex, card);
    state.foundations[fi].push(card);
    moveCount++;
    updateMoves();
    render();
  }

  function attemptMove(cards, source, sourceIndex, target, targetIndex) {
    const card = cards[0];
    if (target === 'foundation') {
      if (cards.length !== 1 || !canPlaceOnFoundation(card, targetIndex)) return false;
      pushHistory();
      removeFromSource(source, sourceIndex, card);
      state.foundations[targetIndex].push(card);
    } else if (target === 'tableau') {
      if (!canPlaceOnTableau(card, targetIndex)) return false;
      if (source === 'tableau' && sourceIndex === targetIndex) return false;
      pushHistory();
      removeFromSource(source, sourceIndex, card);
      state.tableau[targetIndex].push(...cards);
    } else {
      return false;
    }
    moveCount++;
    updateMoves();
    return true;
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

  function attachDrag(cardEl, card, source, sourceIndex) {
    cardEl.addEventListener('pointerdown', (e) => startDrag(e, card, source, sourceIndex));
  }

  function getStackFrom(source, sourceIndex, card) {
    if (source === 'tableau') {
      const col = state.tableau[sourceIndex];
      const idx = col.findIndex(c => c.id === card.id);
      return col.slice(idx);
    }
    return [card];
  }

  function startDrag(e, card, source, sourceIndex) {
    if (e.button !== undefined && e.button !== 0) return;
    const stack = getStackFrom(source, sourceIndex, card);
    if (!stack.length) return;

    const originContainer = e.currentTarget.parentElement;
    const originEls = stack.map(c => originContainer.querySelector(`[data-id="${c.id}"]`)).filter(Boolean);
    if (!originEls.length) return;

    e.preventDefault();
    const rects = originEls.map(el => el.getBoundingClientRect());
    const dragLayer = document.getElementById('drag-layer');

    const ghosts = stack.map((c, i) => {
      const ghost = makeCardEl(c, true);
      ghost.classList.add('dragging');
      ghost.style.position = 'fixed';
      ghost.style.left = `${rects[i].left}px`;
      ghost.style.top = `${rects[i].top}px`;
      ghost.style.width = `${rects[0].width}px`;
      ghost.style.height = `${rects[0].height}px`;
      ghost.style.zIndex = 1000 + i;
      dragLayer.appendChild(ghost);
      return ghost;
    });

    originEls.forEach(el => { el.style.visibility = 'hidden'; });

    dragCtx = {
      stack, source, sourceIndex, ghosts,
      startX: e.clientX, startY: e.clientY,
      baseLeft: rects[0].left, baseTop: rects[0].top,
      originEls,
      pointerId: e.pointerId,
    };

    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', onDragEnd);
  }

  function onDragMove(e) {
    if (!dragCtx) return;
    const dx = e.clientX - dragCtx.startX;
    const dy = e.clientY - dragCtx.startY;
    dragCtx.ghosts.forEach((ghost, i) => {
      ghost.style.left = `${dragCtx.baseLeft + dx}px`;
      ghost.style.top = `${dragCtx.baseTop + dy + i * 26}px`;
    });
    dragCtx.lastX = e.clientX;
    dragCtx.lastY = e.clientY;
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
    window.removeEventListener('pointermove', onDragMove);
    window.removeEventListener('pointerup', onDragEnd);
    if (!dragCtx) return;
    const { stack, source, sourceIndex, ghosts, originEls } = dragCtx;
    const x = e.clientX, y = e.clientY;

    ghosts.forEach(g => g.remove());

    const targetEl = pileContainerAt(x, y);
    let moved = false;
    if (targetEl) {
      const target = targetEl.dataset.pile;
      const targetIndex = targetEl.dataset.index !== undefined ? parseInt(targetEl.dataset.index, 10) : null;
      if (target === 'foundation' || target === 'tableau') {
        moved = attemptMove(stack, source, sourceIndex, target, targetIndex);
      }
    }

    dragCtx = null;
    if (moved) {
      render();
    } else {
      originEls.forEach(el => { el.style.visibility = ''; });
    }
  }

  // ---------- controls ----------

  drawModeBtn.addEventListener('click', () => {
    drawCount = drawCount === 1 ? 3 : 1;
    drawModeBtn.textContent = drawCount === 1 ? 'Draw 3' : 'Draw 1';
  });
  undoBtn.addEventListener('click', undo);
  newGameBtn.addEventListener('click', newGame);
  winNewGameBtn.addEventListener('click', newGame);

  timerHandle = setInterval(tick, 500);

  newGame();
})();
