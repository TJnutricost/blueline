# Blueline v0.7

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
| **Toolbox** | Edit text, Move, Measure, Match style, Hide, Sample color. Changes preview live on the page. Its actions start collapsed; press Toolbox to open or close them. |
| **Edit CSS** | Pick one of the CSS rules that match the element (or **This element only**). It lists that rule's own properties as written; **+ Add CSS property** adds others. Values preview on that element only. Border, margin, padding, border radius, box shadow and linear gradients also get separate fields under a **Fields** button (one section open at a time; required ones marked *); raw CSS always stays editable, and Enter in a value input applies it and leaves the field without saving the note. |
| **Annotate** | Arrow, box, circle, pen, text. They appear in the note's marked-up screenshot. |
| **Align** | Line an element up with guide lines, or with another element you click: **Align edges**, or **Place next to** (outside it, with Center and Middle options). Several elements move as one group. |
| **Apply CSS changes to** | Just this one, everything like it inside a container, or everywhere. The preview always stays on the one element. |
| **Changes** | What you changed on this element. ✕ reverts one change. |

Describe also has **Screen size** (which sizes the change is for; it doesn't resize the page), **Broken / error**, and a per-note Figma link (the microphone button dictates the note). An optional **Product card** section finds the product card around the element you selected (by structure, not by tag or class name), outlines it, and lets you step to its **Parent** or back down to a **Child** before you **Confirm card**; your own selection stays as it is and you can still annotate a price or title on its own. A confirmed card is saved with the note and re-checked whenever it is reopened or exported (**Check card** does it on demand): if the page changed so that Blueline can't be sure which card it was, it says so (**Needs confirmation**, **Can't tell which card**, **Not found**, **Hidden**) and never moves the note to another card without you choosing it. The parts Blueline found in the card are under **Detected fields (n)**; pressing one shows it on the page (nothing is assigned yet).

**Choose Product** (first in the section, once a card is confirmed) opens the Product Library window in selection mode: switch saved lists, search by name or SKU, review the product (image, SKU, exact variant id, prices, approval) and, on a Shopify list, pick the exact variant (a product with a single variant says so). Its confirming button stays visible, and you return to the same note. Choosing reads the Library; it never changes it. Shopify is optional; manual products work without it. A variant whose **SKU differs** from the one the list approved is a replacement: the final button is a green **Approve Replacement**, which approves it for this card only (the list is not touched). The replacement starts with the new variant's own title and image, no approved regular price and no sale price (nothing is carried over from the earlier SKU), and any page-specific values you had set must each be kept or dropped before it can be approved. The mapped product is a compact summary with **Change Product**, **Change Variant**, **Check Shopify** (a read-only look at the exact variant in the store) and **Remove Mapping** (asks first; keeps the card, text and CSS). **Edit card values** opens the title, image, regular and promotional price and product link for this card on this page only; the Library, the imported file and the variant are never changed, and a displayed price does not change Shopify checkout. A mapping keeps its own list (by id, so it can come from any saved list) and is compared with that list record whenever it is reopened or exported: only a real change to that record is reported (with the exact difference), never applied silently, and **Use the list’s current values** adopts it on purpose. Choosing another variant is never reported as a change. A confirmed card that has a mapping shows a small **Mapped** marker on the page (amber when something needs attention); clicking it reopens the note. A mapping on its own is enough to save a note.

## The Change Report
The export is a short, change-focused report: the page and detected technology, then for each note its type, your text, the target element and selector, the CSS rule and property changes (old → new), scope, alignment and measurements, drawings, and screenshots. Bugs also include diagnostic details and the steps before the note. Reference-only items (measurements, sampled colors) are labelled as such. Opening, copying (**Copy Report**) or saving the report never downloads anything; press **Export Screenshots** to download the screenshots, which then adds their file paths to the report.

## More tools
Guide lines, a design-image overlay, **Check prices from a CSV** (Shopify pages, read-only), and **Hide / Show my live edits**. Saved notes stay on the page as numbered badges; **Show / Hide outlines** (off by default) adds a thin outline around the elements of saved notes. While you edit a note, its element is always outlined.

## Import Product List (optional)
**More tools → Import Product List** keeps a standalone list of products (a campaign list, a launch list, any product spreadsheet). Once a list is uploaded it appears as the **Product Library**. **No Shopify store is needed** to upload, view, edit, approve, save or export a list; a store is optional and only used to verify products afterwards. Blueline works the same without any of this.

1. **Upload File** (CSV, JSON or DOCX) or drop a file onto the window. The list is named after the file; its name is plain text with a small pencil beside it, and the pencil opens a Save / Cancel rename (only a saved, changed name edits the list). The file is only read, never changed. The screen shows one line, **Original imported file: <name>**; its size, import time and full SHA-256 are under that line's **Details**.
2. Importing another file into a list that already has products asks how: **Create a new list** (default), **Add products to the current list**, or **Replace** the current list's imported content (needs a second click; earlier imports are kept, and your corrections stay with products that are still listed). Nothing is merged or overwritten silently.
3. Products show a neutral **Not verified** until checked. Optionally enter a **Shopify store**, press **Set Store**, then **Check in Shopify**: it finds each SKU's exact variant (read-only: public `/search/suggest.json`, `/products/<handle>.js` and `/cart.js` only) and never picks one for you when several fit. Searching the store as you type waits for a pause, needs three characters and sends one request at a time.
4. Each product is a compact card: a small image, the name, the selected options (flavor, size…), the approved or working price, **one** status (**Verified**, **Not verified**, **Needs review**, **Replacement approval required** or **Replacement approved**), what needs doing, and **Edit Information**, **Change Variant** and **Details**. Anything that needs your decision is on the card: the price approvals while a price is unresolved, and a green **Approve Replacement** for a variant with a **different SKU**. That card stays amber, with the original and the proposed replacement shown apart (the replacement tinted green and labelled "not approved yet"), until you approve it, even when the price matches. Then it shows "Replacement approved".
   **Details** opens in place and shows each fact once: when the imported, Shopify and approved name, SKU and regular price agree, the value appears a single time with a ✓ mark; only differences (a different SKU, a price mismatch, a manual override) get separate, flagged lines. It also has the **variant ID**, product ID, handle and URL (each with a copy button), the promotional price, availability, verification, source placements and the less common actions (Refresh, Clear approval, Revoke approval, Find different product…, Remove). **Full source comparison** opens a table (Field | Imported SMP | Shopify | Approved / Current) of every source value, with differing cells highlighted. Prices differing by exactly 1¢ are flagged as rounding, never silently changed.
5. The header shows the unique product and source placement counts. **All**, **Needs review** and **Promo price warnings** chips filter the list (click an active chip again to show All). A promo price that doesn't match the stated discount is its own warning, not an original-price mismatch.
6. Fix a price with **Use Shopify price**, **Accept SMP price** or **Custom price…**. **Edit Information** changes the display title, regular and promotional price and image (and the SKU of products you added by hand), shows original, Shopify and edited values side by side, and has a Reset for each. Edits never change the imported file or the Shopify link.
7. **Change Variant** replaces the library with its own view inside the same window (← back, the product name, "Current: …"). Pick one variant from a radio list (options, SKU, price, availability, a Current marker, the variant ID in small type), then **Review Variant Change**, which is only enabled for a different variant. The review shows Current and New side by side; a different SKU is called out and needs its own replacement approval. **Confirm Variant Change** applies it and returns you to the same place in the list with the product highlighted; Back or Esc changes nothing. **Find different product…** (in Details, or at the bottom of the view) is for a wrong product. **+ Add Shopify product** and **+ Add product by hand** add products that weren't in the file.
8. **Export Full List** saves every product (unresolved and non-Shopify ones included); **Export Approved Products** saves the approved ones with verification details and lists the rest with a reason. Exports (`blueline.product-library/2`) keep the imported `sku`/`name` apart from the selected `shopifySku`/`variantId`, and say whether an identity is exact or a substitution.

**Manage lists** (a small link under the list name) opens the List Manager as its own view inside the window (← Back, New List), replacing the library until you go back: every saved list with its name, **Created** and **Last edited** date and time, store, product and review counts, and badges for your corrections, replacements to approve or approved, **Same source file** (same file hash) and **First imported** (saved earliest of those; it doesn't mean it is the most correct). Only real changes update Last edited: opening a list, searching, expanding Details or browsing don't. Nothing is merged or deleted for you. The order is fixed by creation time. New List, Open, Rename and Delete are on each entry; Delete first shows what the list holds that exists nowhere else.

Button colours mean the same everywhere in the library: **blue** is the step that moves you forward (Upload File on the empty screen, Review / Confirm Variant Change, Save Changes, Add product, New List, Save name), **green** approves (Approve Replacement, the price approvals), **red** confirms something destructive (Delete permanently), and grey buttons are secondary (Details, Edit Information, Copy, Cancel, Back, Close).

Lists are saved under a generated id (renaming changes only the label), each with an optional store. Visible list names are unique (trimmed, case-insensitive): importing, creating or renaming into a name that is taken gives “Name (2)”, “Name (3)”, and lists that already shared a name are numbered once, oldest keeping its name, with ids, products, corrections, approvals and mappings untouched. A website or local file only reopens the list it last used; another one starts empty, and you choose a saved list or store on purpose. No credentials are used and nothing is written to the store.

## CSS conflicts
When you click **Save note** and one of its CSS changes clashes with another saved note (the same element, the same property, a different value, and a screen size both notes cover), one dialog, **CSS Conflict — Action Required**, lists every clash: the element, the property, the screen size, and the existing and new value side by side. Choose **Keep Existing** or **Use New** for each one, then **Resolve & Save**; Cancel saves nothing. The value that loses stays in its own note, marked inactive for those screen sizes. It is not previewed, and the Change Report leaves it out of both the note summaries and the detailed CSS. Nothing else in either note changes, and the choice is saved with the notes. Only identical property names are compared (`border` and `border-color` are not).

## Limits
- Live edits are previews and vanish on reload; saved notes keep them.
- Hash routes (`/#/page`) count as separate pages. No picking inside iframes.
- Cross-origin stylesheets can't be read, so their rules aren't listed.
- Edit CSS doesn't work out which rule wins the cascade, and rules under `@container` or `@scope` are marked "condition not checked".
- On React apps, use a dev server: production builds remove component names.
- Shopify features are read-only; nothing is written to the store. Product Lists assume two-decimal currencies and reads a store only if its public product endpoints are on.

## For developers
Automated tests live in `tests/` (see `tests/README.md`). Run `cd tests && npm test` (Node 22+ and Chrome).

## Product Mapping

A green **Mapped** badge on a product card opens the Product Mapping window: change the product or variant, edit this page's title, image, prices and link, approve a different-SKU replacement, check the variant in Shopify (read-only) and save with one button (Map & Save, Replace & Save or Approve & Save Replacement). The **Product Library** button under + Add note opens your saved lists.
