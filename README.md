# Blueline v0.6

Point at things on your page, say what should change, and export one prompt for Claude Code. One box does everything.

## First-time installation
Blueline is installed as an *unpacked* extension, so Chrome loads it straight from a folder on your computer.

1. Get the Blueline extension folder, or a Blueline ZIP.
2. If you have a ZIP, extract it to a permanent folder, for example `Documents/Blueline`. Don't leave it in Downloads or a temporary folder.
3. Open `chrome://extensions`.
4. Turn on **Developer mode** (top right).
5. Click **Load unpacked**.
6. Select the folder that contains `manifest.json`.
7. Optional: click the puzzle-piece icon in Chrome's toolbar and pin Blueline.
8. Optional: set a keyboard shortcut at `chrome://extensions/shortcuts` (for example Option+B / Alt+B) to turn Blueline on and off. The default is Alt+Shift+Q.
9. Reload any tabs that were already open, then press the shortcut or the toolbar icon to start.
10. If you use Claude Code, copy what you need from `claude-setup/` into your repos.

**Keep the folder.** Chrome reads an unpacked extension from its folder every time it starts. If you move, rename, or delete the folder, Blueline stops working until you load it again.

## Updating an existing installation
If you installed from a ZIP:
1. Extract the new ZIP and copy its files over the files in the folder you originally loaded (the one with `manifest.json`). Keep the same folder location.
2. Open `chrome://extensions` and click the reload icon on the Blueline card.
3. **Reload the tabs you'll QC.** Tabs opened before the update still run the old version.
4. Copy any updated files you need from `claude-setup/` into your repos.

If you work from the Git repository, don't copy ZIP contents into it. Pull or check out the new version with Git instead, then do steps 2 and 3. Your keyboard shortcut and saved notes carry over either way.

## How it works
1. **Add note** opens the note box. Or start from the page with **Select element** (click it) or **Select area** (drag a rectangle over it).
2. In the box: say what should change. Pick **Broken**, **Looks off**, **Change text**, or **Add something**. Text is optional when your annotations (measurements, drawings, alignment, CSS values, element actions) already say it.
3. Optional: try new values live, move things, line things up with guides, or draw on the page.
4. **Save note.** When you have all your notes, **Export prompt** and paste it into Claude Code.

## Pointing at things
| Button | What it does |
|---|---|
| **Select element** (Alt+P) | Click an element on the page. Selecting ends after one click. (Dragging around it works too.) |
| **Select area** | Drag a rectangle over one element, several, or an empty spot. Blueline finds the elements inside it. Selecting empty space marks "add something here". |
| **Shift-click** | Shift-click any element on the page to add it to the note, or Shift-click a selected one to remove it. With no note open, it starts one. The page doesn't react to these clicks. |
| **Shift-drag** | Hold Shift and drag a rectangle to add everything inside it, using the same detection as Select area. Esc cancels the rectangle; ⌘Z / Ctrl+Z undoes the selection. |
| **+ Add another element** | Keep clicking to add more elements to the same note, then press Done. |
| *(no target)* | Save a note without pointing at anything for a general note about the whole page. |

Need to open a menu or tab first? Do that, then press Select element.
Esc cancels whatever is active without removing earlier annotations. The box drags by its title bar and stays anchored by its bottom edge: it grows upward and scrolls inside when space runs out. Click the minimized title bar to expand it.

**Undo** (⌘Z on Mac, Ctrl+Z on Windows, or the ↶ button in the header) steps back through annotation changes in the open note: drawings, measurements, alignment, CSS values and element actions. After you save, Undo reopens the most recently saved note on this page and undoes its last change: press **Update note** to keep it, or **Cancel**. Undo history lasts until the page reloads. It never takes over undo while you're typing in a text field.

## Inside a note
| Section | What it does |
|---|---|
| **Change how it looks** | Edit font size, spacing, color, radius and more. − / + nudge a value (Shift = ×10). Previews live on the page, on every selected element. |
| **Do something with this element** | **Move it somewhere else** · **Make it look like another element** · **Measure the distance to another element** · **Edit its text** · **Hide it** · **Sample a color from the screen** |
| **Apply to** | Just this one, all like it inside a container you choose, or everywhere. |
| **Line up with a guide** | Snap the element's left/center/right (or top/middle/bottom) onto a guide line, previewed on the page. |
| **Draw on the page** | Arrow, box, circle, pen, text. Stays with the note and appears in its screenshot. |
| **Measure** | Starts right away. Nothing selected: click two elements. One selected: click the second. Two selected: measures between them. Three or more: choose the pair. Measurements are exported as reference values, not change requests. |
| **Priority & screen size** | Must fix or nice to have. Which screen sizes it applies to. |
| **Figma link & product variant** | Per-note Figma link. Shopify pages also get a read-only product variant picker. |

## More tools (under your notes)
- **Add guide lines**: drag lines onto the page (they snap to element edges). Hide or remove each one.
- **Overlay a design image**: lay a Figma export over the page.
- **Check prices from a CSV** (Shopify pages): compare a spreadsheet to live prices. Read-only.
- **Hide / Show my live edits**: switch between the real page and your previewed changes.

## The page markers
Every note stays on the page as a numbered badge with an outline. Click a badge or a list item to reopen the note. The dashed-square button in the header switches between outlines and numbers only. Drawings in the note you're editing always stay visible.

## Notes
- **Dev server for React.** Production builds strip component names and source locations.
- Hash routes (`/#/calendar`) count as separate pages.
- Live edits are previews. They vanish on reload. Saved notes keep them.
- Shopify features are read-only. Nothing is written to the store.

## Limits
- No picking inside iframes or the barcode camera feed.
- Cross-origin stylesheets can't be read for matched rules.
- Eyedropper and speaking a note depend on Chrome and site permissions.
- The price check reads CSV only.
