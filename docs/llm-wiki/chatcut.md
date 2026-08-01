# ChatCut (Codex plugin) in Grok App

Grok App consumes the **upstream ChatCut Codex package** (`ChatCut-Inc/agent-plugin` → `codex/`) without permanently forking skill bodies.

## Package layout

| Upstream (Codex) | Grok consumable (adapter output) |
|------------------|----------------------------------|
| `.codex-plugin/plugin.json` | `.grok-plugin/plugin.json` |
| `.mcp.json` (`url`, `http_headers`, `oauth_resource`) | same + mirrored `headers` for ACP |
| `skills/*` | **copy** of upstream skills (no content rewrite; re-adapt overwrites) |
| `assets/` | copy from upstream |

**Pin:** `vendor/chatcut-agent-plugin.pin` (git URL + commit).  
**Clone (not committed, large ffmpeg assets):** `vendor/chatcut-agent-plugin/codex/` via:

```bash
node scripts/chatcut-plugin-start.mjs --fetch
```

**Minimal fixture (tests):** `src/lib/fixtures/chatcut-codex-minimal/`.

## Protocol parity

| Surface | Value |
|---------|--------|
| MCP URL | `https://api.chatcut.io/api/external-mcp/mcp` |
| OAuth resource | same URL |
| Header | `x-chatcut-mcp-surface: codex` until ChatCut documents a Grok surface |

Do **not** invent a `grok` surface value without upstream support — tools will break.

## Editor handoff → Resources browser

Codex skills open ChatCut in the host **internal browser**. Grok maps that to **Resources → EmbeddedBrowser**:

1. Tool result / link contains `browserHandoff`, `editorUrl`, `liveProject`, or `openStrategy.preferredMode: codex-internal-browser`.
2. Pure helpers in `src/lib/chatcutHandoff.ts` choose:
   - **In-app open URL** = `browserHandoff.url` preferred (preserve `dockviewLayout`, `editor-boot-token`) → `ResourceOpenTarget { type: "url", url, title? }`.
   - **Display / Markdown URL** = clean `editorUrl` (strip those Codex-only params).
   - **Billing/pricing** = system external browser only.
3. Host `session://tool` path (and chat link clicks) call `setResourceOpenTarget` + open the aside pane.

Locale path rule (same as Codex skills): zh → `/zh/…`, es → `/es/…`, else English default.

## Install / enable

```bash
# 1) Adapt + validate (no ChatCut account required)
node scripts/chatcut-plugin-start.mjs --fetch

# 2) Install adapted tree (use absolute path — relative paths may be parsed as git shorthand)
grok plugin install --trust "$(pwd)/vendor/chatcut-grok-adapted"
grok plugin enable chatcut   # name from plugin.json

# 3) Or register MCP only (headers required)
grok mcp add chatcut https://api.chatcut.io/api/external-mcp/mcp -t http \
  -H 'x-chatcut-mcp-surface: codex'
# Then complete OAuth when prompted (account required for live tools).
```

> Adapter **copies** skills into the adapted tree (CLI install does not follow symlinks). Do not hand-edit those copies — re-pull + re-adapt overwrites them.

Skills attach via the plugin install path; App Extensions prefs still gate MCP enable on session open (`mcpServers` inject).

## Migration (Codex → Grok, future re-pulls)

1. **Re-pull** upstream: `node scripts/chatcut-plugin-start.mjs --fetch` (updates pin commit as needed).
2. **Re-adapt**: same script regenerates `vendor/chatcut-grok-adapted` (skills symlinked — not hand-edited copies).
3. Re-install / enable plugin if the CLI copy is stale.
4. Never maintain a divergent skill fork under `src/` or App data; craft skills stay upstream-owned.

## Gaps vs Codex host tools

| Codex host | Grok equivalent |
|------------|-----------------|
| `control-in-app-browser` / `node_repl` browser runtime | Resources `EmbeddedBrowser` (open/focus URL) |
| Full browser-control tool_search API | Not 1:1 — open URL + user interacts in pane |
| `codex mcp login chatcut` | `grok mcp` OAuth flow / Extensions MCP wizard |

## Code map

- `src/lib/chatcutHandoff.ts` — URL policy (pure, unit-tested)
- `src/lib/chatcutCodexAdapter.ts` — Codex → Grok manifest/MCP (pure)
- `scripts/chatcut-plugin-start.mjs` — fetch / adapt / validate simulation
- `src/hooks/useSessionHostEvents.ts` — auto-open on `session://tool`
- `src/app/AppWorkbench.tsx` — ChatCut link click → Resources
- Host: `extract_tool_ui_fields` surfaces ChatCut URLs from MCP `rawOutput`
