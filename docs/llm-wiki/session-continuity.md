# Session continuity & context compact

## Problem

Grok App keeps a **UI journal** (`~/.…/sessions/<appSessionId>/messages.json`) separate from the **Agent session** under `GROK_HOME` (`agent-home/sessions/<encoded-cwd>/<agentSessionId>/`).

If the Host always called `session/new` on reconnect, the model only saw the latest user turn while the UI still showed full history — context looked “broken”.

## Strategy (Host)

### 1. Prefer native resume — `session/load`

On `session_connect` for an existing App session:

1. Spawn `grok agent stdio` with the same `GROK_HOME` / cwd.
2. `initialize` + `authenticate`.
3. If meta has `agentSessionId`, try **`session/load`** with that id + cwd.
4. On success → full agent context (tools, prior turns) restored.  
5. On failure → **`session/new`**, then mark **history bootstrap**.

### 2. Fallback — journal bootstrap (reasonable turns)

When a **new** agent session is created but the App journal already has turns:

- On the **first** `session_send` only, prefix the agent prompt with a compact transcript of recent journal messages:
  - Up to **16** user/assistant messages  
  - **~2k chars** per message (truncated with note)  
  - **~14k chars** total for the block  
- Journal storage still writes only the user-facing turn (no bootstrap text in UI).
- Flag `needs_history_bootstrap` clears after that one send.

This covers load failure, wiped agent dirs, or agent version mismatches.

### 3. Soft-respawn

Permission / mode soft-respawn **keeps** `agentSessionId` so the next connect prefers `session/load`. Bootstrap runs only if load fails.

### 3b. Session data mode switch (E04)

When Settings flips `session_data_mode` independent↔shared, Host calls `recycle_all_agents` on live + background + parked processes (same kill/soft-disconnect paths as idle recycle). Live `agentSessionId` is cleared so reconnect does not `session/load` against the previous `GROK_HOME`. Journals stay. Emits `session://agents_recycled` for a short toast.

### 4. Process limits & idle recycle (I01–I03)

| Setting | Default | Behavior |
|---------|---------|----------|
| `maxConcurrentAgents` | **3** | Cap on live + parked warm agent processes. Switching Ready chats **parks** the prior process (same session id). Over capacity → `PROCESS_LIMIT` + UI toast; LRU parked may be recycled for capacity. |
| `agentIdleMinutes` | **30** | Background watchdog soft-kills idle Ready agents (live + parked). **Session meta + journal stay**; next send reconnects (`session/load` or bootstrap). Emits `session://idle_recycled`. |

Same-cwd warm reuse (one process, switch ACP session) still applies when spawn flags match; otherwise multi-session parks up to the concurrent cap.

## Who does `/compact`?

| Layer | Behavior |
|-------|----------|
| **Agent (Grok Build)** | **Primary.** Auto-compacts when context ≈ **85%** full (`[session] auto_compact_threshold_percent`). User can also run **`/compact [note]`** in-session. |
| **App Host / UI** | Does **not** auto-compress the agent window. Slash **`/compact`** is a user action: confirm dialog → send `/compact …` as a normal prompt to the agent. Host journal is **not** rewritten by compact (UI history stays full). |

### UI surface for compact (required)

Host listens for agent compact signals (`session/update` kinds such as `tokens_used` / `*compact*` / compact tools) and:

1. Appends a **journal marker** (`role: tool`, `marker: context_compact`)
2. Emits `session://context_compact` for live UI
3. Chat shows a **compact banner** (auto vs manual + optional token before→after + summary)
4. Short **toast** on live event

App history still shows full prior bubbles; the banner signals that **agent context** was compressed.

## Agent activity visibility (Codex-style + honesty)

Presentation rules (non-intrusive, audited 2026-07):

1. **Live tools**: only the **running** tool is shown as a **single plain text line** under the current assistant (or at the live edge). Successive tools **replace** the line; when the tool completes the line **disappears**.
2. **Hide success history**: historical successful `tool_step` rows stay in the journal but are **not** stacked in the transcript.
3. **Show failures**: failed / rejected `tool_step` rows **remain visible** in the main conversation (red row).
4. **Turn summary**: after a multi-tool turn, a collapsible **「本回合活动」** block appears under the last assistant (default collapsed; **auto-expands when any tool failed**). ≥3 consecutive read/search tools group as “Gathering context”. Shared derivation with the Tasks side panel (`turnActivity` / `sessionTasks`).
5. **Thinking labels**: collapse titles use content gist (`**bold**` / `# heading` / first line) or duration — **never** 「思考 1 / 思考 2」 numbering. Adjacent thought segments merge; empty assistant ticks do not open a new phase.
6. **End of turn**: stop / stall / agent exit / permission deny / error surface as one **EndOfTurnChip** family (no duplicate banners). User Stop arms a **2s latch** that force-unlocks the composer if Host stays busy.
7. Quiet “thinking” only when busy with no running tool and no streaming assistant.

| Piece | Behavior |
|-------|----------|
| Live tools | Host emits `session://tool`; UI upserts `tool_step`; only running line shown |
| Failed tools | `FailedToolRow` in transcript |
| Turn activity | `TurnActivityBlock` from `buildTurnActivity` |
| Tasks panel | Same tool derivation (`collectSessionTasks` / turn activity) |
| Cancel / stop | `turn_end` / `turn_cancelled` → `EndOfTurnChip` |
| Multi-session busy | `sessionLiveStore` projects streaming / permission for sidebar |
| Session UUID hint | Host injects a narrow search hint when user asks to resume by UUID |

Docs peer: Codex-style mid-stream tool title — never multi-row stack of successes; failures + turn summary stay honest.

## Acceptance

1. Reopen a multi-turn App session after killing the agent process → next send either loads the same `agentSessionId` or injects bootstrap so the model knows prior turns.  
2. Soft-respawn (permission change) → resume preferred.  
3. Brand-new chat → no bootstrap, plain `session/new`.  
4. `/compact` still only runs when the user (or agent auto-threshold) triggers it on the agent side.
