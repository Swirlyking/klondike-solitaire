// Win-celebration randomness/decision layer - pure, no DOM, mirrors shuffle.js's
// separation (this module decides *what* should happen; script.js is the only
// place that turns it into real pixels/elements/keyframes). Math.random() is
// used throughout, not shuffle.js's cryptographic randomInt() - card-shuffle
// fairness has real statistical-audit stakes (see shuffle-audit.js); a win
// celebration's randomness has none, and coupling the two would be a
// confusing, unnecessary dependency between unrelated concerns.
//
// Every tunable range/probability lives in the constants block below - the
// single place to retune "the insanity" later without touching the
// selection logic itself.

// ---------- tunables ----------

export const WEIRD_EVENT_PROBABILITY = 0.05;
export const PAUSE_RANGE_MS = [400, 600];
export const REDUCED_MOTION_PAUSE_MS = 150;
// How much a card's rebel-probability and rotation intensity fade out as
// its own delay approaches the end of the celebration's timeline - "starts
// chaotic, winds down to calm" as a property of *when* a card leaves, not
// its mode or behavior. 0 = no fade, 1 = fully damped by the last card.
const REBEL_CALM_FACTOR = 0.85;
const ROTATION_CALM_FACTOR = 0.55;
// Late cards bias toward the slower end of their behavior's own duration
// range (still capped by however much time is actually left) - part of the
// same "settles down" feel, since a slower card reads as calmer even before
// you account for the reduced spin.
const DURATION_CALM_BIAS = 0.35;
const STAGGER_RANGE_BOUNDS_MS = [140, 900]; // bounds for the randomly generated [min,max] staggerRangeMs itself
const ROTATION_AMOUNT_RANGE_TURNS = [0.6, 3.5];
// A card's chance of defecting from its celebration's "main event" into a
// contrasting behavior instead - the 70-85% coherent / 15-30% rebel split.
// totalChaos forces this far higher (see MODE_PROFILES) - that's the one
// mode where mixed independent behaviors are the point.
const REBEL_PROBABILITY_RANGE = [0.15, 0.30];
// How much of a pile's own depth-ordering window (see assignCardBehaviors)
// gets spent on jitter/scatter for the deepest ~(1-chaosOnsetFraction) of
// that pile, vs. the crisp, orderly top portion - "starts orderly, turns
// chaotic" expressed as a property of a single pile's own timing, not a
// separate two-phase system.
const CHAOS_ONSET_FRACTION_RANGE = [0.35, 0.85];
const CHAOS_JITTER_BOOST = 4; // how much more scattered the post-onset portion gets, relative to the orderly portion

export const HEADLINES = ['🎉']; // the seam for future alternates - not wired up to more than one yet
export const MESSAGE_ENTRANCES = ['fade', 'scaleUp', 'dropSettle', 'bounce', 'rotateStraighten'];
export const MODES = [
  'gravity', 'explosion', 'windstorm', 'fountain', 'blackHole',
  'wave', 'domino', 'totalChaos', 'vacuum', 'antiGravity', 'tableTip',
];
export const BEHAVIORS = [
  'FALL', 'TUMBLE', 'FRISBEE', 'LAUNCH', 'HELICOPTER',
  'POP', 'SHRINK', 'FLIP', 'SPIRAL', 'VACUUM', 'SLIDE',
  'TOSS', 'DRIFT', 'BOUNCE', 'FLUTTER',
];
export const WEIRD_EVENTS = [
  'allLaunchUp', 'freezeThenExplode', 'convergeToPile',
  'spinFrenzy', 'cornerRush', 'blowOff',
];

// Per-behavior sampling ranges. `inward: true` means the behavior travels
// toward personality.focalPoint rather than outward off-screen (script.js's
// keyframe generators interpret distanceFactor differently for these).
// `fadeOut: true` means the card's opacity animates to 0 at some point
// (everything else just leaves the viewport, which is already invisible -
// no fade needed). These ranges feed script.js's per-behavior keyframe
// generator (createFallKeyframes, createPopKeyframes, ...) - the generator
// decides the actual motion *shape*; this only bounds its magnitude.
//
// durationMs is each behavior's OWN natural lifetime - there is no global
// celebration-length cap layered on top of these anymore (see
// assignCardBehaviors below), so the spread here is what actually produces
// the "genuinely different physical events" feel: a handful of behaviors
// are deliberately fast (LAUNCH, POP, SHRINK, VACUUM - a violent shot or a
// sudden climax should read as sudden), most sit in the 2-4.5s range, and a
// few (TUMBLE, FLUTTER, SLIDE, DRIFT) are allowed to genuinely linger for
// several seconds, matching real objects that take a while to actually
// leave a large screen once thrown/dropped/blown.
export const BEHAVIOR_PROFILES = {
  FALL: { inward: false, fadeOut: false, needsPerspective: false,
    distanceFactor: [0.7, 1.3], rotationTurns: [0.4, 1.6], rotationAxis: ['z'],
    scaleTarget: [0.92, 1.05], durationMs: [1400, 2600] },
  TUMBLE: { inward: false, fadeOut: false, needsPerspective: true,
    distanceFactor: [0.9, 1.8], rotationTurns: [1.5, 3.2], rotationAxis: ['xy'],
    scaleTarget: [0.85, 1.05], durationMs: [3000, 5500] },
  FRISBEE: { inward: false, fadeOut: false, needsPerspective: false,
    distanceFactor: [1.1, 2.2], rotationTurns: [1.5, 3.5], rotationAxis: ['z'],
    scaleTarget: [0.92, 1.05], durationMs: [700, 1600] },
  // Deliberately the fast one - "shoots violently offscreen almost
  // immediately." TOSS below is its slower, arcing cousin.
  LAUNCH: { inward: false, fadeOut: false, needsPerspective: false,
    distanceFactor: [1.2, 2.2], rotationTurns: [0.2, 1], rotationAxis: ['z'],
    scaleTarget: [0.9, 1.05], durationMs: [350, 800] },
  HELICOPTER: { inward: false, fadeOut: false, needsPerspective: false,
    distanceFactor: [0.7, 1.3], rotationTurns: [4, 8], rotationAxis: ['z'],
    scaleTarget: [0.92, 1.05], durationMs: [2200, 4200] },
  POP: { inward: false, fadeOut: true, needsPerspective: false,
    distanceFactor: [0.02, 0.12], rotationTurns: [0, 0.3], rotationAxis: ['z'],
    scaleTarget: [3, 6], durationMs: [500, 1000] },
  SHRINK: { inward: false, fadeOut: true, needsPerspective: false,
    distanceFactor: [0, 0], rotationTurns: [0.3, 1.2], rotationAxis: ['z'],
    scaleTarget: [0, 0.08], durationMs: [550, 1100] },
  FLIP: { inward: false, fadeOut: false, needsPerspective: true,
    distanceFactor: [0.4, 0.9], rotationTurns: [2.5, 5], rotationAxis: ['x', 'y'],
    scaleTarget: [0.85, 1.05], durationMs: [2000, 3800] },
  SPIRAL: { inward: true, fadeOut: true, needsPerspective: false,
    distanceFactor: [0.7, 1.1], rotationTurns: [1.5, 3], rotationAxis: ['z'],
    scaleTarget: [0.1, 0.5], durationMs: [1600, 3200] },
  VACUUM: { inward: true, fadeOut: true, needsPerspective: false,
    distanceFactor: [0.85, 1.15], rotationTurns: [0.5, 2], rotationAxis: ['z'],
    scaleTarget: [0.05, 0.35], durationMs: [700, 1500] },
  // The calm counterpart to FRISBEE: a steady, low-energy glide with only a
  // slight constant tilt (never a spin) and no scale change - reads as
  // something sliding off a tilted surface under its own weight, not
  // getting thrown. Slow duration is the point.
  SLIDE: { inward: false, fadeOut: false, needsPerspective: false,
    distanceFactor: [1.0, 1.6], rotationTurns: [0.03, 0.15], rotationAxis: ['z'],
    scaleTarget: [0.95, 1.03], durationMs: [2800, 5500] },
  // A real up-then-over-then-down parabola - LAUNCH's slower, arcing
  // cousin (this used to be LAUNCH with an arcLaunch flag bolted on; giving
  // it its own behavior/duration range is what lets LAUNCH itself stay
  // genuinely fast while this stays genuinely long-hanging).
  TOSS: { inward: false, fadeOut: false, needsPerspective: false,
    distanceFactor: [1.0, 1.9], rotationTurns: [0.3, 1.2], rotationAxis: ['z'],
    scaleTarget: [0.9, 1.05], durationMs: [2200, 4200] },
  // Lazy, near-weightless wander with almost no rotation - the longest-
  // lived behavior by design ("drifting card might lazily float around for
  // 5-8 seconds"), so it fades out rather than relying on outrunning the
  // viewport.
  DRIFT: { inward: false, fadeOut: true, needsPerspective: false,
    distanceFactor: [0.5, 1.1], rotationTurns: [0, 0.5], rotationAxis: ['z'],
    scaleTarget: [0.85, 1.05], durationMs: [5000, 8000] },
  // Falls, hits an implied floor, bounces back up, falls again, continues
  // off - a genuine down/up/down silhouette, not a monotonic fall.
  BOUNCE: { inward: false, fadeOut: false, needsPerspective: false,
    distanceFactor: [0.6, 1.3], rotationTurns: [0.8, 2], rotationAxis: ['z'],
    scaleTarget: [0.9, 1.05], durationMs: [2600, 4600] },
  // Paper-like: an irregular side-to-side rocking sway on the way down,
  // never a continuous spin - script.js's keyframe generator uses degrees
  // of rock rather than full turns, so rotationTurns here only scales that
  // rock's amplitude, not a literal turn count.
  FLUTTER: { inward: false, fadeOut: false, needsPerspective: false,
    distanceFactor: [0.7, 1.4], rotationTurns: [0.3, 1.5], rotationAxis: ['z'],
    scaleTarget: [0.9, 1.05], durationMs: [3000, 6000] },
};

// Per-mode primary/rebel behavior pools + direction/focal-point bias.
// primaryBehaviors is the celebration's "main event" - what 70-85% of
// cards do; rebelBehaviors is the deliberately contrasting minority
// (falls back to "everything not in primaryBehaviors" when not given
// explicitly - see resolveRebelPool). `directionDeg`, when present, is a
// function returning a fresh randomized bearing each call (0deg = pointing
// right, 90deg = down, increasing clockwise); `focal` marks a mode as
// radial, so generatePersonality also rolls a focalPoint.
const MODE_PROFILES = {
  gravity: {
    primaryBehaviors: ['FALL'],
    rebelBehaviors: ['LAUNCH', 'FRISBEE', 'POP', 'BOUNCE'], // "most cards fall, a handful inexplicably shoot up/sideways/at-you/bounce"
    directionDeg: () => randRange(75, 105), focal: null,
  },
  explosion: {
    primaryBehaviors: ['LAUNCH', 'FRISBEE'],
    directionDeg: null, focal: 'center',
    forceStaggerRangeMs: [0, 140], // abrupt, synchronized initial impulse
  },
  windstorm: {
    primaryBehaviors: ['FRISBEE', 'FLUTTER'], // paper-in-the-wind - FLUTTER's rocking sway fits directly
    directionDeg: () => randChoice([0, 180]) + randRange(-20, 20), focal: null,
  },
  fountain: {
    primaryBehaviors: ['TOSS'], // up-then-over-then-down, replacing the old LAUNCH+arcLaunch flag
    directionDeg: () => randRange(255, 285), focal: null,
  },
  blackHole: {
    primaryBehaviors: ['VACUUM', 'SPIRAL'],
    rebelBehaviors: ['LAUNCH', 'FRISBEE'], // "a few resist or launch away"
    directionDeg: null, focal: 'random-point',
  },
  wave: {
    primaryBehaviors: ['FALL', 'FRISBEE', 'TUMBLE', 'FLUTTER'],
    directionDeg: () => randRange(60, 120), focal: null, forceStaggerShape: 'wave',
  },
  domino: {
    primaryBehaviors: ['TUMBLE', 'FALL', 'BOUNCE'], // dominoes clattering off the edge, not just tipping
    directionDeg: () => randRange(0, 360), focal: null, forceStaggerShape: 'ordered',
  },
  totalChaos: {
    primaryBehaviors: ['FALL'], // rarely used - forceRebelProbability keeps almost every card in the rebel (= fully independent) pool
    rebelBehaviors: BEHAVIORS,
    directionDeg: () => randRange(0, 360), focal: null,
    forceRebelProbability: [0.8, 0.95],
  },
  vacuum: {
    primaryBehaviors: ['VACUUM'],
    directionDeg: null, focal: 'random-edge',
  },
  antiGravity: {
    primaryBehaviors: ['LAUNCH', 'HELICOPTER', 'FLIP', 'DRIFT'], // DRIFT's near-weightless float fits the theme directly
    directionDeg: () => randRange(255, 285), focal: null,
  },
  // "Someone tipped the table": everything glides steadily off in one
  // consistent mostly-downward direction (tilted toward whichever side the
  // table 'tips' to that run) and slides off the bottom of the screen - a
  // slow, orderly cascade rather than a burst, and deliberately kept calm
  // throughout (low rebel rate, no forced late-onset scatter) rather than
  // just relying on the universal chaos-to-calm taper.
  tableTip: {
    primaryBehaviors: ['SLIDE'],
    rebelBehaviors: ['FALL', 'DRIFT'], // the rare defector just drops or lazily floats off - still calm, no wild outliers
    directionDeg: () => 90 + randChoice([-1, 1]) * randRange(10, 35),
    focal: null,
    forceStaggerShape: 'wave', // rolls off in sequence, like things actually sliding off a tilted surface
    forceStaggerRangeMs: [500, 1900],
    forceRebelProbability: [0.05, 0.12],
  },
};

const ACCELERATING_EASINGS = ['cubic-bezier(.55,.06,.68,.19)', 'cubic-bezier(.7,0,.84,0)', 'ease-in'];
const GENERAL_EASINGS = ['cubic-bezier(.25,.46,.45,.94)', 'cubic-bezier(.34,.06,.64,1)', 'ease-out', 'linear'];

function resolveRebelPool(modeProfile) {
  if (modeProfile.rebelBehaviors) return modeProfile.rebelBehaviors;
  const primary = new Set(modeProfile.primaryBehaviors);
  const rest = BEHAVIORS.filter(b => !primary.has(b));
  return rest.length ? rest : BEHAVIORS;
}

// ---------- small RNG helpers (Math.random()-backed, not exported) ----------

function randRange(min, max) { return min + Math.random() * (max - min); }
function randChoice(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randSign() { return Math.random() < 0.5 ? -1 : 1; }

function randomFocalPoint(kind) {
  if (kind === 'center') return { xFrac: 0.5, yFrac: 0.5 };
  if (kind === 'random-point') return { xFrac: randRange(0.2, 0.8), yFrac: randRange(0.2, 0.8) };
  if (kind === 'random-edge') {
    // Biased toward a corner/edge, per VACUUM's "pulled toward an edge or
    // corner" description - snap each axis toward 0 or 1 most of the time.
    const edge = () => (Math.random() < 0.8 ? randChoice([0, 1]) : randRange(0, 1));
    return { xFrac: edge(), yFrac: edge() };
  }
  return null;
}

// ---------- weird events: parameter overlays only, never a new code path ----------
//
// Every weird event is expressed purely by nudging fields the "normal" path
// already produces (mode, rebelProbability, staggerRangeMs, rotationAmountTurns,
// focalPoint) - assignCardBehaviors never learns which weird event (if any)
// produced the personality it's handed, so there is no growing special-case
// branch to maintain.
function applyWeirdEvent(personality) {
  switch (personality.weirdEvent) {
    case 'allLaunchUp':
      personality.mode = 'fountain';
      personality.rebelProbability = 0.03;
      break;
    case 'freezeThenExplode': {
      // Almost all mass bunched late in the start-timeline window - a beat
      // of stillness, then everything goes at once. Rebased on the stagger
      // bounds (the actual start-time spread every card's delay is drawn
      // from), not a duration envelope - individual card durations are
      // unrelated to how bunched their start times are.
      const lateStart = STAGGER_RANGE_BOUNDS_MS[1] * 0.75;
      const lateEnd = Math.min(STAGGER_RANGE_BOUNDS_MS[1], lateStart + 250);
      personality.staggerRangeMs = [lateStart, lateEnd];
      personality.mode = 'explosion';
      personality.rebelProbability = 0.08;
      break;
    }
    case 'convergeToPile':
      personality.mode = 'blackHole';
      personality.focalPoint = randomFocalPoint('center');
      personality.rebelProbability = 0.03;
      break;
    case 'spinFrenzy':
      personality.rotationAmountTurns = randRange(4.5, 7);
      break;
    case 'cornerRush':
      personality.mode = 'vacuum';
      personality.focalPoint = randomFocalPoint('random-edge');
      personality.rebelProbability = 0.05;
      break;
    case 'blowOff':
      personality.mode = 'windstorm';
      personality.rebelProbability = 0.05;
      personality.staggerRangeMs = [0, Math.min(300, personality.staggerRangeMs[1])];
      break;
    default:
      break;
  }
}

// ---------- public API ----------

export function pickHeadline() {
  return HEADLINES[0]; // only one today - the array is the seam for later variety
}

// The single entry point for "what should this win's celebration look like."
// reducedMotion short-circuits to a minimal, DOM-cheap shape with no
// card-behavior fields at all - script.js never builds celebration clones in
// that branch, it just shows the message quickly.
export function generateVictoryPersonality(reducedMotion) {
  if (reducedMotion) {
    return { reducedMotion: true, pauseMs: REDUCED_MOTION_PAUSE_MS, messageEntrance: randChoice(MESSAGE_ENTRANCES) };
  }

  const mode = randChoice(MODES);
  const modeProfile = MODE_PROFILES[mode];

  const staggerMin = randRange(STAGGER_RANGE_BOUNDS_MS[0], STAGGER_RANGE_BOUNDS_MS[1] * 0.5);
  const staggerMax = randRange(staggerMin + 60, STAGGER_RANGE_BOUNDS_MS[1]);
  const staggerRangeMs = modeProfile.forceStaggerRangeMs
    ? [...modeProfile.forceStaggerRangeMs]
    : [Math.round(staggerMin), Math.round(staggerMax)];

  const rebelRange = modeProfile.forceRebelProbability || REBEL_PROBABILITY_RANGE;

  const personality = {
    reducedMotion: false,
    mode,
    primaryBehaviors: modeProfile.primaryBehaviors,
    rebelBehaviors: resolveRebelPool(modeProfile),
    rebelProbability: randRange(rebelRange[0], rebelRange[1]),
    gravityDirectionDeg: ((modeProfile.directionDeg ? modeProfile.directionDeg() : randRange(0, 360)) % 360 + 360) % 360,
    rotationAmountTurns: randRange(ROTATION_AMOUNT_RANGE_TURNS[0], ROTATION_AMOUNT_RANGE_TURNS[1]),
    staggerRangeMs,
    staggerShape: modeProfile.forceStaggerShape || randChoice(['random', 'random', 'ordered', 'wave']),
    focalPoint: modeProfile.focal ? randomFocalPoint(modeProfile.focal) : null,
    chaosOnsetFraction: randRange(CHAOS_ONSET_FRACTION_RANGE[0], CHAOS_ONSET_FRACTION_RANGE[1]),
    weirdEvent: Math.random() < WEIRD_EVENT_PROBABILITY ? randChoice(WEIRD_EVENTS) : null,
    pauseMs: Math.round(randRange(PAUSE_RANGE_MS[0], PAUSE_RANGE_MS[1])),
    messageEntrance: randChoice(MESSAGE_ENTRANCES),
  };

  if (personality.weirdEvent) applyWeirdEvent(personality);
  return personality;
}

// Delay assignment: every card's delay is built from three additive,
// non-negative pieces - pilePhase (per-pile, see below) + depthFromTop's own
// floor (strictly increasing per rank) + a bounded jitter smaller than one
// rank's own step. Because the jitter can never reach the next rank's floor,
// two cards in the SAME pile are guaranteed delayA < delayB whenever
// depthA < depthB - "a lower card never begins moving before cards above it
// in the same pile" holds as a hard property, not a statistical tendency.
// Different piles get independent phases, so cross-pile reordering (a
// mid-pile card from one pile leaving before the top card of another) is
// still completely free to happen - only within-pile ordering is fixed.
function computePileDelayPlan(pileIndex, pileSize, personality) {
  const [minStag, maxStag] = personality.staggerRangeMs;
  const span = Math.max(1, maxStag - minStag);
  const phaseSpread = span * 0.35;
  const perPileSpan = Math.max(1, span - phaseSpread);
  const maxDepth = Math.max(1, pileSize - 1);
  const depthStep = perPileSpan / (maxDepth + 1);
  const jitterMax = depthStep * 0.5;
  const onsetDepth = personality.chaosOnsetFraction * maxDepth;

  let pilePhase;
  if (personality.staggerShape === 'wave' || personality.staggerShape === 'ordered') {
    pilePhase = (pileIndex / 3) * phaseSpread; // column-sequential: pile 0 first, then 1, 2, 3
  } else {
    pilePhase = Math.random() * phaseSpread; // independent per pile - natural interleaving
  }

  return { minStag, depthStep, jitterMax, pilePhase, onsetDepth };
}

function delayForDepth(depthFromTop, plan) {
  const pastOnset = depthFromTop > plan.onsetDepth;
  const jitter = Math.random() * plan.jitterMax * (pastOnset ? CHAOS_JITTER_BOOST : 1);
  // Capped strictly below depthStep (never at or above it) regardless of how
  // much CHAOS_JITTER_BOOST scatters the raw jitter - that's what guarantees
  // this card's delay can never reach or pass the delay of the card above it
  // in the same pile (King must start leaving before Queen, etc.), while
  // still letting boosted post-onset cards feel noticeably more scattered.
  const cappedJitter = Math.min(jitter, plan.depthStep * 0.95);
  return Math.round(plan.minStag + plan.pilePhase + depthFromTop * plan.depthStep + cappedJitter);
}

// foundations: state.foundations (array of 4 pile arrays of card objects
// with an .id), read-only, never mutated - bottom-to-top order (index 0 =
// Ace, last index = King), matching how the real game stores them. Returns
// one plan per card. depthFromTop is 0 for the King (top/leaves first) and
// counts up toward the Ace (bottom/leaves last) - the explicit, testable
// index the sequencing logic is built on, independent of the raw array
// position.
export function assignCardBehaviors(foundations, personality) {
  const plans = [];

  foundations.forEach((pile, pileIndex) => {
    if (!pile.length) return;
    const delayPlan = computePileDelayPlan(pileIndex, pile.length, personality);

    // Walk the pile top-first (King down to Ace) so depthFromTop is trivial
    // to compute correctly by construction, not just by arithmetic on the
    // reversed array index.
    for (let i = pile.length - 1; i >= 0; i--) {
      const card = pile[i];
      const depthFromTop = pile.length - 1 - i;

      // delayMs is computed first so "how far into the departure sequence
      // does this card leave" (calm, 0 for the first cards -> ~1 for the
      // last) can shape its own rebel-odds/rotation/pacing - the
      // chaotic-start/calm-end feel is a function of *when* a card goes, not
      // its pile or behavior. Normalized against staggerRangeMs's own upper
      // bound (roughly the largest delayMs any card can actually get - see
      // computePileDelayPlan/delayForDepth) - delays are only ever spread
      // across the stagger window itself, which is deliberately much
      // shorter than any individual card's own duration now (see
      // BEHAVIOR_PROFILES).
      const delayMs = delayForDepth(depthFromTop, delayPlan);
      const calm = Math.min(1, delayMs / Math.max(1, personality.staggerRangeMs[1]));

      const rebelProbability = personality.rebelProbability * (1 - calm * REBEL_CALM_FACTOR);
      const isRebel = Math.random() < rebelProbability;
      const pool = isRebel ? personality.rebelBehaviors : personality.primaryBehaviors;
      const behavior = randChoice(pool);
      const profile = BEHAVIOR_PROFILES[behavior];

      // No global cap here anymore - each card's duration comes purely from
      // its own behavior's natural range (see BEHAVIOR_PROFILES' own
      // comment). durationFloor still biases a *late-starting* card toward
      // the slower end of that same range (part of the existing "settles
      // down" feel), it just no longer has to also fit inside a shared
      // celebration-length envelope.
      const durationFloor = Math.min(
        profile.durationMs[0] + calm * (profile.durationMs[1] - profile.durationMs[0]) * DURATION_CALM_BIAS,
        profile.durationMs[1]
      );
      const durationMs = Math.round(randRange(durationFloor, profile.durationMs[1]));

      const rotationScale = 0.5 + personality.rotationAmountTurns / 4;
      const calmRotationDamp = 1 - calm * ROTATION_CALM_FACTOR;
      const rotationTurns = randRange(profile.rotationTurns[0], profile.rotationTurns[1]) * rotationScale * calmRotationDamp * randSign();

      const baseAngle = personality.gravityDirectionDeg;
      const spread = 30;
      const exitAngleDeg = profile.inward ? null : ((baseAngle + randRange(-spread, spread)) + 360) % 360;

      plans.push({
        cardId: card.id,
        pileIndex,
        stackOffsetIndex: i,
        depthFromTop,
        behavior,
        isRebel,
        delayMs,
        durationMs,
        exitAngleDeg,
        distanceFactor: randRange(profile.distanceFactor[0], profile.distanceFactor[1]),
        rotationTurns,
        rotationAxis: randChoice(profile.rotationAxis),
        scaleTarget: randRange(profile.scaleTarget[0], profile.scaleTarget[1]),
        easing: randChoice(profile.inward || behavior === 'LAUNCH' || behavior === 'VACUUM' ? ACCELERATING_EASINGS : GENERAL_EASINGS),
        fadeOut: !!profile.fadeOut,
        needsPerspective: !!profile.needsPerspective,
        inward: !!profile.inward,
        // Generic secondary randomization inputs for script.js's keyframe
        // generators (wobble/wander/drift) - kept here so every random
        // decision still lives in this module, never in script.js.
        signA: randSign(),
        signB: randSign(),
        secondaryFactor: Math.random(),
      });
    }
  });

  return plans;
}
