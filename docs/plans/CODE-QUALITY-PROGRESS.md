# Code Quality Remediation — Progress Ledger

> **Agent 必须在每完成一个 Work Package 后更新本文件。**  
> 机器闸门 `final` 要求本文件含 `FINAL: PASS`（见 `scripts/check-code-quality-gates.py`）。  
> 未达标时保持 `FINAL: PENDING`。

## Status

| Field | Value |
|-------|--------|
| Program | `2026-08-01-code-quality-remediation` |
| Spec | `docs/plans/2026-08-01-code-quality-remediation-GOAL.md` |
| Started | `2026-08-01` |
| Current wave | `wave-c` |
| Current WP | `WP-C2` |
| **FINAL** | **PENDING** |

## Wave checklist

| Wave | Gate command | Status | Date | Notes |
|------|----------------|--------|------|-------|
| A 止损 | `python3 scripts/check-code-quality-gates.py --mode wave-a` | PENDING | | |
| B 前端编排 | `python3 scripts/check-code-quality-gates.py --mode wave-b` | PENDING | | |
| C Host+API | `python3 scripts/check-code-quality-gates.py --mode wave-c` | PENDING | | |
| Final | `python3 scripts/check-code-quality-gates.py --mode final` | PENDING | | |

## Work packages

| WP | Title | Status | Commit / PR | Evidence |
|----|-------|--------|-------------|----------|
| WP-A0 | Bootstrap progress + baseline metrics | PASS | | baseline JSON exit 0; metrics below |
| WP-A1 | Delete / wire dead UI (chat thread, SlashPalette) | PENDING | | |
| WP-A2 | Office HTML sanitize + xlsx risk path | PENDING | | |
| WP-A3 | ESLint minimal + CI clippy/fmt/gates | PENDING | | |
| WP-A4 | App.tsx growth freeze note in AGENTS/progress | PENDING | | |
| WP-B1 | ThemeProvider extraction | PENDING | | |
| WP-B2 | ComposerShell extraction | PENDING | | |
| WP-B3 | Session runtime hook extraction | PENDING | | |
| WP-B4 | Settings context / props collapse | PENDING | | |
| WP-B5 | Dialog/modal host extraction | PENDING | | |
| WP-B6 | CSS domain split (batch 1) | PENDING | | |
| WP-C1 | commands/ directory split | PASS | (local wp-c1) | `commands/` dir + 12 domain files; facade mod.rs 27 lines; largest worktree_agents.rs 1936; cargo test 943 pass |
| WP-C2 | session_manager/ directory split | PASS | (local wp-c2) | `session_manager/` dir + 14 files; facade mod.rs 115; max events.rs 1070; cargo test 943 pass / 26 session_manager |
| WP-C3 | api/ domain modules | PASS | (local wp-c3) | 17 modules under src/lib/api/; facade api.ts 26 lines; typecheck clean for api/*; tests 4599 pass |
| WP-C4 | Further App.tsx shrink to wave-c numbers | PENDING | | |
| WP-F1 | Final shrink + timer balance + ≥1k file budget | PENDING | | |
| WP-F2 | Completion handoff doc + smoke matrix | PENDING | | |

## Metrics log (append-only)

| When | App.tsx | useState | useEffect | app.css | commands | session_mgr | api.ts | Settings props | ≥1k files |
|------|---------|----------|-----------|---------|----------|-------------|--------|----------------|-----------|
| baseline | 24843 | 318 | 111 | 30585 | 11622 | 7691 | 4947 | ~180 | ~53 |
| 2026-08-01 A0 | 24842 | 318 | 111 | 30584 | 11621 | 7690 | 4946 | 204 | 53 |
| 2026-08-01 C3 | — | — | — | — | — | — | 26 (facade) + 17 modules | — | — |
| 2026-08-01 C1 | — | — | — | — | facade 27 / max 1936 (12 modules) | 7690 | — | — | — |
| 2026-08-01 C2 | — | — | — | — | — | facade 115 / max 1070 (events) / 14 files | — | — | — |

## Blockers

_(agent lists only true external blockers; do not stop for "phase handoff")_

## Auto-continue

- **User re-prompt not required** between WPs or waves.
- After each WP: update this ledger → run unit gates → start next PENDING WP.
- Stop only on Pause conditions in the Goal spec (secrets leak, data loss risk, missing product decision that blocks compile).
