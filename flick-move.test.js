import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveClickDestination, applyMove, cloneState, getStackFrom } from './game-logic.js';

// The other half of the flick's tests. flick.test.js covers the gesture
// and the flight; this file covers the thing the flick is a presentation
// of - the MOVE - and the structural promises that keep those two halves
// from drifting into a second move system.
//
// The flick's own move path is: resolveMoveDestination() -> commitMove()
// in script.js, which is exactly what tap-to-move does. So the move
// semantics tested here (which destination, undo, move counting) are
// tested against the same functions script.js calls, with no flick-
// specific logic in between - because there isn't any, which is the
// point.

let nextId = 0;
function card(suit, rank, faceUp = true) {
  const color = suit === 'hearts' || suit === 'diamonds' ? 'red' : 'black';
  return { id: nextId++, suit, color, rank, faceUp };
}

function emptyState() {
  return { stock: [], waste: [], foundations: [[], [], [], []], tableau: [[], [], [], [], [], [], []] };
}

// The exact call script.js's resolveMoveDestination() makes for a waste
// card: no cycle memory (that's tableau-only), stack length always 1
// (getStackFrom returns a single card for a non-tableau source).
function wasteDestination(state) {
  const top = state.waste[state.waste.length - 1];
  const stack = getStackFrom(state, 'waste', null, top);
  return resolveClickDestination(state, stack[0], 'waste', null, stack.length);
}

// ---------- 4: a flick only fires when there is somewhere to go ----------

test('an unplayable waste card resolves to no destination at all', () => {
  const s = emptyState();
  s.waste = [card('hearts', 9)];        // red 9 needs a black 10
  s.tableau[0] = [card('hearts', 10)];  // red - wrong colour
  s.tableau[1] = [card('diamonds', 4)]; // wrong rank
  s.foundations[0] = [card('spades', 1)]; // wrong suit for a 9 anyway
  assert.equal(wasteDestination(s), null);
});

test('an unplayable waste card stays unplayable however the board is otherwise busy', () => {
  const s = emptyState();
  s.waste = [card('clubs', 6)];
  for (let i = 0; i < 7; i++) s.tableau[i] = [card('spades', 6)]; // same colour, same rank everywhere
  assert.equal(wasteDestination(s), null);
});

test('a playable waste card does resolve, so the flick has something to fire on', () => {
  const s = emptyState();
  s.waste = [card('hearts', 7)];
  s.tableau[3] = [card('spades', 8)];
  assert.deepEqual(wasteDestination(s), { type: 'tableau', index: 3 });
});

// ---------- 5: the destination is the existing logic's, and takes no direction ----------

test('resolveClickDestination has no way to be told a direction', () => {
  // The guarantee behind "flick direction never picks the pile": the
  // resolver's signature is (state, card, source, sourceIndex,
  // stackLength, lastTableauDest) - there is no parameter a gesture
  // could put a heading into even by accident.
  // (.length counts parameters before the first default one.)
  assert.equal(resolveClickDestination.length, 5);
  assert.match(resolveClickDestination.toString().slice(0, 140), /state, card, source, sourceIndex, stackLength/);
  const s = emptyState();
  s.waste = [card('hearts', 7)];
  s.tableau[3] = [card('spades', 8)];
  s.tableau[5] = [card('clubs', 8)];
  // Called identically many times - always the same answer, since
  // nothing about the call can vary with how the card was gestured.
  const answers = new Set(Array.from({ length: 8 }, () => JSON.stringify(wasteDestination(s))));
  assert.equal(answers.size, 1);
  assert.deepEqual(JSON.parse([...answers][0]), { type: 'tableau', index: 3 });
});

test('the existing waste priorities are preserved - foundation for an ace', () => {
  const s = emptyState();
  s.waste = [card('spades', 1)];
  s.tableau[3] = [card('hearts', 2)]; // an ace on a red 2 would be a legal tableau move
  assert.deepEqual(wasteDestination(s), { type: 'foundation', index: 0 });
});

test('the existing waste priorities are preserved - foundation for a two', () => {
  const s = emptyState();
  s.foundations[1] = [card('spades', 1)];
  s.waste = [card('spades', 2)];
  s.tableau[3] = [card('hearts', 3)];
  assert.deepEqual(wasteDestination(s), { type: 'foundation', index: 1 });
});

test('the existing waste priorities are preserved - tableau before foundation otherwise', () => {
  const s = emptyState();
  s.foundations[0] = [card('hearts', 1), card('hearts', 2), card('hearts', 3), card('hearts', 4)];
  s.waste = [card('hearts', 5)];       // legal on the foundation...
  s.tableau[4] = [card('spades', 6)];  // ...and on a black 6
  assert.deepEqual(wasteDestination(s), { type: 'tableau', index: 4 },
    'waste cards prefer the tableau above rank 2 - a flick must not change that');
});

test('a waste card with only a foundation open still goes there', () => {
  const s = emptyState();
  s.foundations[2] = [card('clubs', 1), card('clubs', 2)];
  s.waste = [card('clubs', 3)];
  assert.deepEqual(wasteDestination(s), { type: 'foundation', index: 2 });
});

// ---------- 8/9: the move itself, and undoing it ----------

// Mirrors script.js's own history handling: pushHistory() stores a
// cloneState() before applyMove(), and undo restores it. Tested against
// the same cloneState/applyMove the game uses, so this is the real
// mechanism, not a re-implementation of it.
function commitLikeScriptJs(state, moveCount, cards, source, sourceIndex, target, targetIndex) {
  const history = [cloneState(state)];
  applyMove(state, cards, source, sourceIndex, target, targetIndex);
  return { history, moveCount: moveCount + 1 };
}

test('a flicked waste move applies exactly the move the resolver chose', () => {
  const s = emptyState();
  const seven = card('hearts', 7);
  s.waste = [card('clubs', 4), seven];
  s.tableau[3] = [card('spades', 8)];

  const dest = wasteDestination(s);
  const result = commitLikeScriptJs(s, 0, [seven], 'waste', null, dest.type, dest.index);

  assert.equal(s.waste.length, 1, 'the flicked card left the waste');
  assert.equal(s.tableau[3].length, 2);
  assert.equal(s.tableau[3][1].id, seven.id);
  assert.equal(result.moveCount, 1, 'exactly one move counted');
});

test('undo reverses a flicked waste-to-tableau move exactly', () => {
  const s = emptyState();
  const seven = card('hearts', 7);
  s.waste = [card('clubs', 4), seven];
  s.tableau[3] = [card('spades', 8)];
  const before = JSON.stringify(s);

  const dest = wasteDestination(s);
  const { history } = commitLikeScriptJs(s, 0, [seven], 'waste', null, dest.type, dest.index);
  assert.notEqual(JSON.stringify(s), before, 'the move should have changed something');

  const restored = history.pop();
  assert.equal(JSON.stringify(restored), before, 'undo restores the exact pre-flick board');
});

test('undo reverses a flicked waste-to-foundation move exactly', () => {
  const s = emptyState();
  const ace = card('diamonds', 1);
  s.waste = [card('clubs', 4), ace];
  const before = JSON.stringify(s);

  const dest = wasteDestination(s);
  assert.equal(dest.type, 'foundation');
  const { history } = commitLikeScriptJs(s, 0, [ace], 'waste', null, dest.type, dest.index);
  assert.equal(s.foundations[dest.index].length, 1);

  assert.equal(JSON.stringify(history.pop()), before);
});

test('a flicked move that completes a foundation is still just a normal move', () => {
  // Win detection counts foundation cards after render(); nothing about
  // the flick path changes what lands there.
  const s = emptyState();
  const king = card('hearts', 13);
  s.foundations[0] = Array.from({ length: 12 }, (_, i) => card('hearts', i + 1));
  s.waste = [king];
  // No empty column anywhere - otherwise a King legally prefers one (see
  // canPlaceOnTableau), which is existing behaviour, not a flick concern.
  for (let i = 0; i < 7; i++) s.tableau[i] = [card('clubs', 5)];
  const dest = wasteDestination(s);
  assert.deepEqual(dest, { type: 'foundation', index: 0 });
  applyMove(s, [king], 'waste', null, dest.type, dest.index);
  assert.equal(s.foundations[0].length, 13);
});

// ---------- 7/9/10/11/12: structural guarantees in script.js ----------
//
// script.js is the DOM/orchestration layer and is deliberately not
// unit-tested in this repo (see CLAUDE.md) - it's verified in-browser
// instead. These are not a substitute for that. They lock in the small
// number of STRUCTURAL promises the flick makes, the ones a future edit
// could quietly break without any test noticing: that the flick performs
// the canonical move exactly once and never grows its own, that it can't
// escape the waste, and that it still has a reduced-motion path.

const SCRIPT_RAW = readFileSync(new URL('./script.js', import.meta.url), 'utf8');

// Comments are stripped before any of these scans: several of them ask
// whether a function CALLS something, and the surrounding comments in
// script.js legitimately mention those same names in prose.
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function functionBody(name) {
  const start = SCRIPT_RAW.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} should exist in script.js`);
  let depth = 0, i = SCRIPT_RAW.indexOf('{', start);
  const from = i;
  for (; i < SCRIPT_RAW.length; i++) {
    if (SCRIPT_RAW[i] === '{') depth++;
    else if (SCRIPT_RAW[i] === '}' && --depth === 0) return stripComments(SCRIPT_RAW.slice(from, i + 1));
  }
  throw new Error(`could not find the end of ${name}`);
}

test('the flick commits the canonical move exactly once per path', () => {
  const body = functionBody('executeFlickMove');
  const commits = body.match(/\bcommitMove\(/g) || [];
  // Two call sites, one per branch: the reduced-motion early return and
  // the flight's deferred commit. They are mutually exclusive - the
  // first branch returns - so any given flick commits exactly once.
  assert.equal(commits.length, 2, `expected one commit per branch, found ${commits.length}`);
  // One belongs to the reduced-motion branch, which returns; the other
  // lives inside the deferred pendingFlickCommit closure and only runs
  // from flushPendingFlick.
  const reduced = body.slice(0, body.indexOf('pendingFlickCommit = () => {'));
  assert.equal((reduced.match(/\bcommitMove\(/g) || []).length, 1, 'exactly one commit in the reduced-motion branch');
  assert.match(reduced, /commitMove\([\s\S]{0,400}?return;/, 'the reduced-motion branch must return');
  const deferred = body.slice(body.indexOf('pendingFlickCommit = () => {'));
  assert.equal((deferred.match(/\bcommitMove\(/g) || []).length, 1, 'exactly one commit in the deferred closure');
});

test('the pending commit can only ever run once', () => {
  // It is reachable from the landing callback AND from every state
  // entry point that might overtake it, so the once-guard is what stops
  // a move being applied twice.
  const body = functionBody('flushPendingFlick');
  assert.match(body, /if \(!pendingFlickCommit\) return;/, 'a no-op when nothing is pending');
  assert.match(body, /pendingFlickCommit = null;[\s\S]{0,40}commit\(\);/,
    'the handle must be cleared BEFORE running, so a re-entrant call cannot run it again');
});

test('the move is not contingent on the animation finishing', () => {
  // The commit rides a setTimeout, not the animation's finished
  // promise: a cancelled animation, or a tab backgrounded mid-flight
  // (where rAF stops but timers do not), must still land the move.
  const body = functionBody('animateFlickGhost');
  assert.match(body, /setTimeout\(onDone, ms \+ FLICK_CLEANUP_BUFFER_MS\)/,
    'the completion callback must be timer-driven');
  assert.ok(!body.includes('.finished'), 'never gated on animation.finished');
  assert.ok(!body.includes('addEventListener(\'finish\'') && !body.includes('onfinish'),
    'nor on a finish event');
});

test('every state entry point settles an in-flight flick first', () => {
  // While a flick is in the air `state` still holds the card in the
  // waste. Anything that reads or mutates state has to settle it first
  // or it will act on a board that is about to change.
  for (const fn of ['newGame', 'restart', 'startAutoFinish', 'undo', 'onStockClick']) {
    const body = functionBody(fn);
    const firstStatement = body.slice(0, 260);
    assert.match(firstStatement, /flushPendingFlick\(\)/, `${fn} must flush the pending flick before touching state`);
  }
});

test('a card in flight cannot be picked up again', () => {
  // Two things together make this safe. The pile is redrawn without the
  // departing card the moment it launches, so its element is gone from
  // the DOM entirely - there is nothing left to press. And startDrag
  // settles any pending flick before reading the board, so the next card
  // is played against the real post-move state rather than a stale one.
  const drag = functionBody('startDrag');
  assert.match(drag.slice(0, 500), /flushPendingFlick\(\);/,
    'startDrag must settle a pending flick before it reads state');
  const flight = functionBody('executeFlickMove');
  assert.match(flight, /renderWaste\(stack\[0\]\.id\)/,
    'the launching card must be dropped from the pile immediately');
  assert.match(functionBody('renderWaste'), /departingCardId/,
    'renderWaste has to support omitting it');
});

test('settling a flick early takes its ghost down with it', () => {
  // Otherwise the card would be painted at its destination by the
  // commit while the abandoned ghost was still flying toward it.
  const body = functionBody('flushPendingFlick');
  assert.match(body, /pendingFlickTeardown/);
  assert.match(body, /commit\(\);[\s\S]{0,80}teardown\(\)/,
    'commit first so the real card exists, then remove the ghost');
  assert.match(functionBody('executeFlickMove'), /pendingFlickTeardown = \(\) => \{ ghosts\.wrappers/);
});

test('the flick does not resolve its own destination', () => {
  const body = functionBody('executeFlickMove');
  assert.ok(!body.includes('resolveClickDestination'),
    'the destination must arrive as an argument, from the same resolver tap-to-move uses');
  assert.ok(!body.includes('getLegalMoves'), 'legality is never re-derived here');
});

test('there is exactly one call to the shared destination resolver', () => {
  const calls = stripComments(SCRIPT_RAW).match(/\bresolveClickDestination\(/g) || [];
  assert.equal(calls.length, 1,
    'tap-to-move and the flick must both reach it through resolveMoveDestination()');
  assert.ok(functionBody('resolveMoveDestination').includes('resolveClickDestination('));
});

test('the board is never rebuilt while the card is flying', () => {
  // commitMove ends in render(), which empties and rebuilds all
  // thirteen piles - measured at 91ms of blocked main thread on an
  // iPhone. Anywhere inside the flight that is a visible freeze, so the
  // flight's commit is prepared up front but deferred to the landing.
  const body = functionBody('executeFlickMove');
  const launch = body.indexOf('animateFlickGhost(');
  assert.ok(launch !== -1);
  const prepared = body.indexOf('pendingFlickCommit = () => {');
  assert.ok(prepared !== -1 && prepared < launch, 'the commit is prepared before the launch but not run');
  // The only commitMove reached before the launch belongs to the
  // reduced-motion branch, which returns before the flight exists.
  const beforeLaunch = body.slice(0, prepared);
  assert.match(beforeLaunch, /if \(!plan\)[\s\S]*?commitMove\([\s\S]{0,400}?return;/,
    'the only pre-launch commit is the reduced-motion branch, and it returns');
  assert.match(body.slice(launch), /flushPendingFlick\(\)/, 'the flight commits from its landing callback');
});

test('the flick records its own duration for win detection', () => {
  // The winning move can be a waste card flicked to a foundation, and a
  // flick takes ~3x a normal glide - checkWin reads lastMoveGlideMs to
  // know how long to wait before the celebration.
  const body = functionBody('executeFlickMove');
  assert.ok(body.includes('lastMoveGlideMs = durationMs'));
  assert.match(body, /durationMs = plan \? plan\.durationMs : MOVE_GLIDE_MS/,
    'the recorded duration must be this flight\'s own, not a fixed guess');
  assert.ok(body.indexOf('lastMoveGlideMs') < body.indexOf('commitMove('),
    'it must be set before commitMove, whose render() calls checkWin synchronously');
});

test('reduced motion skips the flight, not the move', () => {
  const body = functionBody('executeFlickMove');
  assert.ok(body.includes('prefers-reduced-motion'), 'executeFlickMove must check the preference');
  // The preference decides only whether a flight plan exists; commitMove
  // and the reveal sit outside that branch entirely, so the move, its
  // destination and its bookkeeping are literally the same code either
  // way - only the animation differs.
  assert.match(body, /prefers-reduced-motion[^\n]*\.matches \? null : flickPlan\(/,
    'reduced motion should null out the flight plan, not fork the move');
  assert.ok(body.includes('glideGhostsTo('), 'with no plan it falls back to the ordinary card-move glide');
  assert.match(body, /if \(!plan\)[\s\S]{0,400}glideGhostsTo\(/);
  const reduced = body.slice(body.indexOf('if (!plan)'), body.indexOf('animateFlickGhost('));
  assert.ok(!reduced.includes('flickKeyframes('), 'and none of the dramatic flight');
  assert.ok(!reduced.includes('runAfterLaunchFrame('), 'reduced motion keeps the original synchronous ordering');
  assert.ok(functionBody('playFlickRefusal').includes('prefers-reduced-motion'));
});

test('flick detection does not depend on a frame having been rendered', () => {
  // processDragFrame runs on rAF, so `moved` can still be false at
  // pointerup for a flick fast enough to outrun a frame - which is
  // exactly the hardest flick a player can make. onDragEnd must classify
  // from the samples regardless, and must check for a flick BEFORE
  // falling back to the tap branch, or the most emphatic flicks would
  // silently degrade into plain tap-to-move.
  const body = functionBody('onDragEnd');
  assert.match(body, /onset: movedAt \|\| undefined/,
    'the classifier must be allowed to derive the onset when no frame stamped one');
  assert.ok(body.indexOf("kind === 'flick'") < body.indexOf('if (!moved)'),
    'the flick check must come before the tap fallback');
  assert.match(body, /if \(!moved\) originEls\.forEach/,
    'a flick that outran the frame must still hide the origin the frame would have hidden');
});

test('the release point is recorded before the gesture is classified', () => {
  const body = functionBody('onDragEnd');
  assert.ok(body.indexOf('recordPointerSample(') < body.indexOf('classifyPointerGesture('),
    'release velocity is the whole question - the pointerup point has to be in the samples');
});

test('the travel budget is measured against the live layout, not a constant', () => {
  const body = functionBody('onDragEnd');
  assert.match(body, /cardWidthPx: originRects\[0\]\.width/, 'card size comes from the real rendered card');
  assert.match(body, /viewportMinPx: Math\.min\(window\.innerWidth, window\.innerHeight\)/);
});

test('the flick is gated on the shared source rule, not an inline string test', () => {
  assert.ok(stripComments(SCRIPT_RAW).includes('isFlickableSource(source)'),
    'onDragEnd must use flick.js\'s own scope predicate');
  assert.ok(!/kind === 'flick'[^)]*source === '/.test(stripComments(SCRIPT_RAW)),
    'no second, inline copy of the source rule');
});

test('the flying card is the complete composited drag ghost, not a bare image', () => {
  // The regression this guards: a temporary layer built from just the
  // face image loses the card element around it (and can show the worn
  // background without the rank/suit art). executeFlickMove must reuse
  // the ghosts it was handed - which createGhostStack built with
  // makeCardEl, the same function that renders a real card.
  const body = functionBody('executeFlickMove');
  for (const forbidden of ['createPositionedGhost(', 'createFlipGhost(', 'createElement(', 'cardImageSrc(', '.src =']) {
    assert.ok(!body.includes(forbidden),
      `executeFlickMove must not build or re-source its own card layer (${forbidden})`);
  }
  assert.ok(body.includes('ghosts.wrappers[0]') && body.includes('ghosts.visuals[0]'),
    'it should fly the existing drag ghost');
  assert.ok(functionBody('createGhostStack').includes('makeCardEl('),
    'and that ghost is built from the same element a real card is');
});
