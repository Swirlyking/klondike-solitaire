// While a column is expanded, #tableau is its own scroll container (see
// body.tableau-inspecting #tableau in style.css) - the one part of the board
// allowed to scroll, since the document itself never does. A move that
// collapses the expanded column snaps that scroll back to 0, which moves
// every tableau card down by however far it had been scrolled.
//
// Every animated move measures its destination BEFORE committing (it has
// to - commitMove re-renders, and the glide needs to know where the cards
// are going), so a destination inside #tableau measured at scrollTop 300
// is 300px too high by the time the glide actually runs at scrollTop 0.
// The drag ghosts are position:fixed, so nothing corrects that for them:
// the cascade flies to the stale spot and the real cards then appear
// 300px lower - the "cascade jumped up, then came back down" report.
//
// This re-bases those rects onto the scroll position the glide will
// actually land in. Only rects INSIDE #tableau move with its scroll -
// foundation/waste/stock rects must never be passed through here.
export function rebaseRectsForScroll(rects, scrollTopAtMeasure, scrollTopNow) {
  const shift = scrollTopAtMeasure - scrollTopNow;
  if (shift === 0) return rects;
  return rects.map(r => ({ left: r.left, top: r.top + shift }));
}
