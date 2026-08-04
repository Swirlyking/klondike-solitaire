#!/usr/bin/env node
// DEVELOPMENT-ONLY statistical audit of the shuffle actually shipped in
// shuffle.js. Not loaded by index.html, not imported by script.js, not
// reachable from the browser or the game UI in any way - it's a plain
// Node CLI tool you run by hand:
//
//   node shuffle-audit.js [numberOfDecks]
//
// It deals no cards, renders nothing, and never touches the DOM; it just
// calls the real shuffle() thousands of times on plain 52-element arrays
// and looks for statistical evidence of bias. Importing the exact same
// shuffle.js the game uses (rather than reimplementing the algorithm
// here) is the whole point - an audit of a reimplementation wouldn't
// tell you anything about what players actually get.
//
// Every "should convince a skeptic" test the brief asked for is here:
// per-position card frequency, first/last-card frequency, rank/suit/
// color distribution by position, pairwise adjacency rates, Ace/King/
// face-card clustering, same-suit and alternating-color run rates, and
// a position-drift check (do cards end up suspiciously close to where
// they started - a classic symptom of a partially-broken shuffle).
// Every one is backed by a chi-square or z-test against the exact
// theoretical value for a uniform random permutation, with Bonferroni
// correction wherever many sub-tests are combined into one family, so
// "PASS" means "no statistically significant deviation", not "the
// numbers looked close".

import { shuffle } from './shuffle.js';

const N = Math.max(1, parseInt(process.argv[2], 10) || 100000);
const ALPHA = 0.05;

// ---------- card model (0-51: suit = floor(i/13), rank = (i%13)+1) ----------
// hearts=0, diamonds=1 (red); clubs=2, spades=3 (black). The exact suit
// order doesn't matter for fairness testing - only that every one of the
// 52 identities is distinguishable and starts in a fixed, known slot.

const suitOf = card => Math.floor(card / 13);
const rankOf = card => (card % 13) + 1; // 1..13, 1=Ace, 13=King
const colorOf = card => (suitOf(card) < 2 ? 0 : 1); // 0=red, 1=black
const isAce = card => rankOf(card) === 1;
const isKing = card => rankOf(card) === 13;
const isFace = card => rankOf(card) >= 11; // Jack, Queen, King

function standardDeck() {
  const deck = new Array(52);
  for (let i = 0; i < 52; i++) deck[i] = i; // card i starts at index i
  return deck;
}

// ---------- statistics: chi-square and normal-approximation helpers ----------
// No external dependencies (this project has none) - erf/normalCdf use
// the standard Abramowitz & Stegun 7.1.26 approximation (accurate to
// ~1.5e-7, far more precision than a pass/fail audit needs), and the
// chi-square p-value uses the Wilson-Hilferty cube-root normal
// approximation, which is accurate to a few significant figures for any
// df this script uses (1 to 2703) - plenty to tell "p = 0.4" from
// "p = 0.0001" confidently, which is the actual job here.

function erf(x) {
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}

function normalCdf(z) {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

// Upper-tail p-value for a chi-square statistic with `df` degrees of
// freedom (large chi-square = poor fit = small p).
function chiSquarePValue(chiSq, df) {
  if (chiSq <= 0) return 1;
  const t = Math.cbrt(chiSq / df);
  const mean = 1 - 2 / (9 * df);
  const sd = Math.sqrt(2 / (9 * df));
  const z = (t - mean) / sd;
  return 1 - normalCdf(z);
}

// observed: array of counts. expected: a single number (uniform over all
// categories) or a matching array.
function chiSquareGOF(observed, expected) {
  let chiSq = 0;
  for (let i = 0; i < observed.length; i++) {
    const exp = Array.isArray(expected) ? expected[i] : expected;
    const diff = observed[i] - exp;
    chiSq += (diff * diff) / exp;
  }
  const df = observed.length - 1;
  return { chiSq, df, p: chiSquarePValue(chiSq, df) };
}

// Two-tailed z-test of a sample mean (from `n` roughly-independent
// observations, sample variance `variance`) against a known theoretical
// mean - used for the clustering/run/drift metrics, which are naturally
// one-number-per-deck statistics rather than counts split into
// categories.
function zTestMean(sum, sumSq, n, expectedMean) {
  const mean = sum / n;
  const variance = Math.max(0, sumSq / n - mean * mean);
  const se = Math.sqrt(variance / n);
  const z = se === 0 ? 0 : (mean - expectedMean) / se;
  const p = 2 * (1 - normalCdf(Math.abs(z)));
  return { mean, variance, z, p };
}

// Bonferroni-combines a family of independent tests into one pass/fail:
// with `count` tests each run at the family-wide alpha, roughly
// count*alpha of them would "fail" by pure chance even under perfect
// fairness (e.g. ~2-3 of 52 position tests at alpha=0.05) - correcting
// the per-test threshold to alpha/count keeps the *family's* false-
// positive rate at alpha instead.
function bonferroniWorst(results, familyAlpha = ALPHA) {
  const correctedAlpha = familyAlpha / results.length;
  let worst = results[0];
  for (const r of results) if (r.p < worst.p) worst = r;
  return { pass: worst.p >= correctedAlpha, correctedAlpha, worst };
}

function groupClusterExpectedMean(groupSize, deckSize = 52) {
  // Expected count of adjacent same-group pairs among `deckSize` cards
  // when `groupSize` of them are "marked" (Aces, Kings, face cards, ...):
  // there are deckSize-1 adjacent slots, and for any one of them,
  // P(both marked) = (groupSize/deckSize) * ((groupSize-1)/(deckSize-1)).
  // The (deckSize-1) cancels, leaving this closed form.
  return (groupSize * (groupSize - 1)) / deckSize;
}

// ---------- run the simulation ----------

console.log('SHUFFLE TEST');
console.log(`${N.toLocaleString()} simulated decks\n`);

const startTime = Date.now();

const positionCount = new Uint32Array(52 * 52); // [position*52 + card]
const firstCardCount = new Uint32Array(52);
const lastCardCount = new Uint32Array(52);
const rankByPosition = new Uint32Array(52 * 13); // [position*13 + (rank-1)]
const suitByPosition = new Uint32Array(52 * 4); // [position*4 + suit]
const colorByPosition = new Uint32Array(52 * 2); // [position*2 + color]

let sameSuitNeighbor = 0;
let sameColorNeighbor = 0;
let sameRankNeighbor = 0;
const totalAdjacentPairs = 51 * N;

let aceAdjSum = 0, aceAdjSumSq = 0;
let kingAdjSum = 0, kingAdjSumSq = 0;
let faceAdjSum = 0, faceAdjSumSq = 0;
let sameSuitRunSum = 0, sameSuitRunSumSq = 0; // per-deck count of same-suit-adjacent pairs
let altColorSum = 0, altColorSumSq = 0; // per-deck count of color-changes between neighbors
let driftSum = 0, driftSumSq = 0; // per-deck mean |finalPosition - originalIndex|

for (let d = 0; d < N; d++) {
  const deck = shuffle(standardDeck());

  let deckSameSuitAdj = 0, deckAltColor = 0;
  let deckAceAdj = 0, deckKingAdj = 0, deckFaceAdj = 0;
  let deckDriftSum = 0;

  for (let pos = 0; pos < 52; pos++) {
    const card = deck[pos];
    positionCount[pos * 52 + card]++;
    if (pos === 0) firstCardCount[card]++;
    if (pos === 51) lastCardCount[card]++;
    rankByPosition[pos * 13 + (rankOf(card) - 1)]++;
    suitByPosition[pos * 4 + suitOf(card)]++;
    colorByPosition[pos * 2 + colorOf(card)]++;

    deckDriftSum += Math.abs(pos - card); // card `card` started at index `card`

    if (pos < 51) {
      const next = deck[pos + 1];
      if (suitOf(card) === suitOf(next)) { sameSuitNeighbor++; deckSameSuitAdj++; }
      if (colorOf(card) === colorOf(next)) sameColorNeighbor++; else deckAltColor++;
      if (rankOf(card) === rankOf(next)) sameRankNeighbor++;
      if (isAce(card) && isAce(next)) deckAceAdj++;
      if (isKing(card) && isKing(next)) deckKingAdj++;
      if (isFace(card) && isFace(next)) deckFaceAdj++;
    }
  }

  aceAdjSum += deckAceAdj; aceAdjSumSq += deckAceAdj * deckAceAdj;
  kingAdjSum += deckKingAdj; kingAdjSumSq += deckKingAdj * deckKingAdj;
  faceAdjSum += deckFaceAdj; faceAdjSumSq += deckFaceAdj * deckFaceAdj;
  sameSuitRunSum += deckSameSuitAdj; sameSuitRunSumSq += deckSameSuitAdj * deckSameSuitAdj;
  altColorSum += deckAltColor; altColorSumSq += deckAltColor * deckAltColor;
  const deckMeanDrift = deckDriftSum / 52;
  driftSum += deckMeanDrift; driftSumSq += deckMeanDrift * deckMeanDrift;
}

// Exact theoretical mean |finalPosition - originalIndex| for a single
// card under a uniform random permutation, computed directly rather than
// approximated (52*52 = 2704 additions, trivial cost, done once).
let theoreticalDriftTotal = 0;
for (let o = 0; o < 52; o++) {
  for (let p = 0; p < 52; p++) theoreticalDriftTotal += Math.abs(p - o);
}
const theoreticalMeanDrift = theoreticalDriftTotal / (52 * 52);

const elapsedMs = Date.now() - startTime;

// ---------- assemble & report each test family ----------

const familyResults = []; // top-level {label, pass, detail} for the final summary

function reportFamily(label, outcome) {
  familyResults.push({ label, ...outcome });
}

function detailLine(r) {
  return `chi²=${r.chiSq.toFixed(2)}, df=${r.df}, p=${r.p < 0.0001 ? r.p.toExponential(2) : r.p.toFixed(4)}`;
}

// --- Position distribution: for each of the 52 positions, is the
// distribution of which card lands there uniform over the 52 identities?
{
  const perPosition = [];
  for (let pos = 0; pos < 52; pos++) {
    const observed = positionCount.subarray(pos * 52, pos * 52 + 52);
    perPosition.push({ pos, ...chiSquareGOF(observed, N / 52) });
  }
  const { pass, correctedAlpha, worst } = bonferroniWorst(perPosition);
  reportFamily('Position distribution', {
    pass,
    detail: pass
      ? `worst of 52 positions: position ${worst.pos}, ${detailLine(worst)} (Bonferroni α=${correctedAlpha.toExponential(2)})`
      : `position ${worst.pos} deviates significantly: ${detailLine(worst)} (Bonferroni α=${correctedAlpha.toExponential(2)})`,
  });
}

// --- First-card / last-card distribution: uniform over 52 identities?
{
  const r = chiSquareGOF(firstCardCount, N / 52);
  reportFamily('First-card distribution', { pass: r.p >= ALPHA, detail: detailLine(r) });
}
{
  const r = chiSquareGOF(lastCardCount, N / 52);
  reportFamily('Last-card distribution', { pass: r.p >= ALPHA, detail: detailLine(r) });
}

// --- Rank / suit / color distribution by position (52 sub-tests each)
{
  const perPosition = [];
  for (let pos = 0; pos < 52; pos++) {
    const observed = rankByPosition.subarray(pos * 13, pos * 13 + 13);
    perPosition.push({ pos, ...chiSquareGOF(observed, N / 13) });
  }
  const { pass, correctedAlpha, worst } = bonferroniWorst(perPosition);
  reportFamily('Rank distribution by position', {
    pass,
    detail: `worst of 52 positions: position ${worst.pos}, ${detailLine(worst)} (Bonferroni α=${correctedAlpha.toExponential(2)})`,
  });
}
{
  const perPosition = [];
  for (let pos = 0; pos < 52; pos++) {
    const observed = suitByPosition.subarray(pos * 4, pos * 4 + 4);
    perPosition.push({ pos, ...chiSquareGOF(observed, N / 4) });
  }
  const { pass, correctedAlpha, worst } = bonferroniWorst(perPosition);
  reportFamily('Suit distribution by position', {
    pass,
    detail: `worst of 52 positions: position ${worst.pos}, ${detailLine(worst)} (Bonferroni α=${correctedAlpha.toExponential(2)})`,
  });
}
{
  const perPosition = [];
  for (let pos = 0; pos < 52; pos++) {
    const observed = colorByPosition.subarray(pos * 2, pos * 2 + 2);
    perPosition.push({ pos, ...chiSquareGOF(observed, N / 2) });
  }
  const { pass, correctedAlpha, worst } = bonferroniWorst(perPosition);
  reportFamily('Color distribution by position', {
    pass,
    detail: `worst of 52 positions: position ${worst.pos}, ${detailLine(worst)} (Bonferroni α=${correctedAlpha.toExponential(2)})`,
  });
}

// --- Adjacency: pooled same-suit / same-color / same-rank neighbor rates
{
  const expectedRate = 12 / 51; // 12 of the other 51 cards share a given card's suit
  const observed = [sameSuitNeighbor, totalAdjacentPairs - sameSuitNeighbor];
  const expected = [totalAdjacentPairs * expectedRate, totalAdjacentPairs * (1 - expectedRate)];
  const suitR = chiSquareGOF(observed, expected);

  const colorExpectedRate = 25 / 51;
  const colorObserved = [sameColorNeighbor, totalAdjacentPairs - sameColorNeighbor];
  const colorExpected = [totalAdjacentPairs * colorExpectedRate, totalAdjacentPairs * (1 - colorExpectedRate)];
  const colorR = chiSquareGOF(colorObserved, colorExpected);

  const rankExpectedRate = 3 / 51; // 3 other cards share a given card's rank
  const rankObserved = [sameRankNeighbor, totalAdjacentPairs - sameRankNeighbor];
  const rankExpected = [totalAdjacentPairs * rankExpectedRate, totalAdjacentPairs * (1 - rankExpectedRate)];
  const rankR = chiSquareGOF(rankObserved, rankExpected);

  const { pass, correctedAlpha, worst } = bonferroniWorst(
    [{ label: 'same-suit', ...suitR }, { label: 'same-color', ...colorR }, { label: 'same-rank', ...rankR }],
  );
  reportFamily('Adjacency tests', {
    pass,
    detail:
      `same-suit-neighbor rate ${(sameSuitNeighbor / totalAdjacentPairs).toFixed(4)} (expect ${expectedRate.toFixed(4)}), ` +
      `same-color-neighbor rate ${(sameColorNeighbor / totalAdjacentPairs).toFixed(4)} (expect ${colorExpectedRate.toFixed(4)}), ` +
      `same-rank-neighbor rate ${(sameRankNeighbor / totalAdjacentPairs).toFixed(4)} (expect ${rankExpectedRate.toFixed(4)}); ` +
      `worst: ${worst.label}, ${detailLine(worst)} (Bonferroni α=${correctedAlpha.toExponential(2)})`,
  });
}

// --- Clustering: Aces, Kings, face cards
function reportClustering(label, sum, sumSq, groupSize) {
  const expectedMean = groupClusterExpectedMean(groupSize);
  const r = zTestMean(sum, sumSq, N, expectedMean);
  reportFamily(label, {
    pass: r.p >= ALPHA,
    detail: `mean adjacent pairs/deck = ${r.mean.toFixed(4)} (expect ${expectedMean.toFixed(4)}), z=${r.z.toFixed(3)}, p=${r.p < 0.0001 ? r.p.toExponential(2) : r.p.toFixed(4)}`,
  });
}
reportClustering('Ace clustering', aceAdjSum, aceAdjSumSq, 4);
reportClustering('King clustering', kingAdjSum, kingAdjSumSq, 4);
reportClustering('Face-card clustering', faceAdjSum, faceAdjSumSq, 12);

// --- Runs: same-suit-adjacent count/deck, alternating-color count/deck
{
  const expectedMean = 51 * (12 / 51); // = 12 exactly
  const r = zTestMean(sameSuitRunSum, sameSuitRunSumSq, N, expectedMean);
  reportFamily('Same-suit runs', {
    pass: r.p >= ALPHA,
    detail: `mean same-suit-adjacent pairs/deck = ${r.mean.toFixed(4)} (expect ${expectedMean.toFixed(4)}), z=${r.z.toFixed(3)}, p=${r.p < 0.0001 ? r.p.toExponential(2) : r.p.toFixed(4)}`,
  });
}
{
  const expectedMean = 51 * (26 / 51); // = 26 exactly
  const r = zTestMean(altColorSum, altColorSumSq, N, expectedMean);
  reportFamily('Alternating-color runs', {
    pass: r.p >= ALPHA,
    detail: `mean color-changes/deck = ${r.mean.toFixed(4)} (expect ${expectedMean.toFixed(4)}), z=${r.z.toFixed(3)}, p=${r.p < 0.0001 ? r.p.toExponential(2) : r.p.toFixed(4)}`,
  });
}

// --- Extra: position-drift correlation (do cards end up suspiciously
// close to their pre-shuffle slot? - catches partial/windowed shuffles)
{
  const r = zTestMean(driftSum, driftSumSq, N, theoreticalMeanDrift);
  reportFamily('Position-drift correlation', {
    pass: r.p >= ALPHA,
    detail: `mean |finalPos - originalIndex| = ${r.mean.toFixed(4)} (expect ${theoreticalMeanDrift.toFixed(4)}), z=${r.z.toFixed(3)}, p=${r.p < 0.0001 ? r.p.toExponential(2) : r.p.toFixed(4)}`,
  });
}

// ---------- print the report ----------

const labelWidth = Math.max(...familyResults.map(r => r.label.length)) + 1;
for (const r of familyResults) {
  console.log(`${(r.label + ':').padEnd(labelWidth + 1)} ${r.pass ? 'PASS' : 'FAIL'}`);
  console.log(`  ${r.detail}`);
}

const allPass = familyResults.every(r => r.pass);
const failed = familyResults.filter(r => !r.pass);

console.log();
if (allPass) {
  console.log('Overall: NO EVIDENCE OF SHUFFLE BIAS');
} else {
  console.log(`Overall: POSSIBLE SHUFFLE BIAS DETECTED in ${failed.length} test(s): ${failed.map(f => f.label).join(', ')}`);
  console.log('(See the deviation detail above for each failing test. This script does not modify the shuffle automatically.)');
}
console.log(`\n${N.toLocaleString()} decks simulated in ${(elapsedMs / 1000).toFixed(2)}s`);
