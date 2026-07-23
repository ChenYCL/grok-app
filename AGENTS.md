# Agent notes — Grok App

## Read first

1. **`docs/llm-wiki/`** — product rules for agents (i18n, Grok Build catalog).  
   - [i18n.md](docs/llm-wiki/i18n.md) — all UI strings via `src/i18n/`  
   - [catalog.md](docs/llm-wiki/catalog.md) — models / effort / YOLO  
   - [automations.md](docs/llm-wiki/automations.md) — automation design (Build `/loop` / scheduler; non-blocking)  
   - [account.md](docs/llm-wiki/account.md) — official login, membership, quota, heatmap  
   - [providers.md](docs/llm-wiki/providers.md) — custom relays, agent `GROK_HOME`, editors  
   - [setup.md](docs/llm-wiki/setup.md) — first-run gate (CLI required, account optional)  
   - [icons.md](docs/llm-wiki/icons.md) — app dock icons vs tray/status-bar icons (never mix)

1b. **Release platforms** — [docs/BUILD.md](docs/BUILD.md). mac arm/intel + Windows via CI. Window chrome: `tauri.macos.conf.json` (Overlay) vs `tauri.windows.conf.json` (frameless + self-drawn controls).

2. Do **not** hardcode user-facing English/Chinese. Use `createT(locale)` / `t()`.

3. When adding models or permission modes, update `src/lib/grokCatalog.ts` **and** `docs/llm-wiki/catalog.md`.

3b. Custom providers write `~/.grok-app/agent-home/config.toml` and spawn agent with `GROK_HOME` (independent mode). Do not leave relay keys only in App secrets.

4. Prefer real Grok Build CLI behavior (`grok models`, `--always-approve`, `--effort`).

5. Assistant messages: render markdown (`MarkdownBody`); user messages: gray bubble, no role labels.
