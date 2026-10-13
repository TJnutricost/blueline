# Blueline tests

Headless Chrome regression tests for element selection and the annotation tools.

## Run

```bash
cd tests
npm test
```

No `npm install` step is needed. The suite has no npm dependencies: it drives your installed Chrome through a small DevTools-protocol client (`cdp.mjs`) built on Node's built-in WebSocket.

`npm test` exits non-zero if any check fails. To test another copy of the extension, for example `main` checked out elsewhere, run `node run.mjs <extension-dir>`.

## Requirements

- Node.js 22 or newer (for the built-in WebSocket).
- No npm dependencies.
- Google Chrome or Chromium. The runner looks in the usual macOS, Linux and Windows locations. Set `CHROME_PATH` if yours is elsewhere.
- No network access. All fixtures are local files in `fixtures/`.

## What it covers

`run.mjs` loads `page-hook.js`, `content.js` and `tools.js` into each fixture page with a small `chrome.*` stub. It then drives real mouse and keyboard input:

| Fixture | Covers |
|---|---|
| `fixtures/selection.html` | Point selection (Shift+hover outline, Shift+click, Select element) through invisible overlays: cover links, `::after` tints, tint layers, stretched card links, `pointer-events: none` text, fade slideshows and SVG icons. Also plain nesting, buttons, empty space, sticky headers and scrolling. Plus Shift+drag over a card grid, Clear selection + Undo, Measure picking, drawing an arrow, cursor restoration, normal page clicks, and an unchanged page DOM. Esc clears the selection (with Undo restoring it) only when nothing else should get the key: drawing, measure picks, text fields, inline text editing, Blueline's dialog, or nothing selected. Also checks the home-screen Shift tip. |
| `fixtures/area.html` | Shift+drag rectangles over Shopify Horizon-style group blocks (heading + paragraph, partial and band drags), nested headings, product cards, button rows, empty space (gives an area note) and long lists. Never selects a parent together with its child. The drag rectangle shows while dragging and is gone after release, while selections, blue outlines and chips stay. Also covers sequential drags, Clear selection + Undo, a drawn box that stays visible, and the empty-area note's region box. Repeated drags over selected elements never add their shared parent or duplicates, while new content can still be added. |
| `fixtures/modal.html` | Open modals block selection behind them (hover, Shift+click, Shift+drag) for a native `<dialog>`, a see-through popup backdrop, a framework-style modal and a transparent click-catcher. Content inside a modal stays selectable. Decorative tints are still seen through when no modal is open. |

## Limits

- **Not a real extension load.** The scripts run in the page's main world, not Chrome's isolated content-script world, and `background.js` (capture, downloads) is not exercised.
- **Real-Chrome checks are still needed.** Keyboard shortcuts, screenshots and exports must still be checked by hand.
- **Optional live sweep.** `npm run sweep -- <url> …` compares Blueline's point targeting with the browser's raw hit target on live pages. It needs network access, results change as sites change, and it is not part of `npm test`.
