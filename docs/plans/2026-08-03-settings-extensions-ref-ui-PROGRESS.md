# PROGRESS — Settings → Extensions redesign

**Branch:** `feat/settings-extensions-ref-ui`  
**Spec:** `docs/plans/2026-08-03-settings-extensions-ref-ui-GOAL.md`

| WP | Status | Notes |
|----|--------|-------|
| WP-0 | DONE | Branch created; baseline vitest green (59 tests). typecheck has pre-existing unrelated `attachments.ts` unused var (not this work). |
| WP-1 | PENDING | |
| WP-2 | PENDING | |
| WP-3 | PENDING | |
| WP-4 | PENDING | |
| WP-5 | PENDING | |
| WP-6 | PENDING | |

## Baseline (WP-0)

```
pnpm exec vitest run src/lib/settingsCatalog.test.ts src/lib/pluginMarketplace.test.ts src/lib/pluginMarketPro.test.ts
→ 3 files, 59 tests PASS

pnpm typecheck
→ FAIL pre-existing: src/lib/attachments.ts(145,10) TS6133 isAbsoluteFsPath unused (out of scope)
```

## FINAL

_(set in WP-6)_
