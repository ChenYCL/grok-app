# Plugin marketplace (App)

Install and manage Grok Build plugins from Settings → Extensions without dropping to the CLI for day-1 discovery.

## Current behavior

| Action | Where | Effect |
|--------|--------|--------|
| List installed | Extensions → Plugins | `grok plugin list --json` + inspect enrich |
| Enable / disable | Same | CLI + `~/.grok/config.toml` |
| Details / uninstall / update | Same | CLI; GlassModal confirms uninstall |
| **Validate** | Installed row **Validate**, or advanced install **Validate** on a local path | `grok plugin validate [path]`; classified outcomes (kind chip + hint) in **GlassModal** + in-row summary; soft-fail if CLI too old / missing (warn, no hard banner) |
| Browse catalog | Extensions → Marketplace | `plugin list --json --available` (cached) |
| Install from catalog | Marketplace row → confirm | `plugin install --trust` then `plugin enable` + soft-respawn |
| Manual install | Plugins → “Install from path or git…” | Same install path (path / git / `owner/repo`); optional pre-install validate for local folders |
| Marketplace sources | Marketplace → sources details | add / remove / refresh git sources |

Skills / MCP enable toggles remain App-side (`extensions.json` + ACP inject). **Plugins follow CLI/config as source of truth** — do not invent a second store under `~/.grok-app`.

## Catalog UX

1. **Default filter** is **xAI Official** (about a dozen curated plugins). Other sources (e.g. Claude official) are available under “All sources” or per-source chips.
2. **Cache**: first load runs CLI; re-entering Marketplace within ~6h uses in-memory cache. “Refresh catalog” forces a reload. Install/add/remove sources invalidate or patch the cache.
3. **Detail panel**: clicking a catalog row opens a GlassModal detail (name, description, marketplace, version, skill/hooks/agents/MCP badges, install source). **Install** / **Reinstall** from the detail or row still use GlassModal confirm (no `window.confirm`). On success the plugin is **trusted and enabled**, then the agent soft-respawns so skills/MCP appear on the next turn.
4. **Install failure recovery**: errors stick to that plugin row (and detail) with **Retry**; cleared on success. Do not only show a global banner. Errors are **classified** (`cli_missing` / `cli_too_old` / `network` / …) via pure `pluginMarketPro` helpers — kind chip + hint + retry plan (open Runtime / update CLI / retry install). Soft-fail capability gaps use warn tone, not a hard crash banner.
5. **Empty Plugins tab** links to Marketplace (“Browse official plugins”). Installed **Details** may show structured provides/marketplace summary when the CLI list includes it, plus `plugin details` text.
6. **Catalog empty honesty**: loading · CLI missing · CLI too old · offline/network · load error · no sources · empty catalog · empty filter · empty query — each with a distinct title/hint and CTA (Retry / Refresh / Clear filters / Open Runtime). Never invent catalog rows when the CLI fails.

## Component counts

CLI often returns top-level `skill_count: 0` / `has_mcp: false` while `components` is filled. Host parsing (Rust + TS) enriches counts from `components.skills` / `mcpServers` / `hooks` / `agents`.

## Safety

- Never auto-install.
- Install always passes `--trust` for non-interactive UI; confirmation copy states third-party code runs with agent permissions.
- Prefer marketplace name pins (`name@xAI Official`) when the same id exists in multiple catalogs.

## i18n

All user-facing strings under `ext.plugins.*` / `ext.market.*` (en + zh + zh-TW).

## Non-goals

- Publishing plugins from the App.
- Parallel package managers (npm/pip) outside `grok plugin`.
- Hand-maintained catalog under app data (always CLI marketplace sources).

## Roadmap (v2)

Codex-first store + workbench + `@plugin.command` design:  
[docs/plans/2026-07-29-plugin-system-v2-design.md](../plans/2026-07-29-plugin-system-v2-design.md).  
（以 v2 为准；已删 panel-host 试验方向作废。）
