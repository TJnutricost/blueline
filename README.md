# Blueline Annotate

Point at things on a webpage, try changes live, say what should change, and export a concise **Change Report** for a developer or an AI assistant. No account, API key or subscription needed.

## Install
Blueline is a Chrome extension loaded from a folder ("unpacked").

1. Get the Blueline folder (or extract the ZIP to a permanent place such as `Documents/Blueline`).
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and choose the folder that contains `manifest.json`.
4. Optional: pin Blueline from the puzzle-piece menu, and set a shortcut at `chrome://extensions/shortcuts` (the default is Alt+Shift+Q).
5. Reload any tabs that were already open, then press the shortcut or the toolbar icon.

Keep the folder: Chrome reads it every time it starts. **To update**, replace the files in the same folder (or `git pull`), click reload on the Blueline card, and reload your tabs. Saved notes and your shortcut carry over.

## How it works
1. **Select** what the note is about: **Select element**, **Select area**, or just Shift-click / Shift-drag on the page.
2. **Edit** (optional): try the change live with the Toolbox, Edit CSS, Annotate or Align.
3. **Describe** what should change. The box tells you whether Blueline has recorded any changes yet; with none, a description is required.
4. **Save note.** When you have all your notes, press **Export Change Report** and share the result.

## Selecting
| Action | What it does |
|---|---|
| **Select element** (Alt+P) | Click an element. (Dragging around it works too.) |
| **Select area** | Drag a rectangle over one element, several, or an empty spot ("add something here"). |
| **Shift-click** | Add an element to the note, or remove a selected one. With no note open it starts one. |
| **Shift-drag** | Add everything inside the rectangle. Esc cancels it. |
| **+ Add another element** | Keep clicking to add more, then press Done. |
| **✕ on an element** | Remove just that element and its edits from the note (Undo brings it back). |
| *(no target)* | Save a general note about the whole page. |

Esc cancels the active tool. ⌘Z / Ctrl+Z (or ↶) undoes your last change in the open note; after saving it reopens the last note so you can keep or cancel the undo.

## Editing a note
With several elements selected, choose which one you are editing; each keeps its own edits.

| Tool | What it does |
|---|---|
| **Toolbox** | Edit text, Move, Measure, Match style, Hide, Sample color. Changes preview live on the page. |
| **Edit CSS** | Pick one of the CSS rules that match the element (or **This element only**). It lists that rule's own properties as written; **+ Add CSS property** adds others. Values preview on that element only. |
| **Annotate** | Arrow, box, circle, pen, text. They appear in the note's marked-up screenshot. |
| **Align** | Line an element up with guide lines, or with another element you click: **Align edges**, or **Place next to** (outside it, with Center and Middle options). Several elements move as one group. |
| **Apply CSS changes to** | Just this one, everything like it inside a container, or everywhere. The preview always stays on the one element. |
| **Changes** | What you changed on this element. ✕ reverts one change. |

Describe also has **Screen size** (which sizes the change is for; it doesn't resize the page), **Broken / error**, and a per-note Figma link. On Shopify pages there is a read-only product variant picker.

## The Change Report
The export is a short, change-focused report: the page and detected technology, then for each note its type, your text, the target element and selector, the CSS rule and property changes (old → new), scope, alignment and measurements, drawings, and screenshots. Bugs also include diagnostic details and the steps before the note. Reference-only items (measurements, sampled colors) are labelled as such.

## More tools
Guide lines, a design-image overlay, **Check prices from a CSV** (Shopify pages, read-only), and **Hide / Show my live edits**. Saved notes stay on the page as numbered badges.

## Limits
- Live edits are previews and vanish on reload; saved notes keep them.
- Hash routes (`/#/page`) count as separate pages. No picking inside iframes.
- Cross-origin stylesheets can't be read, so their rules aren't listed.
- Edit CSS doesn't work out which rule wins the cascade, and rules under `@container` or `@scope` are marked "condition not checked".
- On React apps, use a dev server: production builds remove component names.
- Shopify features are read-only; nothing is written to the store.

## For developers
Automated tests live in `tests/` (see `tests/README.md`). Run `cd tests && npm test` (Node 22+ and Chrome).
