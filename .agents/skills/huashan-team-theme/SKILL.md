---
name: huashan-team-theme
description: Create or update a reusable team-branded theme in huashan-query from a team crest and uniform reference image. Use when adding a new club/team theme or revising its palette; do not use for generic dark/light themes or unrelated visual redesigns.
---

# Huashan Team Theme

Create a team theme as one registry entry plus one transparent crest asset. Reuse the shared `team` CSS template; do not copy selectors for a specific team ID.

Before editing, read [references/theme-contract.md](references/theme-contract.md) completely. Inspect the supplied crest and uniform images visually. Treat the uniform as the palette authority and the crest as a supporting accent source.

## Workflow

1. Confirm the theme ID, Chinese name, optional English name, and supplied image paths. Ask only when identity is genuinely ambiguous.
2. Derive the semantic palette described in the contract. Preserve the uniform's dominant light/dark relationship and reserve loud colors for emphasis.
3. Prepare one transparent crest at `internal/server/web/assets/<theme-id>-crest.webp`. Preserve the official artwork; do not redraw, recolor, or invent missing logo details unless the user explicitly asks.
4. Add one `createTeamTheme(...)` entry to `internal/server/web/js/theme-registry.js`. Do not add team-specific HTML or CSS.
5. Update current user-facing theme lists and release notes when the new theme will ship. Check the in-app help and FAQ under the repository rules; update them only when their instructions or behavior changed.
6. Add or update behavior-focused tests. Verify registry selection, template attributes, semantic variables, crest presence, persistence, and the theme picker; avoid tests that merely duplicate the whole config as text.
7. Run `node --test test/test.mjs`, `go test ./...`, and the repository's normal build check. Inspect the theme on desktop and a narrow mobile viewport when browser testing is available.

Keep existing unrelated worktree changes intact. If the supplied images cannot support a readable palette or usable transparent crest, stop and explain the missing input instead of fabricating branding.
