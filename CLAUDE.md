# Blueline — Development Instructions

## Project
Blueline is a Chrome extension for visually annotating webpages and generating structured implementation prompts for Claude Code.

## Architecture
- Chrome extension using Manifest V3.
- Main files: manifest.json, background.js, content.js, page-hook.js, tools.js.
- icons/ contains extension icons.
- claude-setup/ contains instructions intended for target repositories.

## Development Rules
- Read README.md before making architectural changes.
- Inspect relevant existing code before editing.
- Preserve existing working functionality.
- Prefer small, focused changes over large rewrites.
- Do not modify unrelated files.
- Do not modify claude-setup/ unless explicitly requested.
- Keep Chrome extension permissions minimal.
- Never introduce API keys or credentials into extension source code.
- Do not commit, push, or create pull requests without explicit approval.

## Verification
- Run appropriate syntax checks for modified JavaScript files.
- Run existing automated tests when available.
- Identify anything requiring manual testing in Chrome.
- Do not claim browser testing was performed unless it actually was.

## Working Style
- Keep explanations concise.
- Ask before making significant architectural changes.
- When finished, summarize:
  - What changed
  - What was tested
  - What still needs manual verification
- Do not regenerate the entire extension when a targeted edit will suffice.

## Git Workflow
- main is the stable branch.
- Use short-lived feature branches for development.
- Never force-push main.
- Do not commit or push without approval.