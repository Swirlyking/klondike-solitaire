# Klondike Solitaire

A self-contained, no-dependency Klondike Solitaire built with plain HTML, CSS, and JavaScript.

## Play locally

No build step required. Serve the folder with any static file server, e.g.:

```bash
npx serve .
```

Then open the printed local URL. (Opening `index.html` directly via `file://` also works, but a local server is recommended for consistent behavior.)

## Features

- Standard Klondike deal and rules (tableau, foundations, stock/waste)
- Drag-and-drop for single cards or valid sequences
- Double-click a card to auto-send it to its foundation
- Draw 1 / Draw 3 toggle, undo, move counter, timer, win screen

## Deployment

This is a static site — no build command is needed. `netlify.toml` sets the publish
directory to the project root (`.`).

## Card artwork

Card face images are from David Bellot's open-source `SVG-cards` deck
(`assets/cards/`), licensed under the GNU LGPL 2.1. See `assets/LICENSE-cards.txt`
and `assets/AUTHORS-cards.txt` for the full license and attribution.
