# Blueline v0.5

Point at things on your page, say what should change, and export one prompt for Claude Code. One box does everything.

## Upgrade
1. Replace your `blueline` folder with this one.
2. `chrome://extensions` → reload Blueline.
3. **Reload the tabs you'll QC.**
4. Copy what you need from `claude-setup/` into your repos.

## How it works
1. **Add note** opens the note box. Or start from the page with **Select element** (click it) or **Circle an area** (drag around it).
2. In the box: say what should change. Pick **Broken**, **Looks off**, **Change text**, or **Add something**.
3. Optional: try new values live, move things, line things up with guides, or draw on the page.
4. **Save note.** When you have all your notes, **Export prompt** and paste it into Claude Code.

## Pointing at things
| Button | What it does |
|---|---|
| **Select element** (Alt+P) | Click an element on the page. Selecting ends after one click. (Dragging around it works too.) |
| **Circle an area** | Drag a circle around one element, several, or an empty spot. Blueline finds the elements under it. Circling empty space marks "add something here". |
| **+ Add another element** | Keep clicking to add more elements to the same note, then press Done. |
| *(no target)* | Save a note without pointing at anything for a general note about the whole page. |

Need to open a menu or tab first? Do that, then press Select element.
Esc cancels whatever is active. The box drags by its title bar.

## Inside a note
| Section | What it does |
|---|---|
| **Change how it looks** | Edit font size, spacing, color, radius and more. − / + nudge a value (Shift = ×10). Previews live on the page, on every selected element. |
| **Do something with this element** | **Move it somewhere else** · **Make it look like another element** · **Measure the distance to another element** · **Edit its text** · **Hide it** · **Sample a color from the screen** |
| **Apply to** | Just this one, all like it inside a container you choose, or everywhere. |
| **Line up with a guide** | Snap the element's left/center/right (or top/middle/bottom) onto a guide line, previewed on the page. |
| **Draw on the page** | Arrow, box, circle, pen, text. Stays with the note and appears in its screenshot. |
| **Priority & screen size** | Must fix or nice to have. Which screen sizes it applies to. |
| **Figma link & product variant** | Per-note Figma link. Shopify pages also get a read-only product variant picker. |

## More tools (under your notes)
- **Add guide lines**: drag lines onto the page (they snap to element edges). Hide or remove each one.
- **Overlay a design image**: lay a Figma export over the page.
- **Check prices from a CSV** (Shopify pages): compare a spreadsheet to live prices. Read-only.
- **Hide / Show my live edits**: switch between the real page and your previewed changes.

## The page markers
Every note stays on the page as a numbered badge with an outline. Click a badge or a list item to reopen the note. **Outlines: on/off** in the header switches between outlines and numbers only.

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
