# Agent notes — Grok App

## Read first

1. **`docs/llm-wiki/`** — product rules for agents (i18n, Grok Build catalog).  
   - [i18n.md](docs/llm-wiki/i18n.md) — all UI strings via `src/i18n/`  
   - [catalog.md](docs/llm-wiki/catalog.md) — models / effort / YOLO  
   - [automations.md](docs/llm-wiki/automations.md) — automation design (Build `/loop` / scheduler; non-blocking)  

2. Do **not** hardcode user-facing English/Chinese. Use `createT(locale)` / `t()`.

3. When adding models or permission modes, update `src/lib/grokCatalog.ts` **and** `docs/llm-wiki/catalog.md`.

4. Prefer real Grok Build CLI behavior (`grok models`, `--always-approve`, `--effort`).

5. Assistant messages: render markdown (`MarkdownBody`); user messages: gray bubble, no role labels.
