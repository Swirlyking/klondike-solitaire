// Waste-card flick: gesture classification and flight-path math.
//
// Pure (no DOM, no state, no rules) so all of it is unit-testable - see
// flick.test.js. The impure half lives in script.js (executeFlickMove),
// which owns the ghost, the WAAPI calls, and the single commitMove() that
// actually performs the move.
//
// Two responsibilities, deliberately kept apart:
//
//   1. classifyPointerGesture - decides whether a finished pointer
//      interaction was a tap, a drag, or a flick, from nothing but the
//      recorded pointer samples. It never looks at the board, so it can't
//      accidentally become a second source of truth about legality.
//
//   2. flickPlan/flickKeyframes - given a start point, an END POINT THE
//      CALLER ALREADY RESOLVED, and the flick's direction/intensity,
//      produces the boomerang flight. The destination is an input here,
//      never something this file decides: flick direction shapes the
//      flight and nothing else (see resolveClickDestination in
//      game-logic.js, which is the only thing that picks a destination,
//      for a flick exactly as for a tap).

// ---------- gesture classification ----------

// What a flick IS, in one sentence: a short burst of speed ending at the
// moment of release. Not "a drag that happened to be quick" - the travel
// distance barely matters, and the thresholds below are deliberately set
// so that velocity, not accumulated distance, is what decides.
//
// FLICK_MIN_RELEASE_SPEED_PX_MS is what a real finger snap actually
// produces, measured rather than assumed. Driven through the browser at
// phone size, the snaps this gesture is meant to catch measure:
//
//     15px in 33ms -> 0.57      25px in 46ms -> 0.76
//     20px in 41ms -> 0.70      30px in 52ms -> 0.82
//     25px in 67ms -> 0.55      35px in 55ms -> 0.91
//
// ...against the same distances covered deliberately:
//
//     25px in 219ms -> 0.17     25px in 415ms -> 0.09
//     a 200px drag decelerating onto a pile -> 0.07
//
// 0.5 is the line: it admits the whole 15-35px snap band including the
// lazier end of it, and still sits ~3x above an unhurried 25px and ~7x
// above a placement drag. (It was 1.6 px/ms, borrowed from the drag
// code's own rotation constant. That number describes a fast SUSTAINED
// drag; nothing in the list above comes close to it, which is exactly
// why the gesture felt impossible to trigger and had to be dragged into
// existence.) Sudoku's calendar swipe independently arrived at this same
// 0.5 for the same "obviously intentional flick" judgement.
export const FLICK_MIN_RELEASE_SPEED_PX_MS = 0.5;
// Where intensity saturates. Past this, extra pointer speed changes
// nothing - a trackpad or a stray high-DPI sample burst can report
// 10+ px/ms, and no flight parameter should keep scaling with that.
export const FLICK_MAX_RELEASE_SPEED_PX_MS = 3.0;

// Release speed is the PEAK over trailing spans, not the average over a
// fixed window. The difference is the whole gesture feel:
//
// A fixed-window average dilutes a burst with whatever came before it.
// Averaged over 70ms, a 25px snap that took 35ms reads 0.71 px/ms
// because the window also covers 35ms of the finger sitting still; the
// same snap after resting on the card for half a second reads 0.37,
// since almost the entire window is stationary. Both are unmistakable
// flicks to the person making them. Scanning every trailing span and
// taking the fastest finds the burst wherever it sits inside the window:
// those same two gestures measure 0.92 and 0.92.
//
// Spans shorter than FLICK_VELOCITY_MIN_SPAN_MS are skipped so a single
// noisy sample pair a millisecond apart can't report an enormous speed;
// FLICK_MIN_BURST_PX then requires the pointer to have covered real
// ground across the window as a whole, so a twitch can't qualify on
// speed alone.
const FLICK_VELOCITY_WINDOW_MS = 80;
const FLICK_VELOCITY_MIN_SPAN_MS = 8;
export const FLICK_MIN_BURST_PX = 10;

// A flick is a short gesture. The budget is card-relative so it scales
// with the responsive layout rather than being a fixed pixel count that
// means something different at --card-w: 84px than at 170px - anything
// longer is someone carrying a card somewhere, which is a drag.
//
// But a human flick does NOT scale with the cards. A flick is roughly
// the same physical gesture whatever is being flicked, and on a phone
// (--card-w around 50px) 2.4 card widths is only ~120px - easily
// exceeded by an ordinary, obviously-a-flick thumb movement, which would
// then be misread as a drag. So the budget is the LARGER of the
// card-relative figure and a fraction of the viewport's short edge.
// Which of the two binds depends on the layout (measured: ~169px from
// the viewport on a 375x812 phone, ~387px on a 1280x860 desktop against
// ~336px card-relative) - the point is that neither anchor alone is
// right at both ends of the range.
export const FLICK_MAX_TRAVEL_CARD_WIDTHS = 3.0;
export const FLICK_MAX_TRAVEL_VIEWPORT_FRACTION = 0.55;

export function maxFlickTravelPx(cardWidthPx, viewportMinPx = 0) {
  return Math.max(cardWidthPx * FLICK_MAX_TRAVEL_CARD_WIDTHS, viewportMinPx * FLICK_MAX_TRAVEL_VIEWPORT_FRACTION);
}

// Ignores the perpendicular jitter of a real fingertip: a flick's
// direction is the direction of its overall travel, so tiny wobble near
// the release point must not be able to rotate the launch vector.
const MIN_DIRECTION_SPAN_PX = 6;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// Two different measurements, deliberately taken over different spans:
//
//   speed     - the PEAK, over whichever trailing span is quickest. This
//               is "how hard was it thrown".
//   distance  - how far the pointer moved over the WHOLE window. This is
//               "did it actually go anywhere", and it must not be read
//               off the fastest span: the quickest span is usually also
//               the shortest, so it covers the least ground. Gating on
//               that rejected real snaps (a 30px flick whose peak span
//               was 9ms covering 9.1px) while passing nothing extra.
//
// Direction comes from the window too, for the same reason - more
// samples, less susceptible to one veering sample as the finger lifts.
//
// All zeroes for anything that can't yield a real measurement (a single
// sample, a zero time span), which correctly classifies as "not a flick"
// downstream.
export function releaseVelocity(samples, windowMs = FLICK_VELOCITY_WINDOW_MS) {
  const none = { speed: 0, distance: 0, dirX: 0, dirY: 0, spanMs: 0 };
  if (!samples || samples.length < 2) return none;
  const last = samples[samples.length - 1];
  let speed = 0;
  let window = null;
  for (let i = samples.length - 2; i >= 0; i--) {
    const spanMs = last.t - samples[i].t;
    if (spanMs > windowMs) break;
    if (spanMs <= 0) continue;
    const dx = last.x - samples[i].x;
    const dy = last.y - samples[i].y;
    window = { dx, dy, spanMs }; // each iteration reaches further back, so the last one wins
    if (spanMs < FLICK_VELOCITY_MIN_SPAN_MS) continue; // too short to measure without amplifying sample noise
    speed = Math.max(speed, Math.hypot(dx, dy) / spanMs);
  }
  if (!window) return none;
  const distance = Math.hypot(window.dx, window.dy);
  // No span was long enough to measure cleanly - a very fast gesture
  // that produced only a couple of samples. Fall back to the window.
  if (speed === 0) speed = distance / window.spanMs;
  return {
    speed,
    distance,
    dirX: distance > 0 ? window.dx / distance : 0,
    dirY: distance > 0 ? window.dy / distance : 0,
    spanMs: window.spanMs,
  };
}

// The point at which this gesture first counted as movement at all, and
// when. Mirrors processDragFrame's own test (distance from the press
// point vs DRAG_THRESHOLD_PX) so "did this become a drag" means exactly
// the same thing here as it does there.
function movementOnset(samples, dragThresholdPx) {
  const start = samples[0];
  for (let i = 1; i < samples.length; i++) {
    if (Math.hypot(samples[i].x - start.x, samples[i].y - start.y) >= dragThresholdPx) {
      return samples[i];
    }
  }
  return null;
}

// The direction the card was thrown, as a unit vector: the heading of
// the BURST, not of the whole gesture. If someone eases the card one way
// and then snaps it another, the snap is the throw - and for the short
// sharp gesture this is tuned around, the two are the same thing anyway.
// Falls back to overall travel when the burst is too compact to give a
// trustworthy heading (a fingertip's last samples routinely veer as it
// lifts).
function flickDirection(samples, onset, velocity) {
  if (velocity.distance >= MIN_DIRECTION_SPAN_PX) return { x: velocity.dirX, y: velocity.dirY };
  const last = samples[samples.length - 1];
  const from = onset || samples[0];
  const dx = last.x - from.x;
  const dy = last.y - from.y;
  const span = Math.hypot(dx, dy);
  if (span > 0) return { x: dx / span, y: dy / span };
  return { x: 1, y: 0 }; // unreachable in practice (a zero-motion gesture never classifies as a flick) - a defined value beats NaN
}

// tap | drag | flick, for a finished pointer interaction.
//
// `samples` is the recorded path, oldest first, each {x, y, t} in client
// pixels / performance.now() milliseconds, with the press point first
// and the pointerup point last. `cardWidthPx` comes from the card's own
// measured rect, so nothing here hard-codes a size.
//
// `onset` is the sample at which the gesture crossed the drag threshold,
// or null if it never did - used ONLY to separate a tap from everything
// else. Flick recognition deliberately does not depend on it: the drag
// threshold is a rAF-timed notion of "this became a drag", and a flick
// is over before that question is necessarily settled. Omitting it falls
// back to deriving it from `samples` with `dragThresholdPx`, which is
// how the tests drive this directly.
export function classifyPointerGesture({ samples, onset: givenOnset, dragThresholdPx, cardWidthPx, viewportMinPx = 0 }) {
  if (!samples || samples.length < 2) return { kind: 'tap', speed: 0, dirX: 0, dirY: 0, intensity: 0 };

  const velocity = releaseVelocity(samples);
  const last = samples[samples.length - 1];
  const travel = Math.hypot(last.x - samples[0].x, last.y - samples[0].y);

  // Three things, all about the burst, none about accumulated distance:
  // it has to be fast, it has to have actually covered some ground (so
  // fingertip jitter can't qualify on speed alone), and the gesture as a
  // whole must not have been a long carry across the board - that last
  // one is a safety net for drag, not a definition of flick.
  const isFlick = velocity.speed >= FLICK_MIN_RELEASE_SPEED_PX_MS
    && velocity.distance >= FLICK_MIN_BURST_PX
    && travel <= maxFlickTravelPx(cardWidthPx, viewportMinPx);

  const onset = givenOnset !== undefined ? givenOnset : movementOnset(samples, dragThresholdPx);
  // A flick is checked before the tap test on purpose: a snap sharp
  // enough to qualify is a flick whether or not any frame ever observed
  // it cross the drag threshold.
  if (!isFlick) {
    if (!onset) return { kind: 'tap', speed: velocity.speed, dirX: 0, dirY: 0, intensity: 0 };
    return { kind: 'drag', speed: velocity.speed, dirX: 0, dirY: 0, intensity: 0 };
  }

  const dir = flickDirection(samples, onset, velocity);
  return {
    kind: 'flick',
    speed: velocity.speed,
    dirX: dir.x,
    dirY: dir.y,
    intensity: flickIntensity(velocity.speed),
  };
}

// Which PILES a flick may start from. Not the whole eligibility rule:
// the gesture is only ever offered for a move of exactly ONE card, and
// how many cards a given press would move is a Solitaire question this
// file deliberately cannot answer (it knows no rules - see the header).
// The caller pairs this with that test; see isFlickEligible in
// script.js, which asks getStackFrom - the same function the drag uses.
//
// The stock is absent and can never be added: it is not draggable and
// has no card interactions, so a flick cannot originate there at all.
// A covered tableau card is likewise unreachable - it never gets the
// pointer handlers that begin a drag.
//
// A named predicate rather than an inline source comparison so the
// scope rule is stated, and tested, in exactly one place.
const FLICKABLE_SOURCES = ['waste', 'tableau', 'foundation'];
export function isFlickableSource(source) {
  return FLICKABLE_SOURCES.includes(source);
}

// 0 = the gentlest gesture that still counts as a flick, 1 = anything at
// or beyond FLICK_MAX_RELEASE_SPEED_PX_MS. Every velocity-dependent
// number in the flight (launch distance, rotation count, duration) is a
// function of this single clamped value, so no amount of pointer speed
// can produce an untested flight.
export function flickIntensity(speed) {
  const span = FLICK_MAX_RELEASE_SPEED_PX_MS - FLICK_MIN_RELEASE_SPEED_PX_MS;
  return clamp((speed - FLICK_MIN_RELEASE_SPEED_PX_MS) / span, 0, 1);
}

// ---------- flight path ----------

// How far the card is flung, before any clamping: a multiple of the
// straight-line distance to the destination, scaled by intensity.
//
// LAUNCH_ALIGN_* exists because "flung away, then boomerangs back" has
// to hold even when the player flicks straight AT the destination. In
// that case there's no "away" unless the throw carries the card clear
// PAST the pile and the curve brings it back, so both the target
// distance and its ceiling grow with how closely the flick direction
// lines up with the destination. Without this the aligned cases collapse
// to a near-straight line (measured: arc/distance 1.02 vs 1.6+ with it).
const LAUNCH_BASE = 1.30;        // x distance-to-destination, flicking perpendicular/away
const LAUNCH_ALIGN = 0.80;       // ...plus this much more, flicking straight at it
const LAUNCH_CAP_BASE = 1.55;    // ceiling, x distance-to-destination
const LAUNCH_CAP_ALIGN = 0.95;   // ...also raised when aligned, or the overshoot gets capped away again
const LAUNCH_CAP_CARD_WIDTHS = 4.2; // ceiling never drops below this, so short moves still get a real throw
const LAUNCH_MIN_CARD_WIDTHS = 2.3; // ...and neither does a gentle flick to a near pile
const LAUNCH_INTENSITY_LO = 0.75;   // scale at intensity 0 (moderate flick: smaller throw)
const LAUNCH_INTENSITY_HI = 1.35;   // scale at intensity 1 (hard flick: bigger throw)
// The only absolute ceiling, and it is NOT "keep the card on screen" -
// the card is meant to leave the viewport and come back, that's the
// joke. This just stops the far-destination cases from throwing it so
// many screens out that the turnaround happens where nobody can see it
// (and that the return leg has to be covered at a speed that reads as a
// teleport rather than a throw). Expressed as a fraction of the reach
// the caller supplies - see flickReachPx in script.js for why that is
// the viewport's SHORTEST edge.
const LAUNCH_REACH_LO = 0.30;    // fraction of that reach available at intensity 0
const LAUNCH_REACH_HI = 0.46;    // ...and at intensity 1 - just past a full screen-edge

// Flight shape, as fractions of the launch distance. Two cubic segments
// (out to the apex, then around to the destination) rather than one, so
// the turnaround is a broad arc with a controllable radius instead of
// whatever a single cubic's control points happen to produce - a single
// cubic folded into a visible hairpin at some angles (the card's net
// travel dropped to ~3px on a frame while covering 17px of path, which
// read as bouncing off something rather than curving).
// Tuned for a BALLISTIC read - thrown object, not bird. What matters is
// not how much the path curves in total but WHERE the curvature sits: a
// flat run, then one decisive turn. Sampling heading change in twenty
// equal steps along the arc, the turn onset sharpens from a ramp into a
// step:
//
//     before   12 10  8  5  0 17 75 29 41 48 16 ...
//     after     8  9  8  7  5  5 81 33 26 50 26 ...
//
// Two hard constraints discovered by measuring at the real keyframe
// resolution, both of which produce a CUSP - the card retracing its own
// path and visually bouncing - rather than a turn:
//
//   1. OUT_LEAD + OUT_TRAIL must stay under the p0->apex distance
//      (~1.0 x launch). Past that the outbound control polygon folds
//      back on itself. Straightening the launch therefore means shifting
//      the budget INTO OUT_LEAD, never enlarging it.
//   2. APEX_BLEND must not drop below ~0.5. It is tempting to lower it
//      so the card is "still flying outward" at the apex and the turn
//      feels delayed, but that leaves the whole direction change to
//      happen after the apex, and it collapses into a reversal (measured
//      176 deg of heading change inside a single keyframe).
//
// A low OUT_TRAIL is also a trap: the cubic arrives at the apex at speed
// 3 x OUT_TRAIL x launch, so shrinking it makes the card creep through
// the turn and tightens it. Broad turn = generous OUT_TRAIL.
const APEX_SWING = 0.36;   // sideways offset of the apex, so the throw bows rather than going out and straight back
const APEX_BLEND = 0.50;   // apex heading: 0 = still flying outward, 1 = already aimed at the destination. See constraint 2.
const APEX_BIAS = 0.30;    // radians of extra turn past that blend, keeping the turnaround a curve
const OUT_LEAD = 0.72;     // launch control: how strongly the start tangent commits to the flick direction
const OUT_TRAIL = 0.32;    // apex control on the outbound segment (OUT_LEAD + this <= ~1.0; see constraint 1)
const IN_LEAD = 0.58;      // apex control on the return segment - higher = broader sweep out of the turn
const IN_TRAIL = 0.28;     // final approach control; lower = comes home direct rather than curling in
const APEX_SPLIT = 0.42;   // fraction of the path parameter spent on the outbound segment

// Speed profile, as a function of time. The card is driven along the
// path by ARC LENGTH, not by the curve's own parameter: a Bezier's
// parameter is not proportional to distance, so easing the parameter
// directly produced both a violent first frame (117px+) and a mid-flight
// stall where the curve's own speed dipped. Arc-length driving makes
// this function the card's actual on-screen speed, which is the only way
// "the launch is the fastest part" and "it slows as it lands" can be
// stated - and verified - directly.
//
// Same idea as AUTO_FINISH_MOVE_PROFILE in script.js (sample a profile
// into plain keyframes, linear in between, no per-keyframe CSS easing),
// for the same reason: it's the only way to express a shape a single
// cubic-bezier can't, and it stays safe on Mobile Safari.
//
// A launch spike decaying onto a cruise, times a landing taper. Both
// factors are positive and non-increasing, so their product is too -
// which is what guarantees the card never speeds back up mid-flight.
// The launch spike is SOLVED PER FLICK, not fixed, so the card always
// leaves at a speed derived from how hard the player actually threw it.
//
// It used to be a constant, which meant the launch speed fell out of
// (path length / duration) and had almost nothing to do with the
// gesture: measured across a 3.3x range of throw speeds, the card left
// at 4.5-7.1 px/ms every time - amplifying a gentle flick 4.5x and a
// hard one only 2x. Shortening the flight then made it worse, with a
// hard throw leaving at 1.13x the finger and decelerating immediately,
// which is felt as the card hesitating instead of being thrown.
//
// Now the card leaves at the player's own release speed times
// LAUNCH_BOOST - always a little faster than the hand, never slower,
// whatever the path length happens to be.
const LAUNCH_BOOST = 2.00;
const SPEED_SPIKE_MIN = 0.3;
const SPEED_SPIKE_MAX = 4.2;
const SPEED_SPIKE_DEFAULT = 2.30;  // used when no release speed is supplied
const SPEED_SPIKE_DECAY = 0.11; // time constant of that spike, in fractions of the flight - short, so the extra speed is spent on the launch and the rest of the flight is untouched
const LANDING_T = 0.76;     // the final approach starts here: rotation eases off, the tilt happens, speed drops
const LANDING_TAPER = 0.80; // how much of the cruise speed is given up by the moment it lands

// Duration grows with how far the card actually travels, so a moderate
// flick to a near pile doesn't end up moving FASTER than a hard flick
// across the board (it did, before this: same path length, shorter
// duration). Clamped to the 550-750ms band either way.
export const FLICK_MIN_MS = 600;
export const FLICK_MAX_MS = 820;
const DURATION_BASE_MS = 490;
// Deliberately small. The flight is now 2-3x longer than it was, and if
// duration tracked that at the old rate every flick would sit at the
// ceiling and the extra distance would be spent travelling slowly -
// which is the opposite of the point. The distance comes from speed.
const DURATION_PER_ARC_PX = 0.055;
const DURATION_INTENSITY_MS = 90;

// Visual rotations. Rounded to a whole number of turns so the card
// always lands square: the rotation is driven to exactly turns * 360deg,
// which is visually 0deg, rather than easing out a leftover angle at the
// same moment the card is supposed to be settling. Over the intensity
// range this gives 2 turns for a moderate flick and 4 for a hard one -
// the "1.5-2 vs 3-4 rotations" the effect is going for, without a
// crooked landing.
// Rotation count and curve are both taken from the MIKE intro card
// (introCardIn in style.css): 781deg in 350ms on
// cubic-bezier(.215, .61, .355, 1) - easeOutCubic. That animation is the
// reference for how a thrown card should spin here, so this reuses its
// actual easing rather than approximating it.
//
// Counter-intuitively this LOWERS the rotation count from where it was
// (6-9 turns) even though the spin needs to read faster, because
// perceived rotation speed is not monotonic in angular rate. Past
// roughly 150 deg per rendered frame a card starts to alias - the
// wagon-wheel effect - and the eye stops resolving it as fast
// rotation at all. The 9-turn version peaked near 164 deg/frame, above
// that line, which is exactly why it read as "rotating while
// travelling" rather than being whipped out of the pile. The intro peaks
// at ~106 deg/frame, comfortably legible, and gets its energy instead
// from CONTRAST: 88% of its rotation is spent by the halfway point,
// against 79% for the old nine-turn flight.
//
// So these counts put the peak at 111 deg/frame (moderate) and 137
// (hard) - above the intro, inside the legible band - and the intro's
// own curve supplies the front-loading.
const SPIN_TURNS_LO = 3.7;
const SPIN_TURNS_HI = 5.6;

// The card holds a CONSTANT angular velocity for almost the whole
// flight, then settles hard at the very end. Not an ease-out.
//
// It used to use the MIKE intro card's easeOutCubic, which front-loads
// heavily - 88% of the rotation spent by the halfway point. That is
// right for the intro, where the card is on screen the entire time. It
// is wrong here, because the flight takes the card off screen: measured
// on a hard flick, the card left view 12ms after release and did not
// come back until 424ms of a 687ms flight. By then an ease-out has 98%
// of its rotation behind it, so the only rotation the player ever saw
// was the dead tail - 0.6 of 6 turns. The spin was not too slow, it was
// spent somewhere nobody could see it.
//
// Holding the rate flat means that whenever the card IS visible - at the
// launch, and again through the whole return - it is turning at full
// speed. It also drops the peak from ~159 deg/frame (well inside the
// wagon-wheel range where rotation stops resolving) to a steady rate
// that reads cleanly for the entire time it is on screen.
//
// Expressed against the PATH rather than against time: the spin stays
// flat until the card has covered this much of its journey, which is
// later in time than it sounds, because the landing taper means the last
// few percent of distance takes a disproportionate share of the clock.
const SPIN_CRUISE_UNTIL_PATH = 0.95;

// Constant rate up to `cruiseUntil`, then a quadratic decay to a dead
// stop at 1. The two pieces meet at the same velocity, so there is no
// kick at the join, and the areas are solved so the total comes to
// exactly 1 - which is what lands the card square with the stack.
function spinProgress(offset, cruiseUntil) {
  const tail = 1 - cruiseUntil;
  if (tail <= 0) return Math.min(1, offset / cruiseUntil);
  // rate * cruiseUntil + rate * tail/2 === 1
  const rate = 1 / (cruiseUntil + tail / 2);
  if (offset <= cruiseUntil) return rate * offset;
  const u = (offset - cruiseUntil) / tail;
  return rate * cruiseUntil + rate * tail * (u - u * u / 2);
}

// The 3D turnover. Well under 90deg on purpose: past that the card would
// present its mirrored back side, and this effect must never change or
// hide the face (see the face-visibility note in executeFlickMove).
const TILT_PEAK_DEG = 52;

// Depth cue while the card is in the air, plus a small compression as it
// lands. Subtle by design - this is the "physical" bit, not the effect.
const FLIGHT_SCALE = 0.07;
const LANDING_SQUASH = 0.03;
const LANDING_SQUASH_T = 0.90;

const ARC_TABLE_STEPS = 600; // arc-length lookup resolution; ~1px per step on the longest realistic flight

function add(a, b) { return { x: a.x + b.x, y: a.y + b.y }; }
function scale(a, k) { return { x: a.x * k, y: a.y * k }; }
function sub(a, b) { return { x: a.x - b.x, y: a.y - b.y }; }
function len(a) { return Math.hypot(a.x, a.y); }
function unit(a) { const m = len(a) || 1; return { x: a.x / m, y: a.y / m }; }
function rotate(a, rad) {
  const c = Math.cos(rad), s = Math.sin(rad);
  return { x: a.x * c - a.y * s, y: a.x * s + a.y * c };
}
function cubicAt(p, s) {
  const m = 1 - s;
  return {
    x: m * m * m * p[0].x + 3 * m * m * s * p[1].x + 3 * m * s * s * p[2].x + s * s * s * p[3].x,
    y: m * m * m * p[0].y + 3 * m * m * s * p[1].y + 3 * m * s * s * p[2].y + s * s * s * p[3].y,
  };
}
function smoothstep(x) {
  const c = clamp(x, 0, 1);
  return c * c * (3 - 2 * c);
}

// How far the card is thrown, in pixels. `reachPx`, when given, is the
// viewport-derived absolute ceiling described at LAUNCH_REACH_LO - the
// card is free to leave the screen, this only stops it leaving by
// several screens.
export function launchDistance({ from, to, dir, cardWidthPx, intensity, reachPx }) {
  const toDest = sub(to, from);
  const distance = len(toDest) || 1;
  // 0 flicking perpendicular or away from the destination, 1 flicking
  // straight at it. Negative alignment (away) is treated as 0: flinging
  // the card in the opposite direction already produces all the
  // "away-ness" the effect needs.
  const alignment = Math.max(0, dir.x * (toDest.x / distance) + dir.y * (toDest.y / distance));
  const intensityScale = LAUNCH_INTENSITY_LO + (LAUNCH_INTENSITY_HI - LAUNCH_INTENSITY_LO) * clamp(intensity, 0, 1);
  const wanted = distance * (LAUNCH_BASE + LAUNCH_ALIGN * alignment) * intensityScale;
  let ceiling = Math.max(cardWidthPx * LAUNCH_CAP_CARD_WIDTHS, distance * (LAUNCH_CAP_BASE + LAUNCH_CAP_ALIGN * alignment));
  if (reachPx > 0) {
    ceiling = Math.min(ceiling, reachPx * (LAUNCH_REACH_LO + (LAUNCH_REACH_HI - LAUNCH_REACH_LO) * clamp(intensity, 0, 1)));
  }
  const floor = Math.min(cardWidthPx * LAUNCH_MIN_CARD_WIDTHS, ceiling);
  return Math.max(clamp(wanted, floor, ceiling), 1);
}

// The two-segment boomerang, as raw control points. Exported for tests
// (and only tests) - flickPlan is what callers want.
export function flickCurve({ from, to, dir, launch }) {
  const toDest = sub(to, from);
  // Which side to swing round: whichever perpendicular points toward the
  // destination, so the card comes back the short way rather than
  // looping the long way round the board.
  const perpendicular = { x: -dir.y, y: dir.x };
  const side = (perpendicular.x * toDest.x + perpendicular.y * toDest.y) >= 0 ? 1 : -1;
  const normal = scale(perpendicular, side);

  const apex = add(add(from, scale(dir, launch)), scale(normal, launch * APEX_SWING));
  // The heading at the apex is derived from where the destination
  // actually is, not from a fixed rotation of the flick direction. A
  // fixed angle fights the geometry whenever the destination sits behind
  // the apex, which is exactly what produced the hairpin.
  const apexToDest = sub(to, apex);
  const heading = rotate(
    unit(add(scale(dir, 1 - APEX_BLEND), scale(unit(apexToDest), APEX_BLEND))),
    side * APEX_BIAS,
  );
  const returnLength = len(apexToDest) || 1;

  return {
    apex,
    split: APEX_SPLIT,
    out: [from, add(from, scale(dir, launch * OUT_LEAD)), add(apex, scale(heading, -launch * OUT_TRAIL)), apex],
    back: [apex, add(apex, scale(heading, returnLength * IN_LEAD)), add(to, scale(unit(scale(apexToDest, -1)), returnLength * IN_TRAIL)), to],
  };
}

function curvePointAt(curve, s) {
  return s <= curve.split
    ? cubicAt(curve.out, s / curve.split)
    : cubicAt(curve.back, (s - curve.split) / (1 - curve.split));
}

// Cumulative-length lookup over the whole two-segment path, so the card
// can be driven by distance travelled instead of by curve parameter.
function buildArcTable(curve) {
  const points = [curvePointAt(curve, 0)];
  const cumulative = [0];
  for (let i = 1; i <= ARC_TABLE_STEPS; i++) {
    const point = curvePointAt(curve, i / ARC_TABLE_STEPS);
    cumulative.push(cumulative[i - 1] + len(sub(point, points[i - 1])));
    points.push(point);
  }
  return { points, cumulative, total: cumulative[ARC_TABLE_STEPS] };
}

function pointAtArcFraction(table, fraction) {
  const target = clamp(fraction, 0, 1) * table.total;
  let lo = 0, hi = ARC_TABLE_STEPS;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (table.cumulative[mid] < target) lo = mid + 1; else hi = mid;
  }
  if (lo === 0) return table.points[0];
  const before = table.cumulative[lo - 1];
  const after = table.cumulative[lo];
  const w = after > before ? (target - before) / (after - before) : 0;
  const a = table.points[lo - 1];
  const b = table.points[lo];
  return { x: a.x + (b.x - a.x) * w, y: a.y + (b.y - a.y) * w };
}

// Instantaneous speed shape (arbitrary units - only its shape matters,
// since distanceAt normalizes by its own integral).
function speedAt(t, spike) {
  return (1 + spike * Math.exp(-t / SPEED_SPIKE_DECAY))
    * (1 - LANDING_TAPER * smoothstep((t - LANDING_T) / (1 - LANDING_T)));
}

// The profile integral splits into a part that does not depend on the
// spike and a part that scales with it, which is what makes the spike
// solvable in closed form below.
const TAPER_AREA = (() => { let a = 0; const N = 2000;
  for (let i = 1; i <= N; i++) { const t = (i - 0.5) / N; a += (1 - LANDING_TAPER * smoothstep((t - LANDING_T) / (1 - LANDING_T))) / N; }
  return a; })();
const SPIKE_AREA = (() => { let a = 0; const N = 2000;
  for (let i = 1; i <= N; i++) { const t = (i - 0.5) / N;
    a += Math.exp(-t / SPEED_SPIKE_DECAY) * (1 - LANDING_TAPER * smoothstep((t - LANDING_T) / (1 - LANDING_T))) / N; }
  return a; })();

// Pick the spike that makes the card's first-frame speed match the
// player's release speed (times LAUNCH_BOOST).
//
//   pixelSpeed(0) = arc * (1 + S) / ((TAPER_AREA + S * SPIKE_AREA) * ms)
//
// solved for S, then clamped so a freak pointer reading cannot produce
// an untested flight.
function solveSpike(arcLength, durationMs, releaseSpeedPxMs) {
  if (!(releaseSpeedPxMs > 0) || !(arcLength > 0)) return SPEED_SPIKE_DEFAULT;
  const target = releaseSpeedPxMs * LAUNCH_BOOST;
  const k = target * durationMs;
  const denominator = arcLength - k * SPIKE_AREA;
  if (Math.abs(denominator) < 1e-6) return SPEED_SPIKE_MAX;
  const solved = (k * TAPER_AREA - arcLength) / denominator;
  if (!Number.isFinite(solved)) return SPEED_SPIKE_DEFAULT;
  return clamp(solved, SPEED_SPIKE_MIN, SPEED_SPIKE_MAX);
}

// Fraction of the total path length covered by time t - speedAt
// integrated and normalized, built once per flight.
function buildDistanceProfile(spike, steps = 400) {
  const cumulative = [0];
  for (let i = 1; i <= steps; i++) {
    cumulative.push(cumulative[i - 1] + speedAt((i - 0.5) / steps, spike) / steps);
  }
  const total = cumulative[steps];
  return t => {
    const x = clamp(t, 0, 1) * steps;
    const i = Math.floor(x);
    const w = x - i;
    const a = cumulative[i];
    const b = cumulative[Math.min(steps, i + 1)];
    return (a + (b - a) * w) / total;
  };
}

// Which way the card spins. Horizontal travel decides it, since that's
// the component a flung card's rotation reads from; a near-vertical
// flick falls back to its vertical direction so up and down still spin
// opposite ways instead of both defaulting to clockwise.
function spinSign(dir) {
  if (Math.abs(dir.x) >= 0.25) return dir.x >= 0 ? 1 : -1;
  return dir.y >= 0 ? 1 : -1;
}

// Everything about one flight, derived from the gesture and the
// already-resolved destination. `from`/`to` are the card's top-left
// positions (the ghost's own coordinate space - see executeFlickMove),
// so the plan's x/y are directly usable as a translate.
export function flickPlan({ from, to, dirX, dirY, intensity, cardWidthPx, reachPx, releaseSpeedPxMs }) {
  const dir = unit({ x: dirX, y: dirY });
  const i = clamp(intensity, 0, 1);
  const launch = launchDistance({ from, to, dir, cardWidthPx, intensity: i, reachPx });
  const curve = flickCurve({ from, to, dir, launch });
  const arc = buildArcTable(curve);
  const durationMs = clamp(
    DURATION_BASE_MS + arc.total * DURATION_PER_ARC_PX + i * DURATION_INTENSITY_MS,
    FLICK_MIN_MS,
    FLICK_MAX_MS,
  );
  const turns = Math.round(SPIN_TURNS_LO + (SPIN_TURNS_HI - SPIN_TURNS_LO) * i);
  return {
    speedSpike: solveSpike(arc.total, durationMs, releaseSpeedPxMs),
    from, to, dir, intensity: i, launch, curve, arc, durationMs,
    arcLength: arc.total,
    turns,
    spinSign: spinSign(dir),
  };
}

// The flight, sampled into plain numbers: one entry per keyframe, with
// `offset` in 0..1 and x/y as an absolute position in the same space as
// the plan's from/to. Callers turn these into CSS; nothing here knows
// about elements or units.
//
// Sampled densely (rather than relying on per-keyframe easing) for the
// same reason AUTO_FINISH_MOVE_PROFILE is: linear interpolation between
// closely-spaced samples reproduces any shape, with no dependence on
// per-keyframe easing support. 64 samples puts them ~10ms apart at this
// duration, finer than a frame even at 120Hz.
export function flickKeyframes(plan, sampleCount = 64) {
  const distanceAt = buildDistanceProfile(plan.speedSpike);
  const totalSpin = plan.turns * 360 * plan.spinSign;
  // SPIN_CRUISE_UNTIL_PATH is a fraction of DISTANCE; the spin is driven
  // by time, so find the moment that much of the path has been covered.
  let spinCruiseUntil = SPIN_CRUISE_UNTIL_PATH;
  for (let i = 0; i <= 200; i++) {
    const t = i / 200;
    if (distanceAt(t) >= SPIN_CRUISE_UNTIL_PATH) { spinCruiseUntil = t; break; }
  }
  const frames = [];
  for (let i = 0; i <= sampleCount; i++) {
    const offset = i / sampleCount;
    const point = pointAtArcFraction(plan.arc, distanceAt(offset));
    // Rotation is driven to exactly totalSpin (a whole number of turns),
    // so the last keyframe is square with the board by construction -
    // the card always lands aligned with the stack, never at whatever
    // angle the curve happened to reach.
    const spinDeg = totalSpin * spinProgress(offset, spinCruiseUntil);
    const tiltPhase = (offset - LANDING_T) / (1 - LANDING_T);
    const tiltDeg = tiltPhase <= 0 ? 0 : TILT_PEAK_DEG * Math.sin(Math.PI * clamp(tiltPhase, 0, 1));
    const squashPhase = (offset - LANDING_SQUASH_T) / (1 - LANDING_SQUASH_T);
    const squash = squashPhase <= 0 ? 0 : LANDING_SQUASH * Math.sin(Math.PI * clamp(squashPhase, 0, 1));
    frames.push({
      offset,
      x: offset === 1 ? plan.to.x : point.x, // land on the exact destination, never on an interpolated approximation of it
      y: offset === 1 ? plan.to.y : point.y,
      spinDeg: offset === 1 ? totalSpin : spinDeg,
      tiltDeg: offset === 1 ? 0 : tiltDeg,
      scale: offset === 1 ? 1 : 1 + FLIGHT_SCALE * Math.sin(Math.PI * Math.pow(offset, 0.85)) - squash,
    });
  }
  return frames;
}

// The "no, that card has nowhere to go" answer to a flick, as keyframes
// in the same shape flickKeyframes produces (so the caller animates it
// through the identical code path). A short resistant shove in the flick
// direction that immediately returns - deliberately NOT the boomerang,
// which would imply the move nearly worked.
export const FLICK_REFUSE_MS = 190;
const REFUSE_TRAVEL_CARD_WIDTHS = 0.13;

// `from` is where the card currently is (it has been tracking the
// pointer through the flick); `to` is its resting slot in the waste. The
// card shoves a little further in the flick direction, is stopped, and
// settles back onto `to` - so the ghost can be removed at the end
// without the card appearing to jump back to the pile.
export function flickRefusalKeyframes({ from, to, dirX, dirY, cardWidthPx }, sampleCount = 12) {
  const dir = unit({ x: dirX, y: dirY });
  const reach = cardWidthPx * REFUSE_TRAVEL_CARD_WIDTHS;
  const frames = [];
  for (let i = 0; i <= sampleCount; i++) {
    const offset = i / sampleCount;
    // Out fast, back slower: reads as the card being stopped by
    // something rather than bouncing off it.
    const push = Math.sin(Math.PI * Math.pow(offset, 0.7));
    // Underneath the shove, the card is already on its way home, so it
    // ends exactly on `to` however far it was dragged before releasing.
    const settle = smoothstep(offset);
    const baseX = from.x + (to.x - from.x) * settle;
    const baseY = from.y + (to.y - from.y) * settle;
    frames.push({
      offset,
      x: offset === 1 ? to.x : baseX + dir.x * reach * push,
      y: offset === 1 ? to.y : baseY + dir.y * reach * push,
      spinDeg: offset === 1 ? 0 : 1.5 * push * spinSign(dir),
      tiltDeg: 0,
      scale: 1,
    });
  }
  return frames;
}
