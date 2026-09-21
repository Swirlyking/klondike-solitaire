# Mike's Solitaire

Part of the **MIKE Games family** (with Mike's Sudoku and Mike's Mahjong). Shared product/design/
engineering standards live outside this repo at:

```
/Users/michaelstrassburger/Developer/mike-games-system/
```

Read `SYSTEM.md` there before touching anything in the areas it covers (intro, PWA/install, save/resume,
backup, updates/reload, settings, modals, sound, motion, mobile interaction, performance/asset loading,
feedback, stats/rewards, accessibility, error recovery, general engineering conventions). `MATRIX.md` has
a quick per-feature "who has this and how strong is it" table.

## Concurrent Work Check — do this before any substantial edit

Before starting a substantial editing task in this repo, check whether it's safe to edit in this shared
checkout:
- `git status --short` — a dirty tree or unrelated WIP present?
- `git worktree list` — any other active worktree already checked out?
- Any other Claude Code session likely running against this same repo path right now (ask the user if
  unsure)?

If any of those are true, **do not start editing here** — create a dedicated worktree and task branch
first (`git worktree add ../klondike-solitaire-<task> -b <task-branch>`), and do the edit there instead.
This applies even in auto/YOLO permission mode — isolation isn't a confirmation step, it's structural, and
auto mode doesn't override it. Small read-only investigations (reading files, running tests, checking
history) are exempt and may use the main checkout regardless.

While working: never stage or commit files that belong to another task or another session's WIP — before
every commit, check the staged diff actually contains only this task. Don't delete, stash, or clean
another session's uncommitted work to make room. Don't merge a task branch back into `main` unless the user
explicitly asks for that.

Full standard, with the incident that prompted it: `mike-games-system/SYSTEM.md` §16.

## MIKE Games Impact Check — do this without being asked

Whenever work in this repo does any of the following, run a **MIKE GAMES IMPACT CHECK** before considering
the task done:
- improves or replaces an implementation of anything covered in `SYSTEM.md`
- fixes a weakness in one of those shared systems
- discovers a better technical solution to a problem another MIKE game also has
- develops a new UI pattern, solves a mobile/PWA problem, or improves performance/accessibility/persistence
  in a way that isn't obviously Solitaire-only

The check, briefly:
1. Is this game-specific, or does it belong in the MIKE Games System?
2. If shared, is this now the strongest known MIKE implementation of that pattern?
3. Should `SYSTEM.md` (or `MATRIX.md`) be updated to reflect it?
4. Do Sudoku or Mahjong have an older/weaker version worth flagging?
5. Should either of those repos be updated? (Recommend it — don't silently go edit another repo.)
6. Should a future MIKE game inherit this automatically? (Update `NEW-GAME-CHECKLIST.md` if so.)
7. Is this a genuinely new pattern worth documenting even if no other game has an equivalent yet? If so,
   flag it as a **CROSS-GAME CANDIDATE** in `SYSTEM.md`, even without being asked.

Report the result briefly at the end of relevant work. Don't make unrelated changes to Sudoku or Mahjong
automatically — identify and recommend first, let the user decide whether to propagate.

**Before citing anything as a MIKE Games reference implementation, check whether it's actually committed.**
`SYSTEM.md` once described Sudoku's Supabase sync as a built, inspectable reference design when the code
existed only as uncommitted local WIP — never verify a shared-system claim (yours or the doc's) against the
working tree; check `git log`/`git show HEAD:<path>`. Tag any claim whose provenance isn't plain committed
history using `SYSTEM.md`'s own provenance rule (DEPLOYED / COMMITTED / WIP / PLANNED / UNKNOWN) — a WIP
implementation may inform a design, but must never be called "strongest" or cited as a reference until it's
committed.

If you edit `mike-games-system/SYSTEM.md` or `MATRIX.md` as part of this, also add a one-line entry to
`mike-games-system/CHANGELOG.md`.

## Known current position (as of 2026-09-04 — verify before relying on this)

Solitaire has the family's strongest backup/restore, asset-preloading, and iOS safe-area handling, plus
the only rigorous shuffle-fairness audit tool. It deliberately has no save/resume for the active deal (a
legitimate design choice, not a gap) and no achievements system beyond basic best-record stats. Its
`sfx.js` sound module exists but is intentionally dormant/unimported.

Solitaire is also the **reference implementation of the Standard Settings Architecture** (`SYSTEM.md` §06):
Settings ends with Support Mike's Games → Feedback → Reload App → (dev-only) Testing → version footer,
version is fully inert, and dev/prod detection is hostname-based (`IS_LOCAL_DEV` in `script.js`, since this
repo has no build step). Sudoku and Mahjong have not been migrated to this standard yet.

## Temporary: Domain Migration Notice (remove after the old hostname is retired)

This repo carries a deliberately self-contained, **temporary** system that moves players off
`solitaire.mikestrassburger.com` and onto `https://solitaire.mikesgames.app`. It is inert everywhere
except that one old hostname. See `mike-games-system/SYSTEM.md` §18 for the family-level pattern.

- **The gate is the inline `<script>` at the end of `index.html`'s `<head>`**, not `domain-migration.js`.
  It decides hostname + local date before first paint, before any game script, and depends on nothing but
  `index.html` — which matters because these games have no service worker, so an installed Home Screen PWA
  refetches that document on every launch. Read that block's comment before changing anything here.
- **Cutoff: October 1, 2026, local midnight**, a literal constant — never deploy timing.
- `domain-migration.js` only does DOM work (the pre-cutoff notice and its 3-day snooze, plus the live
  cutoff watch for an installed PWA resumed from suspension). The post-cutoff screen needs none of it.
- Two one-line guards in `script.js` (game IIFE, update-checker IIFE) keep the game from booting at all
  past the cutoff, and `shouldShowIconNotice()` defers to the migration notice on the old hostname.
- `domain-migration.test.js` runs the real inline gate out of `index.html` against a hostname/clock table.
  Run it before changing the cutoff, the hostname match, or the copy.

**Testing hooks** (`?migrationHost=1`, `?migrationDate=YYYY-MM-DD`, `?migrationReset=1`) can only ever make
the migration UI *more* visible — `migrationDate` is clamped forward-only, so nothing gets a player back
past a cutoff that has genuinely arrived. Keep that asymmetry if you touch them. Note `hardReload()` drops
the query string, so a simulated session ends at the next in-app reload.

**The old hostname stays attached.** DECIDED 2026-09-21: `solitaire.mikestrassburger.com` keeps resolving
to this Netlify site and keeps serving the migration UI after the cutoff. The cutoff blocks *gameplay*, not
the domain — enforcement is entirely in-page, so detaching the domain would replace the migration screen
with a generic browser error for exactly the stranded-PWA population this exists to reach. Retiring the
origin is a separate, later decision; don't read the Phase 2 copy as licence to pull the DNS record.

**To remove the whole system:** delete `domain-migration.js`, `domain-migration.test.js`, the inline gate in
`index.html`, the `#migration-notice`/`#migration-screen` markup, the migration block at the end of
`style.css`, and the three `MIKE_MIGRATION` references in `script.js`.

## Repo orientation

- Flat structure, no build step, no bundler — ES modules loaded directly by `index.html`. `node --test`
  for unit tests (zero test-runner dependencies).
- Pure/impure split: `game-logic.js`, `victory.js`, `stats.js`, `backup.js`, `shuffle.js` are pure logic
  with co-located `.test.js` files; `script.js` is the DOM/orchestration layer and is not unit-tested
  (documented policy — verify manually in-browser instead).
- `preferences.js` is the generic localStorage wrapper backing settings/stats.
- See `README.md` in this repo for more.
