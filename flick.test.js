import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  classifyPointerGesture,
  releaseVelocity,
  flickIntensity,
  flickPlan,
  flickKeyframes,
  flickCurve,
  launchDistance,
  flickRefusalKeyframes,
  isFlickableSource,
  FLICK_MIN_RELEASE_SPEED_PX_MS,
  FLICK_MAX_RELEASE_SPEED_PX_MS,
  FLICK_MAX_TRAVEL_CARD_WIDTHS,
  FLICK_MAX_TRAVEL_VIEWPORT_FRACTION,
  maxFlickTravelPx,
  FLICK_MIN_BURST_PX,
  FLICK_MIN_MS,
  FLICK_MAX_MS,
} from './flick.js';

const CARD_W = 140;
const DRAG_THRESHOLD_PX = 4; // mirrors script.js's own constant

// Builds a pointer path the way the browser would hand it over: press
// point first, release point last, evenly spaced in time. `pxPerMs` is
// the speed maintained right through the release, which is what
// classification actually keys on.
function gesture({ dx, dy, pxPerMs, steps = 8, t0 = 1000 }) {
  const distance = Math.hypot(dx, dy);
  const totalMs = distance / pxPerMs;
  const samples = [];
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    samples.push({ x: 200 + dx * f, y: 300 + dy * f, t: t0 + totalMs * f });
  }
  return samples;
}

function classify(samples) {
  return classifyPointerGesture({ samples, dragThresholdPx: DRAG_THRESHOLD_PX, cardWidthPx: CARD_W });
}

// ---------- 1/2/3: tap vs drag vs flick ----------

test('a fast, short gesture classifies as a flick', () => {
  const g = classify(gesture({ dx: 120, dy: -40, pxPerMs: 2.4 }));
  assert.equal(g.kind, 'flick');
  assert.ok(g.speed >= FLICK_MIN_RELEASE_SPEED_PX_MS);
});

test('flicks are recognised in every direction, not just horizontally', () => {
  for (const [dx, dy] of [[130, 0], [-130, 0], [0, -130], [0, 130], [95, 95], [-95, 95], [95, -95], [-95, -95]]) {
    assert.equal(classify(gesture({ dx, dy, pxPerMs: 2.4 })).kind, 'flick', `direction ${dx},${dy}`);
  }
});

test('the same short travel, made slowly, stays a drag', () => {
  const g = classify(gesture({ dx: 120, dy: -40, pxPerMs: 0.25 }));
  assert.equal(g.kind, 'drag');
});

test('a long fast drag across the board is a drag, not a flick', () => {
  // Fast the whole way, but far further than a flick's travel budget.
  const g = classify(gesture({ dx: CARD_W * FLICK_MAX_TRAVEL_CARD_WIDTHS + 60, dy: 0, pxPerMs: 2.5 }));
  assert.equal(g.kind, 'drag');
});

test('a drag that decelerates to place the card is a drag, however fast it started', () => {
  // The exact shape of a deliberate drag-to-a-pile: quick travel, then
  // the pointer settles on the target before releasing.
  const samples = gesture({ dx: 150, dy: 60, pxPerMs: 3.0 });
  const last = samples[samples.length - 1];
  for (let i = 1; i <= 6; i++) samples.push({ x: last.x + (i % 2), y: last.y, t: last.t + i * 18 });
  assert.equal(classify(samples).kind, 'drag');
});

test('a near-motionless press and release stays a tap', () => {
  const g = classify(gesture({ dx: 2, dy: 1, pxPerMs: 3.0 }));
  assert.equal(g.kind, 'tap');
});

test('a tap is decided by the same threshold the drag code uses', () => {
  const justUnder = classify(gesture({ dx: DRAG_THRESHOLD_PX - 0.5, dy: 0, pxPerMs: 3 }));
  const justOver = classify(gesture({ dx: DRAG_THRESHOLD_PX + 40, dy: 0, pxPerMs: 3 }));
  assert.equal(justUnder.kind, 'tap');
  assert.notEqual(justOver.kind, 'tap');
});

test('resting on the card before snapping it does not stop it being a flick', () => {
  // The gesture people actually make: press, settle, then snap. The
  // stationary time before the snap must not dilute the measurement.
  const samples = [{ x: 200, y: 300, t: 0 }];
  for (let t = 16; t < 600; t += 16) samples.push({ x: 200 + (t % 3) * 0.4, y: 300, t }); // resting, with fingertip jitter
  const base = samples[samples.length - 1].t;
  for (let i = 1; i <= 3; i++) samples.push({ x: 200 - 25 * i / 3, y: 300, t: base + 12 * i }); // a 25px snap in 36ms
  const g = classifyPointerGesture({ samples, dragThresholdPx: DRAG_THRESHOLD_PX, cardWidthPx: CARD_W });
  assert.equal(g.kind, 'flick', `held for 600ms then snapped, measured ${g.speed.toFixed(2)} px/ms`);
  assert.ok(g.dirX < -0.9, 'and it should know the snap went left');
});

test('a flick is recognised even when no frame observed the drag threshold', () => {
  // onset comes from processDragFrame, which runs on rAF; a fast enough
  // snap can finish before any frame does. Flick recognition must not
  // depend on it.
  const samples = gesture({ dx: -30, dy: 0, pxPerMs: 1.0 });
  assert.equal(classifyPointerGesture({ samples, onset: null, cardWidthPx: CARD_W }).kind, 'flick');
  assert.equal(classifyPointerGesture({ samples, onset: undefined, dragThresholdPx: DRAG_THRESHOLD_PX, cardWidthPx: CARD_W }).kind, 'flick');
});

test('a phone-sized thumb flick is not mistaken for a drag', () => {
  // A phone's cards are ~50px wide, so the card-relative budget alone is
  // only ~120px - shorter than an ordinary thumb flick. The viewport
  // floor is what keeps such a flick classified correctly.
  const phoneCard = 50, phoneViewportMin = 375;
  const thumbTravel = 165; // well past 2.4 card widths, well within a thumb's reach
  assert.ok(thumbTravel > phoneCard * FLICK_MAX_TRAVEL_CARD_WIDTHS, 'the card-relative budget alone would reject this');
  assert.equal(
    classifyPointerGesture({
      samples: gesture({ dx: -thumbTravel, dy: 30, pxPerMs: 2.6 }),
      dragThresholdPx: DRAG_THRESHOLD_PX, cardWidthPx: phoneCard, viewportMinPx: phoneViewportMin,
    }).kind,
    'flick',
  );
  // Still bounded: carrying a card most of the way across the phone is a drag.
  assert.equal(
    classifyPointerGesture({
      samples: gesture({ dx: -330, dy: 30, pxPerMs: 2.6 }),
      dragThresholdPx: DRAG_THRESHOLD_PX, cardWidthPx: phoneCard, viewportMinPx: phoneViewportMin,
    }).kind,
    'drag',
  );
});

test('the travel budget takes whichever anchor is larger, and never shrinks', () => {
  // Either anchor may bind depending on the layout; what matters is that
  // adding the viewport can only ever widen the budget, never narrow it.
  for (const [card, viewport] of [[140, 860], [170, 1080], [50, 375], [84, 667], [152, 860]]) {
    const both = maxFlickTravelPx(card, viewport);
    assert.ok(both >= card * FLICK_MAX_TRAVEL_CARD_WIDTHS, `${card}/${viewport}`);
    assert.ok(both >= viewport * FLICK_MAX_TRAVEL_VIEWPORT_FRACTION, `${card}/${viewport}`);
    assert.equal(both, Math.max(card * FLICK_MAX_TRAVEL_CARD_WIDTHS, viewport * FLICK_MAX_TRAVEL_VIEWPORT_FRACTION));
  }
  assert.equal(maxFlickTravelPx(50), 50 * FLICK_MAX_TRAVEL_CARD_WIDTHS, 'omitting the viewport must not enlarge the budget');
});

test('thresholds scale with the card, so a phone-sized layout behaves the same', () => {
  const small = 84;
  const travel = small * FLICK_MAX_TRAVEL_CARD_WIDTHS * 0.8;
  assert.equal(
    classifyPointerGesture({ samples: gesture({ dx: travel, dy: 0, pxPerMs: 2.4 }), dragThresholdPx: DRAG_THRESHOLD_PX, cardWidthPx: small }).kind,
    'flick',
  );
  // The same pixel travel is over budget on the smaller card once it
  // exceeds that card's own allowance.
  assert.equal(
    classifyPointerGesture({ samples: gesture({ dx: small * FLICK_MAX_TRAVEL_CARD_WIDTHS + 40, dy: 0, pxPerMs: 2.4 }), dragThresholdPx: DRAG_THRESHOLD_PX, cardWidthPx: small }).kind,
    'drag',
  );
});

// ---------- the short-sharp-snap target ----------
//
// These encode the gesture this was retuned around: a small, fast
// movement, of the kind you'd use to physically flick a card. Traces are
// built at realistic pointer-sampling rates, because at 60Hz a 35ms
// gesture yields only three or four samples and that scarcity is part of
// the problem the classifier has to survive.

// A finger snap: accelerating into the release, sampled at `hz`.
function snap({ px, ms, hz = 60, holdMs = 0, decelerate = false }) {
  const step = 1000 / hz;
  const samples = [{ x: 0, y: 0, t: 0 }];
  for (let t = step; t < holdMs; t += step) samples.push({ x: 0, y: 0, t });
  for (let t = step; t <= ms; t += step) {
    const u = t / ms;
    samples.push({ x: px * (decelerate ? 1 - (1 - u) * (1 - u) : 0.6 * u * u + 0.4 * u), y: 0, t: holdMs + t });
  }
  samples.push({ x: px, y: 0, t: holdMs + ms });
  return samples;
}
const phone = samples => classifyPointerGesture({ samples, dragThresholdPx: DRAG_THRESHOLD_PX, cardWidthPx: 50, viewportMinPx: 375 });

test('a sharp ~25px snap is a flick, at any realistic sampling rate', () => {
  for (const hz of [60, 90, 120, 240]) {
    const g = phone(snap({ px: -25, ms: 35, hz }));
    assert.equal(g.kind, 'flick', `${hz}Hz: measured ${g.speed.toFixed(2)} px/ms`);
  }
});

test('the whole 15-35px band snaps', () => {
  for (const px of [15, 20, 25, 30, 35]) {
    const g = phone(snap({ px: -px, ms: Math.max(25, px * 1.4), hz: 60 }));
    assert.equal(g.kind, 'flick', `${px}px snap measured ${g.speed.toFixed(2)} px/ms`);
  }
});

test('a lazier 25px snap still counts - the band is not knife-edge', () => {
  // Measured in-browser at 0.55 px/ms; this is the gesture that was
  // landing just the wrong side of the line before the threshold moved.
  const g = phone(snap({ px: -25, ms: 67 }));
  assert.equal(g.kind, 'flick', `measured ${g.speed.toFixed(2)} px/ms`);
});

test('the same 25px made slowly is still a drag', () => {
  for (const ms of [200, 300, 500, 900]) {
    const g = phone(snap({ px: -25, ms }));
    assert.equal(g.kind, 'drag', `25px over ${ms}ms measured ${g.speed.toFixed(2)} px/ms`);
  }
});

test('there is a wide margin between a snap and a deliberate movement', () => {
  const sharp = phone(snap({ px: -25, ms: 35 })).speed;
  const slow = phone(snap({ px: -25, ms: 300 })).speed;
  assert.ok(sharp > FLICK_MIN_RELEASE_SPEED_PX_MS * 1.3, `sharp ${sharp.toFixed(2)} is too close to the threshold`);
  assert.ok(slow < FLICK_MIN_RELEASE_SPEED_PX_MS * 0.5, `slow ${slow.toFixed(2)} is too close to the threshold`);
  assert.ok(sharp / slow > 4, `only ${(sharp / slow).toFixed(1)}x between a snap and a deliberate move`);
});

test('a deliberate drag that decelerates to place the card stays a drag', () => {
  for (const px of [120, 200, 300]) {
    const g = phone(snap({ px: -px, ms: px * 2.2, decelerate: true }));
    assert.equal(g.kind, 'drag', `${px}px placement measured ${g.speed.toFixed(2)} px/ms`);
  }
});

test('fingertip jitter alone can never be a flick, however fast it reads', () => {
  // A 3px twitch between two samples 4ms apart is 0.75 px/ms - over the
  // speed threshold. FLICK_MIN_BURST_PX is what rejects it.
  const samples = [{ x: 0, y: 0, t: 0 }, { x: 0, y: 0, t: 300 }, { x: 3, y: 0, t: 304 }];
  assert.notEqual(classifyPointerGesture({ samples, dragThresholdPx: DRAG_THRESHOLD_PX, cardWidthPx: 50 }).kind, 'flick');
  assert.ok(FLICK_MIN_BURST_PX > 3);
});

// ---------- release velocity ----------

test('releaseVelocity measures speed at the end, not the average', () => {
  const samples = [
    { x: 0, y: 0, t: 0 },
    { x: 10, y: 0, t: 500 },   // crawling
    { x: 40, y: 0, t: 520 },   // then a sudden flick
    { x: 100, y: 0, t: 545 },
  ];
  const v = releaseVelocity(samples);
  const wholeGestureAverage = 100 / 545;
  assert.ok(v.speed > 1.8, `expected a fast release, got ${v.speed}`);
  assert.ok(v.speed > wholeGestureAverage * 8, 'release speed must reflect the end of the gesture, not all of it');
});

test('releaseVelocity reports ~zero after a pause, which is what keeps a paused drag a drag', () => {
  const samples = [
    { x: 0, y: 0, t: 0 },
    { x: 200, y: 0, t: 80 },   // fast travel...
    { x: 201, y: 0, t: 300 },  // ...then held still before letting go
    { x: 201, y: 0, t: 400 },
  ];
  assert.ok(releaseVelocity(samples).speed < 0.05);
});

test('releaseVelocity is defined for degenerate input', () => {
  assert.equal(releaseVelocity([]).speed, 0);
  assert.equal(releaseVelocity([{ x: 0, y: 0, t: 0 }]).speed, 0);
  assert.equal(releaseVelocity([{ x: 0, y: 0, t: 5 }, { x: 9, y: 9, t: 5 }]).speed, 0);
});

// ---------- intensity ----------

test('intensity spans 0..1 across the usable speed range and clamps outside it', () => {
  assert.equal(flickIntensity(FLICK_MIN_RELEASE_SPEED_PX_MS), 0);
  assert.equal(flickIntensity(FLICK_MAX_RELEASE_SPEED_PX_MS), 1);
  assert.equal(flickIntensity(0.2), 0);
  assert.equal(flickIntensity(40), 1, 'an absurd pointer speed must not scale past the tested range');
});

// ---------- 11: scope ----------

test('a flick may start from the waste, the tableau or a foundation - never the stock', () => {
  for (const source of ['waste', 'tableau', 'foundation']) {
    assert.equal(isFlickableSource(source), true, `${source} should offer the gesture`);
  }
  // The stock is not merely disallowed, it is unreachable: it is not
  // draggable and carries no card interactions, so no gesture on it can
  // ever produce a flick regardless of what this predicate says.
  assert.equal(isFlickableSource('stock'), false);
  assert.equal(isFlickableSource('nonsense'), false);
});

test('this predicate is about PILES, not about how many cards would move', () => {
  // Deliberate division of labour: flick.js knows no Solitaire rules, so
  // it cannot decide whether a given press would move one card or a run.
  // That half lives in script.js's isFlickEligible, which asks
  // getStackFrom. A tableau source passes here and can still be refused
  // there - which is what protects multi-card runs.
  assert.equal(isFlickableSource('tableau'), true);
  // Comments stripped: the file's own prose legitimately points at
  // getStackFrom to say where the other half of the rule lives. What must
  // stay absent is CODE reaching for it.
  const src = readFileSync(new URL('./flick.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  assert.ok(!/getStackFrom|state\.|stackLength|\.length > 1/.test(src),
    'flick.js must not start reasoning about how many cards a source would move');
});

// ---------- flight plan ----------

const FROM = { x: 200, y: 120 };
const DESTINATIONS = [
  ['tableau 3', { x: 560, y: 330 }],
  ['tableau 0', { x: 120, y: 330 }],
  ['tableau 6', { x: 920, y: 330 }],
  ['foundation', { x: 700, y: 120 }],
  ['near pile', { x: 290, y: 330 }],
];
const DIRECTIONS = [
  ['left', -1, 0], ['right', 1, 0], ['up', 0, -1], ['down', 0, 1],
  ['down-right', 0.707, 0.707], ['up-left', -0.707, -0.707],
  ['up-right', 0.707, -0.707], ['down-left', -0.707, 0.707],
];

function plan(to, dirX, dirY, intensity = 0.5) {
  return flickPlan({ from: FROM, to, dirX, dirY, intensity, cardWidthPx: CARD_W });
}

function pathLength(frames) {
  let total = 0;
  for (let i = 1; i < frames.length; i++) total += Math.hypot(frames[i].x - frames[i - 1].x, frames[i].y - frames[i - 1].y);
  return total;
}

// ---------- 5/6: the destination is an input, never derived from direction ----------

test('every flick direction lands on the destination it was given', () => {
  for (const [dname, to] of DESTINATIONS) {
    for (const [name, dx, dy] of DIRECTIONS) {
      const frames = flickKeyframes(plan(to, dx, dy));
      const last = frames[frames.length - 1];
      assert.equal(last.offset, 1);
      assert.equal(last.x, to.x, `${dname} flicked ${name}`);
      assert.equal(last.y, to.y, `${dname} flicked ${name}`);
    }
  }
});

test('flicking left and right produce the same landing spot', () => {
  const to = { x: 560, y: 330 };
  const left = flickKeyframes(plan(to, -1, 0));
  const right = flickKeyframes(plan(to, 1, 0));
  const endOf = f => [f[f.length - 1].x, f[f.length - 1].y];
  assert.deepEqual(endOf(left), endOf(right));
  assert.deepEqual(endOf(left), [to.x, to.y]);
  // ...by genuinely different routes, not because direction is ignored.
  const midLeft = left[Math.floor(left.length / 3)];
  const midRight = right[Math.floor(right.length / 3)];
  assert.ok(Math.hypot(midLeft.x - midRight.x, midLeft.y - midRight.y) > CARD_W,
    'the two flights should diverge substantially in mid-air');
});

test('the launch heads the way the card was flicked', () => {
  for (const [name, dx, dy] of DIRECTIONS) {
    const frames = flickKeyframes(plan({ x: 560, y: 330 }, dx, dy));
    const early = frames[3];
    const heading = Math.atan2(early.y - FROM.y, early.x - FROM.x);
    const intended = Math.atan2(dy, dx);
    let delta = Math.abs(heading - intended);
    if (delta > Math.PI) delta = 2 * Math.PI - delta;
    assert.ok(delta < 0.45, `${name}: launch ${(delta * 180 / Math.PI).toFixed(1)}deg off the flick direction`);
  }
});

// ---------- boomerang shape ----------

test('the flight is a boomerang, not a straight line', () => {
  for (const [dname, to] of DESTINATIONS) {
    const direct = Math.hypot(to.x - FROM.x, to.y - FROM.y);
    for (const [name, dx, dy] of DIRECTIONS) {
      const travelled = pathLength(flickKeyframes(plan(to, dx, dy)));
      assert.ok(travelled > direct * 1.5,
        `${dname} flicked ${name}: travelled ${travelled.toFixed(0)}px for a ${direct.toFixed(0)}px move (ratio ${(travelled / direct).toFixed(2)})`);
    }
  }
});

test('the card gets clear of the waste before it turns back', () => {
  // Early in the flight it must be somewhere neither the start nor the
  // destination explains - that excursion is what "flung away" means.
  for (const [dname, to] of DESTINATIONS) {
    for (const [name, dx, dy] of DIRECTIONS) {
      const frames = flickKeyframes(plan(to, dx, dy));
      const quarter = frames[Math.round((frames.length - 1) * 0.25)];
      const gone = Math.hypot(quarter.x - FROM.x, quarter.y - FROM.y);
      assert.ok(gone > CARD_W * 0.8,
        `${dname} flicked ${name}: only ${gone.toFixed(0)}px from the pile a quarter of the way in`);
    }
  }
});

test('the flight never doubles back on itself into a hairpin', () => {
  for (const [dname, to] of DESTINATIONS) {
    for (const [name, dx, dy] of DIRECTIONS) {
      const frames = flickKeyframes(plan(to, dx, dy));
      for (let i = 2; i < frames.length; i++) {
        const ax = frames[i - 1].x - frames[i - 2].x, ay = frames[i - 1].y - frames[i - 2].y;
        const bx = frames[i].x - frames[i - 1].x, by = frames[i].y - frames[i - 1].y;
        const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
        if (la < 0.5 || lb < 0.5) continue;
        const cos = (ax * bx + ay * by) / (la * lb);
        assert.ok(cos > 0.2,
          `${dname} flicked ${name}: turned ${(Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI).toFixed(0)}deg in one frame at sample ${i}`);
      }
    }
  }
});

// ---------- speed profile ----------

test('the launch is the fastest part and the landing the slowest', () => {
  const frames = flickKeyframes(plan({ x: 560, y: 330 }, -1, 0));
  const step = i => Math.hypot(frames[i].x - frames[i - 1].x, frames[i].y - frames[i - 1].y);
  const first = step(1);
  const middle = step(Math.floor(frames.length / 2));
  const last = step(frames.length - 1);
  assert.ok(first > middle * 1.5, `launch ${first.toFixed(1)}px vs mid ${middle.toFixed(1)}px`);
  assert.ok(middle > last * 1.5, `mid ${middle.toFixed(1)}px vs landing ${last.toFixed(1)}px`);
});

test('the card never speeds back up mid-flight', () => {
  for (const [dname, to] of DESTINATIONS) {
    for (const [name, dx, dy] of DIRECTIONS) {
      const frames = flickKeyframes(plan(to, dx, dy));
      const steps = [];
      for (let i = 1; i < frames.length; i++) steps.push(Math.hypot(frames[i].x - frames[i - 1].x, frames[i].y - frames[i - 1].y));
      const peak = Math.max(...steps);
      for (let i = 1; i < steps.length; i++) {
        // A generous tolerance: this is guarding against a stall-then-
        // surge, not policing arc-table rounding.
        assert.ok(steps[i] <= steps[i - 1] + peak * 0.08,
          `${dname} flicked ${name}: sped up from ${steps[i - 1].toFixed(1)} to ${steps[i].toFixed(1)} at sample ${i}`);
      }
    }
  }
});

// ---------- velocity -> intensity effects ----------

test('a harder flick throws the card further than a moderate one', () => {
  const to = { x: 560, y: 330 };
  const moderate = launchDistance({ from: FROM, to, dir: { x: -1, y: 0 }, cardWidthPx: CARD_W, intensity: 0 });
  const hard = launchDistance({ from: FROM, to, dir: { x: -1, y: 0 }, cardWidthPx: CARD_W, intensity: 1 });
  assert.ok(hard > moderate * 1.3, `moderate ${moderate.toFixed(0)}px vs hard ${hard.toFixed(0)}px`);
});

test('a harder flick spins more, within a tasteful range', () => {
  const to = { x: 560, y: 330 };
  const moderate = plan(to, -1, 0, 0).turns;
  const hard = plan(to, -1, 0, 1).turns;
  assert.equal(moderate, 4, 'a moderate flick should be about four turns');
  assert.equal(hard, 6, 'a hard flick should be about six turns');
  for (const i of [0, 0.25, 0.5, 0.75, 1]) {
    const turns = plan(to, -1, 0, i).turns;
    assert.ok(turns >= 4 && turns <= 6, `intensity ${i} gave ${turns} turns`);
  }
});

// Measured off the emitted keyframes rather than the easing parameters,
// so these describe what actually renders.
function spinRate(frames, plan, atFraction) {
  const i = Math.round((frames.length - 1) * atFraction);
  const j = Math.min(frames.length - 1, i + 1);
  const msPerFrame = plan.durationMs / (frames.length - 1);
  return Math.abs(frames[j].spinDeg - frames[i].spinDeg) / msPerFrame * (1000 / 60);
}
function spinDone(frames, atFraction) {
  const total = Math.abs(frames[frames.length - 1].spinDeg);
  return total === 0 ? 1 : Math.abs(frames[Math.round((frames.length - 1) * atFraction)].spinDeg) / total;
}

test('no flight ever steps past the wagon-wheel limit between frames', () => {
  // Past ~180deg in one rendered frame rotation aliases and visually
  // reverses, so the fastest moment would read as the slowest.
  for (const [dname, to] of DESTINATIONS) {
    for (const [name, dx, dy] of DIRECTIONS) {
      for (const i of [0, 0.35, 0.7, 1]) {
        const p = plan(to, dx, dy, i);
        const peak = spinRate(flickKeyframes(p), p, 0);
        assert.ok(peak <= 180, `${dname} ${name} @${i}: ${peak.toFixed(0)}deg/frame`);
      }
    }
  }
});

test('the spin holds a constant rate for almost the whole flight', () => {
  // The card must still be turning at full speed whenever it is on
  // screen, which for a big flick means the entire return leg. An
  // ease-out spends its rotation while the card is away and leaves only
  // the dead tail visible (measured: 0.6 of 6 turns).
  for (const i of [0, 0.5, 1]) {
    const p = plan({ x: 560, y: 330 }, -1, 0, i);
    const frames = flickKeyframes(p);
    const rates = [0.1, 0.3, 0.5, 0.7, 0.85].map(f => spinRate(frames, p, f));
    const lo = Math.min(...rates), hi = Math.max(...rates);
    assert.ok(hi - lo < hi * 0.06,
      `intensity ${i}: rate should be flat through the cruise, got ${rates.map(r => r.toFixed(0)).join('/')}`);
  }
});

test('progress through the cruise is linear, not front-loaded', () => {
  const frames = flickKeyframes(plan({ x: 560, y: 330 }, -1, 0, 1));
  for (const f of [0.1, 0.3, 0.5, 0.7]) {
    const done = spinDone(frames, f);
    assert.ok(Math.abs(done - f) < 0.09, `at t=${f} expected ~${f} of the spin, got ${done.toFixed(2)}`);
  }
});

test('the settle is late and quick, and stops dead', () => {
  const p = plan({ x: 560, y: 330 }, -1, 0, 1);
  const frames = flickKeyframes(p);
  const cruise = spinRate(frames, p, 0.5);
  assert.ok(spinDone(frames, 0.85) > 0.85, 'still cruising at 85% of the flight');
  assert.ok(spinRate(frames, p, 0.95) < cruise * 0.45, 'and clearly decelerating by 95%');
  assert.ok(spinRate(frames, p, 0.995) < cruise * 0.15, 'ending nearly stopped rather than cutting off mid-spin');
});

test('the constant rate stays legible rather than aliasing', () => {
  // A flat rate has no peak to speak of - which is the point. It must
  // still sit well inside the band where an eye resolves rotation.
  for (const i of [0, 1]) {
    const p = plan({ x: 560, y: 330 }, -1, 0, i);
    const rate = spinRate(flickKeyframes(p), p, 0.5);
    assert.ok(rate > 25 && rate < 120, `intensity ${i} cruises at ${rate.toFixed(0)}deg/frame`);
  }
});

test('spin always lands square, so the card never settles crooked', () => {
  for (const i of [0, 0.3, 0.5, 0.8, 1]) {
    for (const [name, dx, dy] of DIRECTIONS) {
      const frames = flickKeyframes(plan({ x: 560, y: 330 }, dx, dy, i));
      const finalSpin = frames[frames.length - 1].spinDeg;
      // `=== 0` rather than assert.equal, which distinguishes -0 from 0.
      assert.ok(finalSpin % 360 === 0, `intensity ${i} flicked ${name} ended at ${finalSpin}deg`);
    }
  }
});

test('spin direction follows the flick, and vertical flicks differ from each other', () => {
  const to = { x: 560, y: 330 };
  const right = plan(to, 1, 0).spinSign;
  const left = plan(to, -1, 0).spinSign;
  assert.equal(right, 1);
  assert.equal(left, -1);
  assert.notEqual(plan(to, 0, 1).spinSign, plan(to, 0, -1).spinSign);
});

test('rotation is still going strong when the card comes back into view', () => {
  // The whole reason for the constant rate: on a big flick the card is
  // off screen for the middle of the flight and only reappears late.
  const p = plan({ x: 560, y: 330 }, -1, 0, 1);
  const frames = flickKeyframes(p);
  const leftToSee = 1 - spinDone(frames, 0.62); // ~when a hard flick reappears
  assert.ok(leftToSee > 0.3, `only ${(leftToSee * 100).toFixed(0)}% of the spin would still be visible on the return`);
});

test('duration rises with intensity and stays inside the intended band', () => {
  for (const [dname, to] of DESTINATIONS) {
    for (const [name, dx, dy] of DIRECTIONS) {
      for (const i of [0, 0.5, 1]) {
        const ms = plan(to, dx, dy, i).durationMs;
        assert.ok(ms >= FLICK_MIN_MS && ms <= FLICK_MAX_MS, `${dname} ${name} @${i}: ${ms.toFixed(0)}ms`);
      }
      const gentle = plan(to, dx, dy, 0).durationMs;
      const hard = plan(to, dx, dy, 1).durationMs;
      assert.ok(hard >= gentle, `${dname} ${name}: a harder flick should not be quicker`);
    }
  }
});

// ---------- the 3D turnover ----------

test('the turnover happens late, and only late', () => {
  const frames = flickKeyframes(plan({ x: 560, y: 330 }, -1, 0));
  const early = frames.filter(f => f.offset < 0.7);
  assert.ok(early.every(f => f.tiltDeg === 0), 'nothing should tilt during the flight itself');
  const peak = Math.max(...frames.map(f => f.tiltDeg));
  assert.ok(peak > 25, `the turnover should be visible, peaked at ${peak.toFixed(0)}deg`);
});

test('the turnover never reaches the angle that would show the back of the card', () => {
  for (const [name, dx, dy] of DIRECTIONS) {
    for (const f of flickKeyframes(plan({ x: 560, y: 330 }, dx, dy))) {
      assert.ok(Math.abs(f.tiltDeg) < 80, `${name}: tilted to ${f.tiltDeg.toFixed(0)}deg - past 90 the card presents its reverse`);
    }
  }
});

test('the card ends flat, unscaled and untilted', () => {
  for (const [name, dx, dy] of DIRECTIONS) {
    const last = flickKeyframes(plan({ x: 560, y: 330 }, dx, dy)).at(-1);
    assert.equal(last.tiltDeg, 0, name);
    assert.equal(last.scale, 1, name);
  }
});

test('the in-flight scale stays subtle', () => {
  for (const f of flickKeyframes(plan({ x: 560, y: 330 }, -1, 0))) {
    assert.ok(f.scale > 0.9 && f.scale < 1.12, `scale ${f.scale.toFixed(3)} is not subtle`);
  }
});

// ---------- keeping the card on screen ----------

test('the card is allowed off-screen - the reach ceiling is screens, not edges', () => {
  const to = { x: 560, y: 330 };
  const viewport = 1280;
  const hard = launchDistance({ from: FROM, to, dir: { x: -1, y: 0 }, cardWidthPx: CARD_W, intensity: 1, reachPx: viewport });
  // A leftward throw from x=200 must be free to sail well past x=0.
  assert.ok(hard > FROM.x + CARD_W * 2, `a hard flick should leave the viewport, threw only ${hard.toFixed(0)}px`);
  // ...but not by several screens.
  assert.ok(hard <= viewport + 0.001, `${hard.toFixed(0)}px exceeds one screen of reach`);
});

test('the reach ceiling scales with intensity and never bends the launch', () => {
  const to = { x: 920, y: 330 };
  const soft = launchDistance({ from: FROM, to, dir: { x: 1, y: 0 }, cardWidthPx: CARD_W, intensity: 0, reachPx: 1280 });
  const hard = launchDistance({ from: FROM, to, dir: { x: 1, y: 0 }, cardWidthPx: CARD_W, intensity: 1, reachPx: 1280 });
  assert.ok(hard > soft, `hard ${hard.toFixed(0)} should out-throw moderate ${soft.toFixed(0)}`);
  // Only the distance is ever limited - the direction is untouched.
  const curve = flickCurve({ from: FROM, to, dir: { x: 1, y: 0 }, launch: hard });
  assert.equal(curve.out[1].y, FROM.y, 'the launch tangent must stay horizontal for a horizontal flick');
  assert.ok(curve.out[1].x > FROM.x);
});

test('the landing is exact even when the reach ceiling bound the throw', () => {
  const to = { x: 290, y: 330 };
  const frames = flickKeyframes(flickPlan({ from: FROM, to, dirX: 1, dirY: 1, intensity: 1, cardWidthPx: CARD_W, reachPx: 400 }));
  assert.equal(frames.at(-1).x, to.x);
  assert.equal(frames.at(-1).y, to.y);
});

// ---------- the refusal ----------

test('a refused flick barely moves, and puts the card back where it belongs', () => {
  const from = { x: 260, y: 150 };
  const to = { x: 200, y: 120 };
  const frames = flickRefusalKeyframes({ from, to, dirX: 1, dirY: 0, cardWidthPx: CARD_W });
  assert.equal(frames.at(-1).x, to.x);
  assert.equal(frames.at(-1).y, to.y);
  const reach = Math.max(...frames.map(f => Math.hypot(f.x - from.x, f.y - from.y)));
  assert.ok(reach < Math.hypot(to.x - from.x, to.y - from.y) + CARD_W * 0.3,
    `a refusal should be a nudge, not a journey (reached ${reach.toFixed(0)}px)`);
});

test('a refused flick never spins or turns over', () => {
  for (const f of flickRefusalKeyframes({ from: { x: 260, y: 150 }, to: { x: 200, y: 120 }, dirX: -1, dirY: 0.4, cardWidthPx: CARD_W })) {
    assert.equal(f.tiltDeg, 0);
    assert.ok(Math.abs(f.spinDeg) < 5, 'a refusal must not read as a throw');
    assert.equal(f.scale, 1);
  }
});

// ---------- degenerate inputs ----------

test('a flick onto the card\'s own position still produces a finite, landing flight', () => {
  const frames = flickKeyframes(flickPlan({ from: FROM, to: { ...FROM }, dirX: 1, dirY: 0, intensity: 1, cardWidthPx: CARD_W }));
  assert.ok(frames.every(f => Number.isFinite(f.x) && Number.isFinite(f.y) && Number.isFinite(f.spinDeg)));
  assert.equal(frames.at(-1).x, FROM.x);
  assert.equal(frames.at(-1).y, FROM.y);
});

test('keyframe offsets are ordered 0..1, as WAAPI requires', () => {
  const frames = flickKeyframes(plan({ x: 560, y: 330 }, -1, 0));
  assert.equal(frames[0].offset, 0);
  assert.equal(frames.at(-1).offset, 1);
  for (let i = 1; i < frames.length; i++) assert.ok(frames[i].offset > frames[i - 1].offset);
});
