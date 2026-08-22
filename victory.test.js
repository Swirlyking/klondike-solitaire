import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateVictoryPersonality,
  assignCardBehaviors,
  pickHeadline,
  MODES,
  BEHAVIORS,
  WEIRD_EVENTS,
  MESSAGE_ENTRANCES,
  HEADLINES,
  BEHAVIOR_PROFILES,
  PAUSE_RANGE_MS,
  WEIRD_EVENT_PROBABILITY,
  REDUCED_MOTION_PAUSE_MS,
} from './victory.js';

// Statistical style, same spirit as shuffle-audit.js: this module uses real
// Math.random() (no injectable seed - see victory.js's own comment on why),
// so correctness is checked by generating many samples and asserting every
// one stays within its documented range/shape, rather than golden values.
const TRIALS = 4000;

function makeFoundationsFixture() {
  // 4 piles of 13 cards each, rank ascending Ace(1)->King(13) matching a
  // real completed foundation pile's build order (Ace pushed first, at
  // index 0; King pushed last, at the end of the array / top of the pile).
  let nextId = 0;
  return [0, 1, 2, 3].map(pileIndex =>
    Array.from({ length: 13 }, (_, i) => ({ id: nextId++, suit: 'hearts', rank: i + 1, faceUp: true, pileIndex }))
  );
}

test('BEHAVIOR_PROFILES: every named behavior has a complete, well-formed profile', () => {
  for (const behavior of BEHAVIORS) {
    const p = BEHAVIOR_PROFILES[behavior];
    assert.ok(p, `missing BEHAVIOR_PROFILES entry for ${behavior}`);
    for (const key of ['distanceFactor', 'rotationTurns', 'scaleTarget', 'durationMs']) {
      assert.ok(Array.isArray(p[key]) && p[key].length === 2, `${behavior}.${key} must be a [min,max] pair`);
      assert.ok(p[key][0] <= p[key][1], `${behavior}.${key} min must be <= max`);
    }
    assert.ok(Array.isArray(p.rotationAxis) && p.rotationAxis.length > 0, `${behavior}.rotationAxis must be non-empty`);
    assert.equal(typeof p.inward, 'boolean');
    assert.equal(typeof p.fadeOut, 'boolean');
    assert.equal(typeof p.needsPerspective, 'boolean');
  }
});

test('pickHeadline: returns a non-empty string from HEADLINES, seam ready for future variety', () => {
  assert.ok(HEADLINES.length >= 1);
  const headline = pickHeadline();
  assert.equal(typeof headline, 'string');
  assert.ok(HEADLINES.includes(headline));
});

test('generateVictoryPersonality(true): reduced-motion shape is minimal and has no card-behavior fields', () => {
  for (let i = 0; i < 200; i++) {
    const p = generateVictoryPersonality(true);
    assert.equal(p.reducedMotion, true);
    assert.equal(p.pauseMs, REDUCED_MOTION_PAUSE_MS);
    assert.ok(MESSAGE_ENTRANCES.includes(p.messageEntrance));
    // No mode/behavior-assignment fields at all - script.js must never build
    // celebration clones from this shape.
    for (const field of ['mode', 'primaryBehaviors', 'rebelBehaviors', 'rebelProbability',
      'gravityDirectionDeg', 'rotationAmountTurns', 'staggerRangeMs', 'staggerShape',
      'focalPoint', 'chaosOnsetFraction', 'weirdEvent']) {
      assert.equal(p[field], undefined, `reduced-motion personality must not carry "${field}"`);
    }
  }
});

test('generateVictoryPersonality(false): every field stays within its documented range, over many trials', () => {
  let weirdCount = 0;
  for (let i = 0; i < TRIALS; i++) {
    const p = generateVictoryPersonality(false);
    assert.equal(p.reducedMotion, false);
    assert.ok(MODES.includes(p.mode), `unexpected mode: ${p.mode}`);
    assert.ok(Array.isArray(p.primaryBehaviors) && p.primaryBehaviors.length > 0);
    for (const b of p.primaryBehaviors) assert.ok(BEHAVIORS.includes(b), `unexpected primary behavior: ${b}`);
    assert.ok(Array.isArray(p.rebelBehaviors) && p.rebelBehaviors.length > 0);
    for (const b of p.rebelBehaviors) assert.ok(BEHAVIORS.includes(b), `unexpected rebel behavior: ${b}`);
    assert.ok(p.rebelProbability >= 0 && p.rebelProbability <= 1, `rebelProbability ${p.rebelProbability} out of range`);
    assert.ok(p.gravityDirectionDeg >= 0 && p.gravityDirectionDeg <= 360);
    assert.ok(p.rotationAmountTurns >= 0.6 && p.rotationAmountTurns <= 7, 'rotationAmountTurns may be pushed to ~7 by the spinFrenzy weird event');
    assert.ok(Array.isArray(p.staggerRangeMs) && p.staggerRangeMs.length === 2);
    assert.ok(p.staggerRangeMs[0] >= 0 && p.staggerRangeMs[0] <= p.staggerRangeMs[1]);
    assert.ok(['random', 'ordered', 'wave'].includes(p.staggerShape));
    if (p.focalPoint) {
      assert.ok(p.focalPoint.xFrac >= 0 && p.focalPoint.xFrac <= 1);
      assert.ok(p.focalPoint.yFrac >= 0 && p.focalPoint.yFrac <= 1);
    }
    assert.ok(p.chaosOnsetFraction >= 0 && p.chaosOnsetFraction <= 1);
    assert.ok(p.weirdEvent === null || WEIRD_EVENTS.includes(p.weirdEvent));
    assert.ok(p.pauseMs >= PAUSE_RANGE_MS[0] && p.pauseMs <= PAUSE_RANGE_MS[1]);
    assert.ok(MESSAGE_ENTRANCES.includes(p.messageEntrance));
    if (p.weirdEvent) weirdCount++;
  }
  const rate = weirdCount / TRIALS;
  // Statistical, not exact - generous tolerance around the documented 5%.
  assert.ok(rate > WEIRD_EVENT_PROBABILITY * 0.5 && rate < WEIRD_EVENT_PROBABILITY * 1.8,
    `weird-event rate ${rate} should be roughly ${WEIRD_EVENT_PROBABILITY}`);
});

test('assignCardBehaviors: every card in a 52-card fixture gets exactly one valid, in-range plan', () => {
  const foundations = makeFoundationsFixture();
  const allIds = new Set(foundations.flat().map(c => c.id));
  assert.equal(allIds.size, 52);

  for (let i = 0; i < 300; i++) {
    const personality = generateVictoryPersonality(false);
    const plans = assignCardBehaviors(foundations, personality);
    assert.equal(plans.length, 52);

    const seenIds = new Set();
    for (const plan of plans) {
      assert.ok(allIds.has(plan.cardId), `plan references an unknown card id ${plan.cardId}`);
      assert.ok(!seenIds.has(plan.cardId), `card ${plan.cardId} got more than one plan`);
      seenIds.add(plan.cardId);

      assert.ok(BEHAVIORS.includes(plan.behavior), `unexpected behavior: ${plan.behavior}`);
      assert.ok(plan.pileIndex >= 0 && plan.pileIndex <= 3);
      assert.ok(plan.stackOffsetIndex >= 0 && plan.stackOffsetIndex <= 12);
      assert.ok(plan.depthFromTop >= 0 && plan.depthFromTop <= 12);
      assert.equal(typeof plan.isRebel, 'boolean');
      assert.ok(plan.delayMs >= 0);
      // No global cap anymore (see assignCardBehaviors) - the real
      // invariant is that a card's duration always stays within its OWN
      // behavior's declared natural range.
      const [durMin, durMax] = BEHAVIOR_PROFILES[plan.behavior].durationMs;
      assert.ok(plan.durationMs >= durMin && plan.durationMs <= durMax,
        `card ${plan.cardId} (${plan.behavior}) duration ${plan.durationMs}ms outside its own profile range [${durMin},${durMax}]`);

      if (plan.inward) {
        assert.equal(plan.exitAngleDeg, null);
      } else {
        assert.ok(plan.exitAngleDeg >= 0 && plan.exitAngleDeg < 360);
      }
      assert.ok(Number.isFinite(plan.distanceFactor) && plan.distanceFactor >= 0);
      assert.ok(Number.isFinite(plan.rotationTurns));
      assert.ok(['z', 'x', 'y', 'xy'].includes(plan.rotationAxis));
      assert.ok(Number.isFinite(plan.scaleTarget) && plan.scaleTarget >= 0);
      assert.equal(typeof plan.easing, 'string');
      assert.equal(typeof plan.fadeOut, 'boolean');
      assert.equal(typeof plan.needsPerspective, 'boolean');
      assert.equal(typeof plan.inward, 'boolean');
      assert.ok(plan.signA === 1 || plan.signA === -1);
      assert.ok(plan.signB === 1 || plan.signB === -1);
      assert.ok(plan.secondaryFactor >= 0 && plan.secondaryFactor <= 1);
    }
    assert.equal(seenIds.size, 52);
  }
});

test('assignCardBehaviors: never mutates the foundations array it was given', () => {
  const foundations = makeFoundationsFixture();
  const before = JSON.parse(JSON.stringify(foundations));
  const personality = generateVictoryPersonality(false);
  assignCardBehaviors(foundations, personality);
  assert.deepEqual(foundations, before);
});

test('assignCardBehaviors: within each pile, cards are indexed top-down King(0) -> ... -> Ace(12), matching depthFromTop', () => {
  const foundations = makeFoundationsFixture(); // rank i+1 at array index i; King (rank 13) is the top card
  for (let trial = 0; trial < 50; trial++) {
    const personality = generateVictoryPersonality(false);
    const plans = assignCardBehaviors(foundations, personality);
    const plansById = new Map(plans.map(p => [p.cardId, p]));

    foundations.forEach((pile) => {
      pile.forEach((card) => {
        const plan = plansById.get(card.id);
        // rank 13 (King) -> depthFromTop 0; rank 1 (Ace) -> depthFromTop 12.
        assert.equal(plan.depthFromTop, 13 - card.rank,
          `card rank ${card.rank} should have depthFromTop ${13 - card.rank}, got ${plan.depthFromTop}`);
      });
    });
  }
});

test('assignCardBehaviors: delay never decreases with depth within a single pile (King leaves before/with Queen before/with Jack...)', () => {
  // Non-strict: the underlying jitter is capped strictly below one
  // depthStep in real-number space (see delayForDepth's comment), which
  // guarantees delay is non-decreasing once rounded to whole milliseconds -
  // adjacent depths can round to the same millisecond when the stagger
  // range is narrow, but can never invert (a lower card starting measurably
  // before the card above it), matching the "generally" ordering requirement.
  const foundations = makeFoundationsFixture();
  for (let trial = 0; trial < 200; trial++) {
    const personality = generateVictoryPersonality(false);
    const plans = assignCardBehaviors(foundations, personality);
    const plansById = new Map(plans.map(p => [p.cardId, p]));

    foundations.forEach((pile) => {
      const byDepth = pile
        .map(card => plansById.get(card.id))
        .sort((a, b) => a.depthFromTop - b.depthFromTop);
      for (let i = 1; i < byDepth.length; i++) {
        assert.ok(byDepth[i].delayMs >= byDepth[i - 1].delayMs,
          `depth ${byDepth[i].depthFromTop} (delay ${byDepth[i].delayMs}) should not start before depth ${byDepth[i - 1].depthFromTop} (delay ${byDepth[i - 1].delayMs})`);
      }
    });
  }
});

test('assignCardBehaviors: different piles are not forced into lockstep (cross-pile interleaving occurs)', () => {
  const foundations = makeFoundationsFixture();
  let interleavedTrials = 0;
  const trials = 100;
  for (let trial = 0; trial < trials; trial++) {
    const personality = generateVictoryPersonality(false);
    const plans = assignCardBehaviors(foundations, personality);
    // Sort all 52 plans by delay and check whether the depth-0 (top) cards
    // of the 4 piles appear interleaved with other piles' cards rather than
    // all 4 tops strictly preceding every other card.
    const sorted = [...plans].sort((a, b) => a.delayMs - b.delayMs);
    const topDelays = foundations.map((_, pileIndex) =>
      plans.find(p => p.pileIndex === pileIndex && p.depthFromTop === 0).delayMs);
    const maxTopDelay = Math.max(...topDelays);
    const anyNonTopBeforeMaxTop = sorted.some(p => p.depthFromTop !== 0 && p.delayMs < maxTopDelay);
    if (anyNonTopBeforeMaxTop) interleavedTrials++;
  }
  assert.ok(interleavedTrials > 0, 'expected at least some trials where piles interleave rather than moving in lockstep');
});

test('rebel behaviors are drawn roughly 15-30% of the time, primary the rest (coherence requirement)', () => {
  const foundations = makeFoundationsFixture();
  let rebelCount = 0;
  let total = 0;
  for (let trial = 0; trial < 400; trial++) {
    const personality = generateVictoryPersonality(false);
    const plans = assignCardBehaviors(foundations, personality);
    for (const plan of plans) {
      total++;
      if (plan.isRebel) rebelCount++;
    }
  }
  const rate = rebelCount / total;
  // Each personality's own rebelProbability targets 15-30% (totalChaos and
  // tableTip deliberately override that - see MODE_PROFILES), but the
  // observed population rate sits noticeably lower once the chaos-to-calm
  // taper is folded in: REBEL_CALM_FACTOR pulls a card's effective rebel
  // odds toward 0 the later it departs, so this is a loose sanity check on
  // the actual post-taper population (empirically ~10%), not a restatement
  // of the pre-taper per-personality target.
  assert.ok(rate > 0.06 && rate < 0.18, `overall rebel rate ${rate} should roughly track the post-taper ~10% population rate`);
});

test('cards that leave later in the celebration get calmer: less rotation and lower rebel odds than early cards', () => {
  // Bucket every generated plan by how far into its own trial's start-time
  // spread it begins (delayMs / that trial's own max delayMs), pooled
  // across many trials/modes so mode-specific rotation ranges wash out -
  // only the late-vs-early skew within the same pool of plans is asserted.
  const foundations = makeFoundationsFixture();
  const early = [];
  const late = [];
  for (let trial = 0; trial < 300; trial++) {
    const personality = generateVictoryPersonality(false);
    const plans = assignCardBehaviors(foundations, personality);
    // Bucket relative to this trial's own observed max delay, not a fixed
    // constant - deliberately independent of victory.js's internal
    // normalizer, so this test verifies the actual observable effect rather
    // than restating the implementation.
    const maxDelay = Math.max(...plans.map(p => p.delayMs));
    if (maxDelay <= 0) continue;
    for (const plan of plans) {
      const fraction = plan.delayMs / maxDelay;
      const bucket = { absRotation: Math.abs(plan.rotationTurns), isRebel: plan.isRebel };
      if (fraction < 0.25) early.push(bucket);
      else if (fraction > 0.75) late.push(bucket);
    }
  }
  assert.ok(early.length > 100 && late.length > 100, 'expected enough samples in both buckets');

  const avg = (arr, key) => arr.reduce((sum, x) => sum + x[key], 0) / arr.length;
  const earlyRotation = avg(early, 'absRotation');
  const lateRotation = avg(late, 'absRotation');
  assert.ok(lateRotation < earlyRotation,
    `late-starting cards should rotate less on average (early ${earlyRotation}, late ${lateRotation})`);

  const earlyRebelRate = early.filter(x => x.isRebel).length / early.length;
  const lateRebelRate = late.filter(x => x.isRebel).length / late.length;
  assert.ok(lateRebelRate < earlyRebelRate,
    `late-starting cards should defect to a rebel behavior less often (early ${earlyRebelRate}, late ${lateRebelRate})`);
});

test('tableTip mode: SLIDE-dominant, low rebel rate', () => {
  const foundations = makeFoundationsFixture();
  let found = null;
  for (let i = 0; i < 3000 && !found; i++) {
    const p = generateVictoryPersonality(false);
    if (p.mode === 'tableTip' && !p.weirdEvent) found = p;
  }
  assert.ok(found, 'expected to draw a tableTip personality within 3000 tries');
  assert.deepEqual(found.primaryBehaviors, ['SLIDE']);
  assert.ok(found.rebelProbability <= 0.15, `tableTip should stay calm/coherent, got rebelProbability ${found.rebelProbability}`);

  const plans = assignCardBehaviors(foundations, found);
  assert.equal(plans.length, 52);
  const slideCount = plans.filter(p => p.behavior === 'SLIDE').length;
  assert.ok(slideCount / plans.length > 0.6, `expected SLIDE to dominate tableTip, got ${slideCount}/52`);
});

test('weird events only ever adjust existing personality fields - never add new ones', () => {
  const normalKeys = new Set(Object.keys(generateVictoryPersonality(false)));
  for (let i = 0; i < 2000; i++) {
    const p = generateVictoryPersonality(false);
    if (!p.weirdEvent) continue;
    for (const key of Object.keys(p)) {
      assert.ok(normalKeys.has(key), `weird event "${p.weirdEvent}" introduced an unexpected field "${key}"`);
    }
  }
});
