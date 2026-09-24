// THE GAME SURFACE NEVER MOVES RELATIVE TO THE VIEWPORT - tests for the
// invariant behind the iPad "board jumps up, white area underneath" bug
// (see the THE DOCUMENT NEVER SCROLLS comment near the top of style.css).
//
// The failure lived in the browser's root scroller, which node can't run,
// so this holds the SHIPPED stylesheet and script to the structural rules
// that make that failure impossible - the same assert-the-actual-source
// technique domain-migration.test.js uses for its inline gate:
//   - the document (html/body/:root) is never made scrollable or allowed
//     to grow past the viewport, by any rule, at any breakpoint or state,
//     and body isn't even a scroll container (overflow: clip);
//   - the felt has a solid color under its gradient, so anything iOS does
//     show past the document's edge is felt, not its own white;
//   - expanded-column inspection scrolls #tableau instead, and a fling
//     there can't chain out to the document;
//   - nothing in the game script scrolls the window or styles <html> for
//     inspection.
// It cannot prove real-device WebKit behaves - that still needs an iPad.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8');
const js = readFileSync(new URL('./script.js', import.meta.url), 'utf8');

// Innermost `selector { declarations }` blocks, comments stripped. @media
// wrappers contain nested braces, so they never match themselves - only
// the rules inside them do, which is exactly what's wanted: a rule is
// checked wherever it lives.
function parseRules(source) {
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  for (const [, selector, body] of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const decls = {};
    for (const decl of body.split(';')) {
      const i = decl.indexOf(':');
      if (i === -1) continue;
      // Later declarations of the same property win, as in CSS itself.
      decls[decl.slice(0, i).trim()] = decl.slice(i + 1).trim();
    }
    rules.push({ selectors: selector.split(',').map(s => s.trim()).filter(Boolean), decls });
  }
  return rules;
}

// A selector whose SUBJECT is the document itself: html/body/:root, with
// any classes/attributes/pseudo-classes on it (`body.tableau-inspecting`),
// but not a descendant of them (`body.tableau-inspecting #tableau`).
function targetsDocument(selector) {
  const subject = selector.split(/[\s>+~]+/).pop();
  return /^(html|body|:root)([.:[#][^\s]*)?$/.test(subject);
}

const rules = parseRules(css);
const documentRules = rules.filter(r => r.selectors.some(targetsDocument));

test('the base html/body rule pins the document to the viewport', () => {
  const base = rules.find(r => r.selectors.includes('html') && r.selectors.includes('body') && 'overflow' in r.decls);
  assert.ok(base, 'expected an `html, body` rule that sets overflow');
  assert.equal(base.decls.overflow, 'hidden');
  assert.equal(base.decls['overscroll-behavior'], 'none');
  assert.match(base.decls.height, /^var\(--app-vh/, 'document height must be the fixed viewport height, not content-driven');
});

test('the felt has a solid color under its gradient, so nothing past the document can paint white', () => {
  const base = rules.find(r => r.selectors.includes('html') && r.selectors.includes('body') && 'overflow' in r.decls);
  const bg = base.decls.background || '';
  // Walk to the end of the gradient's own parentheses (it nests var()s),
  // then require a color layer after it: `<gradient> <color>`.
  const start = bg.indexOf('gradient(');
  assert.ok(start !== -1, 'expected the felt gradient on the html/body rule');
  let depth = 0, end = -1;
  for (let i = start + 'gradient'.length; i < bg.length; i++) {
    if (bg[i] === '(') depth++;
    else if (bg[i] === ')' && --depth === 0) { end = i; break; }
  }
  const colorLayer = bg.slice(end + 1).trim();
  assert.ok(colorLayer.length > 0 || base.decls['background-color'],
    'a gradient-only background gives WebKit no page color, so iOS paints its own white past the document edge - see style.css');
});

test('body is not a scroll container at all, so nothing can scroll the board inside it', () => {
  const clip = rules.find(r => r.selectors.length === 1 && r.selectors[0] === 'body' && r.decls.overflow === 'clip');
  assert.ok(clip, 'expected a `body { overflow: clip }` rule - see style.css THE DOCUMENT NEVER SCROLLS');
});

test('no rule anywhere makes the document scrollable', () => {
  for (const r of documentRules) {
    for (const prop of ['overflow', 'overflow-y', 'overflow-x', 'overflow-block']) {
      const value = r.decls[prop];
      if (value === undefined) continue;
      assert.ok(!/\b(auto|scroll|visible)\b/.test(value),
        `${r.selectors.join(', ')} sets ${prop}: ${value} - the document must never scroll (see style.css THE DOCUMENT NEVER SCROLLS)`);
    }
  }
});

test('no rule anywhere lets the document grow past the viewport', () => {
  for (const r of documentRules) {
    if (r.decls.height !== undefined) {
      assert.notEqual(r.decls.height, 'auto', `${r.selectors.join(', ')} sets height: auto`);
    }
    assert.equal(r.decls['min-height'], undefined,
      `${r.selectors.join(', ')} sets min-height - a document that can grow past the viewport is a document that can scroll`);
  }
});

test('expanded-column inspection scrolls #tableau, contained', () => {
  const inspecting = rules.find(r => r.selectors.includes('body.tableau-inspecting #tableau'));
  assert.ok(inspecting, 'expected a body.tableau-inspecting #tableau rule');
  assert.equal(inspecting.decls['overflow-y'], 'auto');
  assert.equal(inspecting.decls['overflow-x'], 'hidden');
  assert.equal(inspecting.decls['overscroll-behavior'], 'contain');
});

test('the game script never scrolls the window or marks <html> for inspection', () => {
  assert.doesNotMatch(js, /documentElement\.classList\.(add|toggle)\(\s*['"]tableau-inspecting/);
  assert.doesNotMatch(js, /\bwindow\.scroll(To|By)?\s*\(/);
  assert.doesNotMatch(js, /\bdocument\.(documentElement|body|scrollingElement)\.scroll(Top|To|By)\b/);
});

test('every animated tableau landing is re-based across the commit', () => {
  // The three paths that measure a destination before commitMove and
  // glide to it after: drag-drop, click-to-move (which Auto Finish and
  // the King cascade also use), and the King-column swap.
  const rebased = js.match(/rebaseRectsForScroll\(/g) || [];
  assert.ok(rebased.length >= 4, `expected the drop, click-move and both King-swap glides to re-base, found ${rebased.length}`);
  const measured = js.match(/const scrollAtMeasure = tableauScrollTop\(\);/g) || [];
  assert.equal(measured.length, 3, 'each of the three measure-then-commit paths records the scroll it measured at');
});
