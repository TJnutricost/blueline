# Shopify theme repo

## Store safety (read-only)
- The store is live. Never write to it: no `shopify theme push/publish/delete/share/rename`, no Admin API mutations, no product, price, or inventory edits.
- Reads are fine: `shopify theme pull`, theme check, product and variant lookups.
- Edit local files only. The author previews with `shopify theme dev` (or pastes into the dev theme) and pushes by hand.
- Never hardcode prices or variant data into pages. Use Liquid (`{{ product.price | money }}`) and reference variants by handle or id.

## QC batches from Blueline
- A prompt that starts "# QC batch" comes from the Blueline browser extension. Follow its "How to work" section.
- Section wrapper ids look like `shopify-section-template--<id>__<key>`. Find `<key>` in the JSON template, read its `type`, then edit `sections/<type>.liquid`.
- Shogun Page Builder elements are not theme code. Describe the fix for those instead of editing, unless the item names a local source file (data-blueline-src).
- Items marked "previewed" were tried live and approved. Use those values, through existing CSS variables or settings where they exist.
