import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDeal, lockMode, onCommittedMove, onWin } from './deal-tally.js';
import { emptyModeStats, incrementPlays, applyWin } from './stats.js';
import { addGame, addWin, readDay, dayTotals, todayKey } from './today.js';

// A small model of script.js's wiring, built only from the same pure
// functions script.js's persistence wrappers use (stats.js's
// incrementPlays/applyWin, today.js's addGame/addWin). script.js itself is
// not unit-tested (documented repo policy); this is where the counting
// rules are exercised end to end.
//
//   newGame()      -> createDeal()
//   restart()/undo -> deal untouched
//   pushHistory()  -> onCommittedMove()
//   stock draw     -> mode = locked ?? setting; on commit, lockMode(mode) then the move
//   interrupted draw (superseded during its art wait) -> nothing at all
//   checkWin()     -> onWin()
function makeGame({ setting = 'draw3', day = '2026-11-08' } = {}) {
  const sim = {
    setting,
    day,
    deal: createDeal(),
    lifetime: { draw1: emptyModeStats(), draw3: emptyModeStats() },
    // Every Today write, kept per day so midnight behavior is checkable
    // (the real store keeps only one day; see today.test.js for that).
    days: {},
    // The draw count the stock actually used for each draw.
    drawsUsed: [],
  };
  const apply = effects => {
    for (const e of effects) {
      if (e.type === 'lifetimePlay') sim.lifetime[e.mode] = incrementPlays(sim.lifetime[e.mode]);
      if (e.type === 'todayGame') sim.days[e.day] = addGame(sim.days[e.day] ?? null, e.day, e.mode);
      if (e.type === 'todayWin') sim.days[e.day] = addWin(sim.days[e.day] ?? null, e.day, e.mode);
      if (e.type === 'lifetimeWin') sim.lifetime[e.mode] = applyWin(sim.lifetime[e.mode], 100, 90).stats;
    }
  };
  // Mirrors script.js's getDrawCount(): the locked deal mode, else the setting.
  const drawMode = () => sim.deal.mode ?? sim.setting;
  return Object.assign(sim, {
    newGame() { sim.deal = createDeal(); },
    restart() {},
    undo() {},
    move() {
      const r = onCommittedMove(sim.deal, sim.day, sim.setting);
      sim.deal = r.deal;
      apply(r.effects);
    },
    stockDraw() {
      const mode = drawMode();
      sim.drawsUsed.push(mode);
      sim.deal = lockMode(sim.deal, mode);
      sim.move();
    },
    // A first draw whose card-art wait is superseded: computes its mode,
    // commits nothing.
    interruptedStockDraw() { drawMode(); },
    win() {
      const r = onWin(sim.deal, sim.day, sim.setting);
      sim.deal = r.deal;
      apply(r.effects);
    },
    totals(d = sim.day) { return dayTotals(readDay(sim.days[d] ?? null, d)); },
    plays() { return sim.lifetime.draw1.plays + sim.lifetime.draw3.plays; },
    drawMode,
  });
}

// ---------- first committed move ----------

test('a dealt deal with no moves counts nothing', () => {
  const g = makeGame();
  g.newGame();
  assert.equal(g.plays(), 0);
  assert.deepEqual(g.totals(), { games: 0, wins: 0 });
});

test('launch/reload deals without a move never count', () => {
  const g = makeGame();
  g.newGame(); g.newGame(); g.newGame(); // three launches, no play
  assert.equal(g.plays(), 0);
  assert.deepEqual(g.totals(), { games: 0, wins: 0 });
});

test('first move counts one play and one game; later moves add nothing', () => {
  const g = makeGame();
  g.newGame();
  for (let i = 0; i < 21; i++) g.move();
  assert.equal(g.plays(), 1);
  assert.deepEqual(g.totals(), { games: 1, wins: 0 });
});

test('a stock draw as the first action counts like a card move', () => {
  const g = makeGame();
  g.newGame();
  g.stockDraw();
  assert.equal(g.plays(), 1);
  assert.deepEqual(g.totals(), { games: 1, wins: 0 });
});

test('onCommittedMove reports effects only once per deal and day', () => {
  let deal = createDeal();
  const a = onCommittedMove(deal, '2026-11-08', 'draw1');
  assert.deepEqual(a.effects, [
    { type: 'lifetimePlay', mode: 'draw1' },
    { type: 'todayGame', day: '2026-11-08', mode: 'draw1' },
  ]);
  const b = onCommittedMove(a.deal, '2026-11-08', 'draw1');
  assert.deepEqual(b.effects, []);
});

// ---------- undo / restart ----------

test('undo back to an empty history, then moving again, does not recount', () => {
  const g = makeGame();
  g.newGame(); g.move(); g.undo(); g.move();
  assert.equal(g.plays(), 1);
  assert.deepEqual(g.totals(), { games: 1, wins: 0 });
});

test('restart after moving does not recount', () => {
  const g = makeGame();
  g.newGame(); g.move(); g.restart(); g.move(); g.restart(); g.move();
  assert.equal(g.plays(), 1);
  assert.deepEqual(g.totals(), { games: 1, wins: 0 });
});

test('restart before any move, then moving, counts once', () => {
  const g = makeGame();
  g.newGame(); g.restart(); g.move();
  assert.equal(g.plays(), 1);
  assert.deepEqual(g.totals(), { games: 1, wins: 0 });
});

test('undo and restart keep the deal mode locked to its original rules', () => {
  const g = makeGame({ setting: 'draw1' });
  g.newGame(); g.stockDraw();
  g.setting = 'draw3';
  g.undo(); g.stockDraw();
  g.restart(); g.stockDraw();
  assert.deepEqual(g.drawsUsed, ['draw1', 'draw1', 'draw1']);
});

// ---------- abandoned deals ----------

test('an abandoned deal with moves counts as a game; an untouched one does not', () => {
  const g = makeGame();
  g.newGame(); g.move();
  g.newGame(); // abandoned, never moved
  assert.equal(g.plays(), 1);
  assert.deepEqual(g.totals(), { games: 1, wins: 0 });
  g.move();
  assert.equal(g.plays(), 2);
  assert.deepEqual(g.totals(), { games: 2, wins: 0 });
});

test('"on game 5": four abandoned deals then a win', () => {
  const g = makeGame();
  for (let i = 0; i < 4; i++) { g.newGame(); g.move(); }
  g.newGame(); g.move(); g.win();
  assert.deepEqual(g.totals(), { games: 5, wins: 1 });
  assert.equal(g.plays(), 5);
});

// ---------- Draw 1 / Draw 3 ----------

test('changing Deal Style before the first move credits the new mode', () => {
  const g = makeGame({ setting: 'draw3' });
  g.newGame();
  g.setting = 'draw1';
  g.stockDraw();
  g.win();
  assert.deepEqual(g.drawsUsed, ['draw1']);
  assert.equal(g.lifetime.draw1.plays, 1);
  assert.equal(g.lifetime.draw1.wins, 1);
  assert.equal(g.lifetime.draw3.plays, 0);
  assert.equal(g.days['2026-11-08'].draw1.games, 1);
  assert.equal(g.days['2026-11-08'].draw1.wins, 1);
});

test('changing Deal Style mid-deal keeps play, game, win, records and the stock on the original mode', () => {
  const g = makeGame({ setting: 'draw3' });
  g.newGame(); g.stockDraw();
  g.setting = 'draw1';
  g.stockDraw(); g.move(); g.win();
  assert.deepEqual(g.drawsUsed, ['draw3', 'draw3']);
  assert.equal(g.lifetime.draw3.plays, 1);
  assert.equal(g.lifetime.draw3.wins, 1);
  assert.equal(g.lifetime.draw3.fastestTimeSeconds, 100);
  assert.deepEqual(g.lifetime.draw1, emptyModeStats());
  assert.deepEqual(g.days['2026-11-08'].draw1, { games: 0, wins: 0 });
  assert.deepEqual(g.days['2026-11-08'].draw3, { games: 1, wins: 1 });
});

test('the next New Game uses the newly selected Deal Style', () => {
  const g = makeGame({ setting: 'draw3' });
  g.newGame(); g.stockDraw();
  g.setting = 'draw1';
  g.newGame();
  assert.equal(g.drawMode(), 'draw1');
  g.stockDraw();
  assert.deepEqual(g.drawsUsed, ['draw3', 'draw1']);
  assert.equal(g.lifetime.draw1.plays, 1);
});

test('an interrupted first stock draw locks nothing; the next attempt follows the current setting', () => {
  const g = makeGame({ setting: 'draw3' });
  g.newGame();
  g.interruptedStockDraw();
  g.restart();
  assert.equal(g.deal.mode, null);
  assert.equal(g.plays(), 0);
  assert.deepEqual(g.totals(), { games: 0, wins: 0 });
  g.setting = 'draw1';
  g.stockDraw();
  assert.deepEqual(g.drawsUsed, ['draw1']);
  assert.equal(g.lifetime.draw1.plays, 1);
  assert.equal(g.lifetime.draw3.plays, 0);
});

test('lockMode fixes the deal mode once; the committed move counts under it', () => {
  // lockMode alone (no committed move yet) already fixes the deal's rules.
  const locked = lockMode(createDeal(), 'draw1');
  assert.equal(locked.mode, 'draw1');
  assert.equal(locked.playCounted, false);
  assert.equal(lockMode(locked, 'draw3').mode, 'draw1');
  // ...and the move that follows counts under that mode, whatever the
  // setting says by then.
  const { effects } = onCommittedMove(locked, '2026-11-08', 'draw3');
  assert.deepEqual(effects[0], { type: 'lifetimePlay', mode: 'draw1' });
});

test('restarting a won deal and winning again: lifetime win counts, Today does not double', () => {
  const g = makeGame();
  g.newGame(); g.move(); g.win();
  g.restart(); g.move(); g.win();
  assert.equal(g.lifetime.draw3.wins, 2);
  assert.equal(g.lifetime.draw3.plays, 1);
  assert.deepEqual(g.totals(), { games: 1, wins: 1 });
});

test('a won deal replayed and won again the next day counts on that day', () => {
  const g = makeGame({ day: '2026-11-08' });
  g.newGame(); g.move(); g.win();
  g.day = '2026-11-09';
  g.restart(); g.move(); g.win();
  assert.deepEqual(g.totals('2026-11-09'), { games: 1, wins: 1 });
  assert.equal(g.plays(), 1);
});

// ---------- midnight ----------

test('a deal played across midnight is a game on each day but one lifetime play', () => {
  const g = makeGame({ day: '2026-11-08' });
  g.newGame(); g.move(); g.move();
  g.day = '2026-11-09';
  g.move();
  assert.deepEqual(g.totals('2026-11-08'), { games: 1, wins: 0 });
  assert.deepEqual(g.totals('2026-11-09'), { games: 1, wins: 0 });
  assert.equal(g.plays(), 1);
});

test('many moves after crossing midnight still count one game on the new day', () => {
  const g = makeGame({ day: '2026-11-08' });
  g.newGame(); g.move();
  g.day = '2026-11-09';
  for (let i = 0; i < 10; i++) g.move();
  g.restart(); g.move();
  assert.deepEqual(g.totals('2026-11-09'), { games: 1, wins: 0 });
});

test('a win after midnight belongs to the completion day only', () => {
  const g = makeGame({ day: '2026-11-08' });
  g.newGame(); g.move();
  g.day = '2026-11-09';
  g.move(); g.win();
  assert.deepEqual(g.totals('2026-11-08'), { games: 1, wins: 0 });
  assert.deepEqual(g.totals('2026-11-09'), { games: 1, wins: 1 });
  assert.equal(g.plays(), 1);
});

test('when the first action after midnight is the winning one, the new day gets the game too', () => {
  const g = makeGame({ day: '2026-11-08' });
  g.newGame(); g.move();
  g.day = '2026-11-09';
  g.win();
  assert.deepEqual(g.totals('2026-11-09'), { games: 1, wins: 1 });
  assert.equal(g.plays(), 1);
});

test('todayKey splits 11:59 pm and 12:00 am into different days', () => {
  assert.equal(todayKey(new Date(2026, 10, 8, 23, 59, 59)), '2026-11-08');
  assert.equal(todayKey(new Date(2026, 10, 9, 0, 0, 0)), '2026-11-09');
});

// ---------- invariant ----------

test('random sessions: wins never exceed games, one play per deal, one game per deal per day', () => {
  let seed = 12345;
  const rand = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let run = 0; run < 200; run++) {
    const g = makeGame({ setting: rand(2) ? 'draw1' : 'draw3', day: '2026-11-08' });
    let dayIndex = 8;
    let deals = 0;
    let dealsMoved = 0;
    let movedThisDeal = false;
    let wonThisDeal = false;
    const dealDays = new Set();
    let dealDayCount = 0; // sum over deals of distinct days each deal was active on
    const finishDeal = () => { dealDayCount += dealDays.size; dealDays.clear(); };
    g.newGame(); deals++;
    for (let step = 0; step < 300; step++) {
      const r = rand(10);
      if (r < 4) { if (!wonThisDeal) { g.move(); movedThisDeal = true; dealDays.add(g.day); } }
      else if (r === 4) { if (!wonThisDeal) { g.stockDraw(); movedThisDeal = true; dealDays.add(g.day); } }
      else if (r === 5) g.undo();
      else if (r === 6) { g.restart(); wonThisDeal = false; }
      else if (r === 7) { if (movedThisDeal && !wonThisDeal) { g.win(); wonThisDeal = true; dealDays.add(g.day); } }
      else if (r === 8) {
        if (movedThisDeal) dealsMoved++;
        finishDeal();
        g.newGame(); deals++; movedThisDeal = false; wonThisDeal = false;
      } else {
        if (rand(4) === 0) { dayIndex++; g.day = `2026-11-${String(dayIndex).padStart(2, '0')}`; }
        g.setting = rand(2) ? 'draw1' : 'draw3';
      }
    }
    if (movedThisDeal) dealsMoved++;
    finishDeal();

    let totalGames = 0;
    for (const [day, rec] of Object.entries(g.days)) {
      const t = dayTotals(readDay(rec, day));
      assert.ok(t.wins <= t.games, `wins ${t.wins} > games ${t.games} on ${day}`);
      for (const mode of ['draw1', 'draw3']) assert.ok(rec[mode].wins <= rec[mode].games);
      totalGames += t.games;
    }
    assert.equal(g.plays(), dealsMoved);
    assert.equal(totalGames, dealDayCount);
  }
});
