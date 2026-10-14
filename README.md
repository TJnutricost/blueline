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
2. Optional: edit the page live with the **Toolbox** (text, move, measure, match style, hide), **Edit CSS** and **Align**, or annotate it. All of these can go into the same note.
3. Describe what should change. (The box says whether Blueline has recorded any changes yet; with none, a description is required.) Tick **Broken / error** if something doesn't work, and pick the screen size it's for. Text is optional when your edits and annotations (CSS values, element actions, drawings, alignment, measurements) already say it.
4. **Save note.** When you have all your notes, **Export prompt** and paste it into Claude Code.

## Pointing at things
| Button | What it does |
|---|---|
| **Select element** (Alt+P) | Click an element on the page. Selecting ends after one click. (Dragging around it works too.) |
| **Select area** | Drag a rectangle over one element, several, or an empty spot. Blueline finds the elements inside it. Selecting empty space marks "add something here". |
| **Shift-click** | Shift-click any element on the page to add it to the note, or Shift-click a selected one to remove it. With no note open, it starts one. The page doesn't react to these clicks. |
| **Shift-drag** | Hold Shift and drag a rectangle to add everything inside it, using the same detection as Select area. Esc cancels the rectangle; ⌘Z / Ctrl+Z undoes the selection. |
| **+ Add another element** | Keep clicking to add more elements to the same note, then press Done. (Shift+click does the same without the button.) |
| *(no target)* | Save a note without pointing at anything for a general note about the whole page. |

Need to open a menu or tab first? Do that, then press Select element.
Esc cancels whatever is active without removing earlier annotations. The box drags by its title bar and stays anchored by its bottom edge: it grows upward and scrolls inside when space runs out. Click the minimized title bar to expand it.

**Undo** (⌘Z on Mac, Ctrl+Z on Windows, or the ↶ button in the header) steps back through annotation changes in the open note: drawings, measurements, alignment, CSS values and element actions. After you save, Undo reopens the most recently saved note on this page and undoes its last change: press **Update note** to keep it, or **Cancel**. Undo history lasts until the page reloads. It never takes over undo while you're typing in a text field.

## Inside a note
A note has three steps: **Select**, **Edit**, **Describe**.

| Section | What it does |
|---|---|
| **Select** | The elements the note is about. Select element, Select area, + Add another element, Clear selection. With several elements, a count shows; **Show all** lists them, with their edits and an Edit button. Every element has a ✕ that removes just that element and its edits from the note (Undo brings it back); this also works when you reopen a saved note, and for saved elements that are "not found" on the page. Saved edits are only discarded by that ✕. |
| **Selected element** | The element the tools act on: its type, text and class selector. With several selected, choose which instance to edit. Each instance keeps its own edits. |
| **Toolbox** (default) | **Edit text** · **Move** · **Measure** · **Match style** (optionally on all selected) · **Hide** · **Sample color**. Previews live on the page, on the instance being edited. |
| **Measure** (in the Toolbox) | Starts right away. Nothing selected: click two elements. One selected: click the second. Two selected: measures between them. Three or more: choose the pair. While you pick, the panel shrinks to a small "Blueline · Measure" bar with the step and Cancel (or Esc). A new measurement is drawn on the page; pick another in the list to show that one instead. **Change target** and **Remove** are on each measurement. (The Toolbox **Hide** hides a page element and has nothing to do with measurements.) Measurements are exported as reference values, not change requests. |
| **Edit CSS** | Pick one of the CSS rules that match the element (class rules first; utility classes sit in a collapsed group; or **This element only**). It shows only that rule's own properties, as written (`1.5rem`, `var(--brand)`, `0 0 16px`). **+ Add CSS property** searches all properties (or a `--custom` name) and adds one, marked *added*. − / + nudge a value (Shift = ×10). Changes preview on the instance being edited only and are saved and exported with their rule. |
| **Annotate** | Arrow, box, circle, pen, text. Stays with the note and appears in its screenshot. |
| **Align** | **Guides**: snap the element's left/center/right (or top/middle/bottom) onto a guide line. **Element**: the next element you click becomes the reference (it never moves; **Change** picks another). **Align edges** lines up edges or centers (None, Left, Center, Right × None, Top, Middle, Bottom). **Place next to** puts the selection just outside the reference, touching it (None, Left of, Center, Right of × None, Above, Middle, Below); Center and Middle line up the centers, e.g. Center + Below centers it under the reference, Right of + Middle puts it to the right, vertically centered. Center + Middle together would cover the reference, so use Align edges for that. Place next to keeps content reachable: a placement that would push it well past the left, right or top edge of the page, out of a container that clips it, or below a page that can't scroll isn't applied; you get a short warning and the previous position stays (the element is never resized and the page never scrolls). Pages that scroll can be placed below the viewport, decorative images and graphics may overflow on purpose, and Align edges and Move are not restricted. Each choice previews at once and replaces the previous one; None leaves that direction alone. Several selected elements move as one group and keep their spacing. Works together with Edit CSS: a margin you add becomes space from the reference. Exported as a relationship between the elements. |
| **Changes** | What you changed on the instance being edited: CSS values (original → new), hide, alignment, text, move and match. ✕ reverts one. |
| **Apply CSS changes to** | Just this one, all like it inside a container you choose, or everywhere. With changes made in a CSS rule, "everywhere" means that rule. The preview always stays on the one element. |
| **Describe** | What should change, typed or spoken. **Screen size** records which sizes the change is for (it doesn't resize the page). Tick **Broken / error** when something doesn't work. |
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
- Cross-origin stylesheets can't be read, so their rules aren't listed in Edit CSS or the export. Linked stylesheets show values as Chrome stores them (e.g. `0px`, `rgb()`); `<style>` blocks and style attributes keep the author's text.
- Edit CSS doesn't work out which rule wins the cascade, and rules under `@container` or `@scope` are listed with "condition not checked".
- Eyedropper and speaking a note depend on Chrome and site permissions.
- The price check reads CSV only.
