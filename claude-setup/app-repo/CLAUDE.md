# App repo (Next.js / React / static)

## Working rules
- Confirm the stack from `package.json` and the folder layout before editing.
- A prompt that starts "# QC batch" comes from the Blueline browser extension. Follow its "How to work" section.
- Polish and copy items are visual or text only. Don't change logic or data for them.
- Before changing a shared component or a `components/ui/*` primitive, check where else it's used. Prefer a prop, variant, or call-site class.
- Layout fixes apply to the breakpoint noted in the item.
- Items marked "previewed" were tried live and approved. Use those values, through existing tokens or CSS variables where they exist.
- Run lint and typecheck scripts when the project has them, and report what changed per item number.
