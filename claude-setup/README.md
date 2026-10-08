# Claude Code setup for Blueline

Copy these into the root of the matching repo:

- `theme-repo/CLAUDE.md` and `theme-repo/.claude/settings.json` for Shopify theme repos
- `app-repo/CLAUDE.md` for Next.js, React, or static app repos (merge with an existing CLAUDE.md, or run `/init` first and paste the "Working rules" in)

## About the Shopify deny rules
The deny rules stop Claude Code from running those shell commands. They don't police every route to the store
(for example a script that calls the Admin API directly). For a hard guarantee, give Claude Code a token
that can only read: create a custom app in Shopify with read-only scopes and use that token for any API access.
