// TEMPORARY INSTRUMENTATION - remove once the stock-after-flick reading
// is in hand. Loaded ONLY when the URL contains "diag"; on every ordinary
// visit this file is never even requested.
//
// One question: when a tap on the stock does nothing after a flick, where
// does it break?
//   no DOWN                -> the touch never reached the pile
//   DOWN, no UP            -> gesture cancelled/stolen
//   DOWN+UP, no CLICK      -> iOS declined to synthesise the click
//   CLICK, no draw         -> onStockClick ran and bailed on a guard
//   draw arrives LATE      -> the tap worked, but something awaited
(() => {
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;left:0;right:0;bottom:0;max-height:50vh;overflow:hidden;'
    + 'background:rgba(0,0,0,.9);color:#0f0;font:9px/1.2 ui-monospace,Menlo,monospace;'
    + 'z-index:2147483647;padding:3px 4px;white-space:pre-wrap;word-break:break-word;'
    + 'pointer-events:none';
  const t0 = performance.now();
  const lines = [];
  const ms = () => Math.round(performance.now() - t0);
  let taps = 0, flicks = 0, draws = 0, late = 0;
  const moves = () => { const m = (document.body.innerText || '').match(/Moves:\s*(\d+)/); return m ? +m[1] : -1; };
  const stock = () => document.getElementById('stock');
  const inStock = el => { const s = stock(); return !!(s && el && (el === s || s.contains(el))); };
  const nm = el => !el ? 'null' : (el.id ? '#' + el.id : String(el.className || el.tagName).split(' ')[0]);
  function log(s) {
    lines.push(String(ms()).padStart(6) + ' ' + s);
    while (lines.length > 22) lines.shift();
    box.textContent = 'taps:' + taps + ' flicks:' + flicks + ' draws:' + draws
      + ' LATE:' + late + ' moves:' + moves() + '\n' + lines.join('\n');
  }

  // Flight presence is the only way to tell a flick from a tap-to-move:
  // both reach the same destination, so the board cannot distinguish them.
  let flightEnded = 0, flightStart = 0, inFlight = false;
  setInterval(() => {
    const now = !!document.querySelector('.drag-ghost.flick-flight');
    if (now && !inFlight) { flicks++; flightStart = performance.now(); log('FLICK started'); }
    if (!now && inFlight) {
      flightEnded = performance.now();
      const d = Math.round(flightEnded - flightStart);
      log('FLICK ended (' + d + 'ms = ' + (d > 400 ? 'REAL MOVE, board re-rendered' : 'refusal nudge') + ')');
    }
    inFlight = now;
  }, 16);

  let press = null;
  addEventListener('pointerdown', e => {
    if (!inStock(e.target)) return;
    taps++;
    const since = flightEnded ? Math.round(performance.now() - flightEnded) : -1;
    press = { at: performance.now(), movesAt: moves(), html: (stock() || {}).innerHTML || '',
              up: false, click: false, done: false, n: taps };
    log('tap#' + taps + ' DOWN ' + nm(e.target) + (since >= 0 ? ' (+' + since + 'ms after flick)' : ' (no flick yet)'));
  }, true);

  addEventListener('pointerup', e => {
    if (!press || press.up) return;
    press.up = true;
    const same = ((stock() || {}).innerHTML || '') === press.html;
    log('  UP ' + nm(e.target) + ' | stockDOM ' + (same ? 'unchanged' : '*** REBUILT UNDER FINGER ***'));
  }, true);

  addEventListener('click', e => {
    if (!inStock(e.target) || !press) return;
    press.click = true;
    log('  CLICK fired');
  }, true);

  // Verdict at 700ms, then keep watching to 6s for a LATE draw - that is
  // the signature of the tap having worked but something having awaited.
  setInterval(() => {
    if (!press) return;
    const age = performance.now() - press.at;
    const drew = moves() > press.movesAt;
    if (drew && !press.done) {
      press.done = true;
      if (age <= 750) { draws++; log('  => DREW (' + Math.round(age) + 'ms) OK'); }
      else { draws++; late++; log('  => DREW *** LATE: ' + Math.round(age) + 'ms *** tap worked, something awaited'); }
      press = null; return;
    }
    if (age > 750 && !press.done && !press.verdict) {
      press.verdict = true;
      if (!press.up) log('  => LOST: no pointerup (gesture cancelled)');
      else if (!press.click) log('  => LOST: NO CLICK from iOS  <<< EVENT DELIVERY');
      else log('  => LOST: click fired, no draw  <<< GUARD in onStockClick');
    }
    if (age > 6000) { if (!press.done) log('  => still nothing after 6s'); press = null; }
  }, 100);

  const mount = () => document.body && document.body.appendChild(box);
  if (document.body) mount(); else addEventListener('DOMContentLoaded', mount);
  log('diag ready - flick, then tap the stock ONCE and wait');
})();
