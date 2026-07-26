# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**Maintainer rule (AI):** before every `vX.Y.Z` tag, complete `## [X.Y.Z]` below.  
CI Release body = this section only (via `scripts/changelog-for-release.py`; no repeated download/install boilerplate).  
See `docs/llm-wiki/release.md`.

## [Unreleased]

> **Highlight:** phone mirror & remote IM, settings/search IA, skins, chat UX polish, official plugin marketplace install, voice buttons only when speech auth is ready.

### Added

- **Mid-turn Steer (interject)**: while a turn is generating, queue items can inject guidance via `_x.ai/interject` without cancelling the turn or rewriting the existing per-session send queue.

- **Phone mirror**: optional control of the workbench from a phone browser (live stream, send, permissions). Off by default.
- **Remote IM**: Feishu / WeChat (and related) bridge synced with App sessions.
- **Settings IA**: tabbed pages + searchable catalog; remote control (IM + mirror) in one place.
- **Appearance**: color skins, custom wallpaper, scrim strength; follow system theme.
- **Chat UX**: clearer turn/activity blocks; context usage chip; find-in-chat; prompt history (↑/↓); session pin; reopen last chat; compact with note; rewind with optional file restore; goal status clear.
- **Slash palette**: export, copy, find, extensions shortcuts.
- **Composer voice dictation** (mic): only when official login / official xAI API key is configured **and** the active provider is Official Grok — hidden on third-party providers. Live voice entry stays hidden (not product-ready).
- **Plugin marketplace**: browse official catalog, one-click install + enable, catalog cache; path/git install under advanced.
- **Extensions depth**: hooks, MCP add/remove/doctor, preferred agent, permission rules, managed setup.
- **Agent/runtime toggles**: sandbox, max turns, disable web search, plan mode, subagents, memory, leader, worktree new-chat, per-model efforts.
- **Session tools**: active tasks panel, session trace export, store quarantine toast.

### Fixed

- **Sidebar project collapse remembered**: collapsed folders persist across relaunch (`sidebarCollapsedProjectIds`).
- **Launch opens new chat by default**: `reopenLastSession` defaults off (one-shot migration for existing installs); start on a draft new-chat page unless the setting is enabled.
- **Launch does not pre-select a project**: cold start leaves the project chip empty (orphan draft); first trusted/first project is no longer auto-selected.
- **Connect device → IM by default**: sidebar “Connect device” opens Remote control → **IM** tab (not Phone mirror).
- **Empty-run toast spam (#128)**: only soft-signal when a non-ask turn ends with **no visible assistant reply** and zero tool calls. Pure-text answers (body present, no tools) no longer toast every turn.
- Primary buttons use theme accent (not warning color).
- Plan progress scoped to the viewed session; hard-dismiss confirm.
- zh / zh-TW auto-titles and locale id aliases.
- Composer mic hidden without official speech auth, or when a custom/third-party provider is active; live voice button not shown.
- Resource pane file editor: full-height text area (no 2-line collapse); Edit / Save / Revert moved from chrome into an in-page toolbar above the file body.
- Markdown files use **TipTap** (WYSIWYG + `tiptap-markdown` serialize) instead of a plain textarea; format toolbar for bold/italic/headings/lists/link.
- Chrome count badges (tasks / changes / rules) no longer drift to the window top-right: `.chrome-btn` is a positioning context for `rp-chrome__badge`.
- **Multi-session non-exclusive agents**: switching chats no longer stops background turns. Host demotes busy sessions instead of cancelling; no same-cwd process steal; UI keeps applying streams by `sessionId` + `session://runtime`.
- **Process pool**: default concurrent agents **8** (cap **32**); spawn reclaims idle parked chats until a slot is free so one busy turn + browsing others no longer false-trips `PROCESS_LIMIT`.
- **Background turns survive session switch**: demote treats open tools / deferred `prompt_complete` as busy (not park→reclaim); `soft_respawn` skips mid-turn; background tool journal + `agent_exit` markers; UI defers warm-connect while another chat is busy.
- **New chat no longer kills the live agent**: `newChat` stopped calling `sessionDisconnect` (that aborted in-flight turns and left empty sessions with only an agentSessionId). Disconnect now demotes/parks instead of killing mid-turn; send continues after UI switch.
- **Send queue session isolation**: flush only claims the *viewed* session key (no live-session fallback); enqueue only when *this* chat is busy (follow-ups). Host busy on another chat → concurrent demote+spawn (not a fake “本会话队列” on empty new chat).
- **Session-scoped Host commands (multi-session correctness)**: `session_send`, `session_stop`, `session_rewind_drop_last_user` and the permission / plan / ask-user resolvers now take the chat's `sessionId` instead of acting on “whatever holds the live slot”. A warm connect or sidebar switch landing between connect and send used to deliver the turn to a *different* chat (foreign replies, empty-journal zombie sessions); Host now re-focuses the target (background/parked → live) under the connect lock, or fails with `CONNECT_FAILED` so the UI reconnects and retries the same turn once.
- **Background approvals are answerable**: permission / `ask_user` requests raised by a demoted chat are kept per session and restored when you reopen it — previously they were toast-only and the background turn blocked until the agent gave up. Answers are routed to the requesting chat's own ACP child (the old code replied on the live slot's process, so the rpc id never matched). A waiting background chat also emits its own `session://runtime` instead of the focused snapshot.
- **Stop targets the chat on screen** rather than the live slot, so stopping a demoted turn no longer cancels an unrelated chat.
- **Truncated answers / “stuck” chats (silent stream loss)**: Host decided a turn was over from the FSM, but agents fire `prompt_complete` *early* and keep streaming for many more seconds. Everything after that point was dropped — the chat kept spinning while the agent finished normally, and the journal held a half-written answer with no error, no cancel marker and no `agent_exit`. Turn lifetime is now driven by `prompt_in_flight` (the `session/prompt` RPC, which is ordered after every chunk), not by the FSM: chunks arriving after an early `prompt_complete` re-open the turn instead of being discarded, and a chat with a live prompt can never be parked or idle-recycled.
- **Truncated answers, part two — the safety valve was the cause**: making turn lifetime follow `prompt_in_flight` was not enough, because a 3s timer armed by the early `prompt_complete` resolved the `session/prompt` RPC itself. That synthesised an *authoritative* completion while the agent was still streaming, so the turn closed and every later chunk was discarded as replay — same symptom as before (prefix-only journal, chat frozen mid-answer), now with the fix in place. The window is now **idle-based**: each inbound `session/update` re-arms it, so the waiter is released only after the agent actually goes quiet. `PROMPT_TIMEOUT_SECS` remains the backstop for a genuinely wedged RPC.
- **Event routing never fails silently**: ACP events whose process matches no live/background session are recovered (a still-streaming parked agent is moved back to `background`) or logged at `warn`, instead of `return`-ing into the void. A background chunk dropped after its turn closed now warns too — a background chat never replays, so that drop is always real output loss.
- **Turn errors are attributed to the right chat**: the `session/prompt` failure path wrote into the live slot, so a chat demoted mid-turn had its crash recorded against whichever chat had focus.
- **Reopening a background chat re-attaches its output**: the thread showed `idle` (looking finished) while the agent was still writing into it; it now resumes the streaming / awaiting-permission state from the live map.
- **One prompt per chat**: Host rejects a second `session/prompt` while one is in flight instead of dispatching into a busy agent.
- **Sending then opening a new chat no longer yanks you back**: every draft is `sessionId: null`, so an in-flight `sessionCreate` + `sessionConnect` compared `null === null`, decided the user was still on *its* draft, and stole the workbench the moment the agent started executing. Views now carry a navigation epoch (`viewFocus`), so async work only takes over the workbench if the user has not navigated since it started — this also stops it re-expanding the old project in the sidebar and painting optimistic bubbles onto an unrelated new draft.
- **“Agent process limit reached” with nothing running**: three separate causes. (1) Installs predating the multi-session rework had the *old* default pool size (**3**) persisted in `settings.json`, so raising the default to 8 never reached them — a one-time migration lifts a stored `3` to the current default and records that it ran, so a deliberate 3 still sticks. (2) A **successful** capacity reclaim (`idle_recycled reason=capacity`, i.e. Host freed an idle warm agent so the spawn could proceed) was toasted as “limit reached (all slots are busy turns)”, which was both alarming and false; it now reports what actually happened. (3) Finished `background` turns were only drained to `parked` on the events that end a turn, so a turn that ended any other way left its agent occupying a pool slot that **no reclaim path could ever free**; finished background turns are now swept to `parked` before any capacity decision and by the idle watchdog.
- **Turn timeline order**: reopening a chat could render your own prompt *after* the finished answer. `mergeSessionMessagesById` appended journal-only rows at the tail; they are now placed at their turn position (before the next row both sides share), and repeated `tool_step` ids are preserved. The cache that lost the prompt is fixed too — navigating away no longer overwrites a populated session cache with an empty workbench view.

### Community

- Merged phone mirror (#95 content), skins (#120), live voice workbench (#121), store quarantine notice (#122), and remaining settings/runtime community PRs.

**中文 · 新增**
- 手机镜像、远程 IM；设置分页与搜索；皮肤/壁纸/系统主题。
- 对话轮次与活动更清晰；上下文用量、查找、历史上翻、置顶、恢复上次会话、压缩备注、回退可恢复文件。
- 语音听写（官方登录/官方 Key 且当前为官方提供商时显示）；实时语音入口暂隐藏。
- 官方插件市场一键安装启用；Hooks/MCP 与更多 Agent 开关；Worktree、活动任务、trace 导出等。

**中文 · 修复**
- 主题色按钮、Plan 仅当前会话、中文标题与语言识别；第三方提供商与未配齐官方凭证时不展示语音听写；实时语音入口隐藏。
- 资源面板文件编辑器：正文区全高可编辑（修复约 2 行高度塌缩）；编辑 / 保存 / 还原从顶栏移到文件内页顶部工具栏。
- Markdown 文档改用 **TipTap** 所见即所得编辑（`tiptap-markdown` 回写），附格式工具栏。
- 顶栏数量角标（任务 / 变更 / 规则）不再漂到窗口右上角（`.chrome-btn` 作为定位上下文）。
- **多会话并行**：切换会话不再中断后台回合；Host 将忙会话 demote 到 background 而非 cancel；取消同 cwd 进程抢占；前端按 `sessionId` / `session://runtime` 继续消费 stream。
- **进程池**：默认并发 **8**（上限 **32**）；开新会话时优先回收闲置 parked，避免「只有 1 个在跑却提示达上限」。
- **后台回合可切换会话**：open tools / deferred complete 一律 demote 到 background（不 park 后被回收）；`soft_respawn` 跳过进行中回合；后台写 tool journal 与 `agent_exit` 标记；有其他忙会话时暂缓 warm-connect。
- **新建会话不再杀 Agent**：去掉 `newChat` 里的 `sessionDisconnect`（会中断刚发送的任务、留下空 journal）；disconnect 改为 demote/park；发送在切走 UI 后仍会完成。
- **发送队列按会话隔离**：flush 只认当前查看会话；仅本会话 busy 时入队后续消息。他会话 busy 时新建/切换发送会 demote+并行启动，不再在空「新会话」上出现假队列。
- **Host 指令按会话寻址（多会话打架根因）**：`session_send`、`session_stop`、`session_rewind_drop_last_user` 以及权限 / Plan / ask_user 的响应全部改为携带 `sessionId`，不再作用于「当前 live 槽」。此前 warm connect 或侧栏切换插在 connect 与 send 之间，会把这条消息投递到**另一个会话**（串台回复、只有 agentSessionId 的空 journal 僵尸会话）。现在 Host 会在 connect 锁内把目标会话重新聚焦（background/parked → live），拿不到进程则返回 `CONNECT_FAILED`，前端重连后重试同一条消息。
- **后台会话的权限可以回答了**：被 demote 的会话发起的权限 / `ask_user` 会按会话缓存，切回该会话时恢复；以前只有一个 toast，回到会话没有任何入口，后台回合会一直卡到 agent 放弃。响应也改为发往发起会话自己的 ACP 子进程（旧代码发给 live 槽，rpc id 对不上）。等待中的后台会话现在会发自己的 `session://runtime`，侧栏状态诚实。
- **停止作用于当前查看的会话**，不再误停另一个正在跑的会话。
- **回答被截断 / 会话「卡住」（输出被静默丢弃）**：Host 用 FSM 判断回合是否结束，但 agent 会**提前**发 `prompt_complete` 然后继续输出十几秒，这之后的内容全被丢掉——界面一直转圈，agent 其实早已正常跑完，journal 里留下半截答案，且没有报错、没有取消标记、没有 `agent_exit`。现在回合生命周期由 `prompt_in_flight`（`session/prompt` RPC，它排在所有 chunk 之后）决定，不再看 FSM：提前 `prompt_complete` 之后到达的 chunk 会重新打开回合而不是被丢弃；有 prompt 在飞的会话永远不会被 park 或闲置回收。
- **回答被截断（二）——兜底逻辑本身才是元凶**：把回合生命周期改成看 `prompt_in_flight` 还不够。提前到达的 `prompt_complete` 会挂起一个 **3 秒定时器**，到点直接替 agent 把 `session/prompt` RPC「结算」掉，于是合成出一个 **authoritative** 完成事件 —— agent 还在输出，回合却已经关闭，后续 chunk 全被当作 replay 丢弃，症状与修复前一模一样（journal 只剩前缀、界面卡在半句话）。现在这个窗口改为**空闲计时**：每收到一条 `session/update` 就重新计时，只有 agent 真正安静下来才释放等待者；真正卡死的 RPC 仍由 `PROMPT_TIMEOUT_SECS` 兜底。
- **事件路由不再静默失败**：进程对不上任何 live/background 会话的 ACP 事件，要么被救回（仍在输出却被 park 的 agent 移回 `background`），要么打 `warn` 日志，不再直接 `return` 吞掉。后台会话在回合关闭后被丢弃的 chunk 现在也会打 `warn` —— 后台会话不存在 replay，这种丢弃一定是真实的输出丢失。
- **回合错误归属正确的会话**：`session/prompt` 失败走的是 live 槽，导致中途被 demote 的会话把崩溃记到了当前聚焦的那个会话头上。
- **切回后台会话能接上输出**：原来会显示成 `idle`（看起来已完成），而 agent 还在往里写；现在会从 live map 恢复 streaming / 等待权限状态。
- **同一会话同时只允许一个 prompt**：Host 会拒绝在上一轮未结束时再次下发 `session/prompt`，不再把请求打进忙碌的 agent。
- **刚发送就去开新会话，不再被拉回原会话**：每个草稿的 `sessionId` 都是 `null`，in-flight 的 `sessionCreate` + `sessionConnect` 于是 `null === null`，认为用户还停在自己的草稿上，在 agent 刚开始执行时抢走工作区。现在视图带导航版本号（`viewFocus`），异步任务只有在用户未导航过时才接管工作区；顺带修掉它会重新展开旧项目侧栏、以及把乐观气泡画到无关新草稿上的问题。
- **明明没有会话在跑却提示「Agent 进程已达上限」**：三个独立成因。(1) 多会话改造之前安装的版本把**旧默认值 3** 写进了 `settings.json`，因此把默认值提到 8 对老用户完全无效 —— 现在会一次性把存量的 `3` 升到当前默认值并记录已迁移，之后用户自己设成 3 仍然有效。(2) **成功**的槽位回收（`idle_recycled reason=capacity`，即 Host 回收了一个闲置常驻 Agent 让本次启动得以继续）被误报成「已达上限（当前槽位均被正在执行的任务占用）」，既吓人又不属实，现在如实描述。(3) 已结束的 `background` 回合只在"回合结束事件"里才会转成 `parked`，若回合以其他方式收尾，其 agent 就永久占着槽位且**没有任何回收路径能释放它**；现在在做容量判断前和闲置巡检时都会把已完成的 background 会话清扫为 `parked`。
- **回合时间线顺序**：切回会话时，自己发的第一条消息可能被渲染到答案之后。`mergeSessionMessagesById` 原本把 journal 独有的行追加到末尾，现在按回合位置插入（放在双方共有的下一行之前），并保留重复的 `tool_step` id。缓存丢消息的成因也一并修掉：离开会话时不再用空的工作区视图覆盖已有内容的会话缓存。

## [0.1.7] - 2026-07-25

> **Highlight:** large community feature batch (worktrees, voice, Extensions, Runtime toggles) plus hard stability repairs so `tsc` / `cargo test` / CI install stay green after multi-PR landing.

### Added

- **App update check** (#58): Settings → About checks GitHub Releases for newer installers.
- **Active agent tasks panel** (#59): right pane shows live tool tasks from the current stream.
- **Session content search** (#60): command palette / search matches journal message text, not only titles.
- **Plugin install & update** (#61): Settings → Extensions can install/update plugins (not only enable/disable).
- **Sandbox profile** (#66): Settings → Runtime sandbox (`off` / `workspace` / `read-only` / `strict` / `devbox`) at agent spawn.
- **Pin sessions** (#73): pin chats to the top of the sidebar.
- **Project inspect** (#75): Settings → Runtime summary from `grok inspect --json` (secret-safe).
- **CLI doctor in App Doctor** (#76): merge `grok doctor --json` findings into the Doctor modal.
- **CLI update check** (#63): Runtime / Doctor can run `grok update --check --json` and install via `grok update`.
- **Git worktree create / remove / gc** (#64, #74, #83): project chip creates sibling worktrees, removes non-main trees (force optional), dry-run prune then `git worktree prune`.
- **Composer voice dictation** (#89): mic capture → xAI STT; official login / API key only; in-app errors (no `window.alert`).
- **Find in chat** (#72): Cmd/Ctrl+F in the current conversation.
- **Reopen last chat on startup** (#71): restore last session once after launch (Settings toggle; default on).
- **Spawn toggles**: experimental memory (#67), max agent turns (#69), disable web search (#70), plan mode (#80), subagents (#81), preferred agent (#85), optional leader mode (#87).
- **Extensions depth**: MCP add/remove/doctor (#68), hooks (#78), agents/personas list (#77), plugin marketplace sources (#86).
- **Managed setup** (#79): Settings → Runtime `grok setup` preview/install with soft-respawn.
- **Permission rules editor** (#84): allow / deny / ask patterns in agent `config.toml`.
- **Project rules entry** (#82): first-class AGENTS.md / `.grok` rules surface in the resource pane.
- **Keyboard shortcuts panel** (#91): Settings → Shortcuts (read-only catalog).
- **Doctor remediations** (#88): apply CLI doctor automatic fixes from App Doctor when available.

### Fixed

- **Session data mode switch** (#62): independent↔shared recycles live/background/parked agents so none keep the old `GROK_HOME`.
- **Missing project folder** (#65): pathOk UX to relocate deleted/moved project directories.
- **Post-merge stability**: repair union-merge damage (Rust brace/tests, duplicate modules, truncated `useState` / JSX / CSS, deduped imports, bogus `pnpm-workspace.yaml`); `tsc` + `cargo test --lib` + frontend unit tests green again.
- **Git worktrees UI**: hide for non-git folders; soft refresh without flicker; compact rows.
- **Release notes**: slim GitHub Release body (CHANGELOG section only).

### Community

- Integrated community PRs through the post-0.1.6 batch (sonnemusk and others), including worktrees, voice, Extensions, and Runtime spawn flags.
- Superseded follow-up compile fix PR #92 after equivalent CI repairs landed on `main`.

**中文 · 新增**
- 应用更新检查、活动任务、会话正文搜索、插件安装更新、沙箱、置顶、inspect、CLI Doctor/更新。
- Worktree 新建/删除/清理；Composer 语音听写；会话内查找；启动恢复上次会话。
- Memory / max turns / 禁联网 / plan / subagents / preferred agent / leader 等 spawn 开关。
- MCP 增删与 doctor、hooks、agents 列表、marketplace、managed setup、权限规则、项目规则入口、快捷键面板、Doctor 自动修复。

**中文 · 修复**
- 会话模式切换回收 Agent；缺失项目目录可重定位。
- 大批量 PR 合并后的编译/类型/测试/安装链路修复；worktree UI 与发版日志精简。

## [0.1.6] - 2026-07-24

> **Highlight:** early-turn fix (#52), multi-session stream, shared-mode CLI import, store write locks.

### Added

- **Import CLI sessions (shared mode)** (#57): Settings → General lists `~/.grok/sessions`; import one / all into App journals.
- **Session diagnostic export**: session menu → redacted zip (messages, runtime, CLI probe, logs, agent trail) for bug reports (#52).
- **Multi-session background stream** (#56): switching chats keeps busy turns streaming under the process cap.
- **A11y** (#53): conversation live region; permission / modal focus trap + Escape; ask_user `aria-pressed`.

### Fixed

- **Premature turn end** (#54 / #52): defer `prompt_complete` while tools, permission, plan, or ask_user are still open.
- **Orphan chat cwd**: no-project agents use `$HOME` instead of Dock `cwd=/` (#52).
- **Empty-run soft signal**: toast when a non-ask turn ends with zero tool calls (#52).
- **Store JSON write lock** (#55): exclusive lock + atomic rename; quarantine corrupt store files.
- **Git worktrees UI**: hide section for non-git folders; stop loading flicker; compact single-line rows.

### Community

- PRs **#53–#57** (sonnemusk). Closed #42 (worktrees), #52 (early end_turn).

**中文**
- 新增：CLI 会话导入（shared）、诊断包、后台多会话流式、无障碍。  
- 修复：工具/权限未完不提前就绪；无项目 cwd=`$HOME`；store 写锁；worktree 非 git 隐藏与紧凑行。

## [0.1.5] - 2026-07-24

> 中英文对照 / Bilingual notes.
>
> **Highlight:** Git worktree switch, per-project permission tiers, resource-pane text edit, clipboard image paste, structured error deck.

### Added

- **Git worktree switch** (#46): project chip lists `git worktree` siblings and rebinds session cwd (reuse / add project, trust inherited when possible).
- **Per-project permission default** (#47): trusted projects pin Ask / Accept edits / session / Deny / Full access; untrusted always forces Ask; cascade session → project → app.
- **Resource pane text edit** (#50): edit/save text·code·markdown with dirty state, ⌘/Ctrl+S, mtime conflict (reload vs overwrite), discard on close.
- **Structured error deck** (#51): CLI / auth / network / crash (+ quota, connect, process limit, timeout) cards with problem · cause · primary · secondary actions (Doctor / Account / Providers / Reconnect).

### Fixed

- **Composer image paste** (#48): WebView screenshot paste via event Files → Clipboard API → native OS clipboard (arboard → attachments/paste PNG); attach toast + clear errors.

### Community

- Integrated community PRs **#46–#48**, **#50–#51** (sonnemusk).
- README features + contributors list refreshed for shipped community work.

**中文 · 新增**
- Git worktree 从项目 chip 切换；可信项目默认权限阶梯；资源面板文本就地编辑保存；结构化错误卡（问题/原因/主次操作）。

**中文 · 修复**
- 粘贴截图/剪贴板图片可正确挂附件（含 macOS 系统剪贴板回退）。

**中文 · 文档**
- README 功能表与贡献者名单同步已合并社区能力。

## [0.1.4] - 2026-07-24

> 中英文对照 / Bilingual notes.
>
> **Highlight:** Plan review in the resource pane, top-only progress bar, opt-in keychain, custom-provider account usage.

### Security

- **Keychain opt-in on cold start** (#44): default keeps API keys in `secrets.json` (0600); OS keychain is Settings → General opt-in so app launch no longer prompts for Keychain unlock. Existing installs that already used keychain keep that mode.

### Added

- **Plan resource review** (#45): full plan Markdown + steps in the right **Resources → Plan** workbench; top sticky bar shows execution progress only (`n/m`, current step, meter); 「在资源中打开」/ review-gate auto-open; expand steps on demand; no plan card in the chat transcript.
- **Sticky Plan/Goal status bar** (L04, #41): progress + review actions above the chat stage.

### Fixed

- **macOS titlebar**: traffic-light safe inset so the sidebar panel toggle no longer underlaps red/yellow/green.
- **Composer placeholder**: hide overlay as soon as the DOM has typed/IME glyphs.
- **Chat scroll flicker**: ignore sub-4px content height noise while stick-to-bottom follows.
- **Custom provider account UI** (#43): sidebar shows active custom provider name/model and local usage instead of official OAuth identity when a custom route is active; hide official quota/login actions for that route.
- **Plan dismiss**: soft-hide top progress bar during execution without wiping plan state; review-gate dismiss still abandons the RPC.
- **Dead copy**: remove obsolete `composer.attachLater`.

### Community

- Integrated **#41**, **#43–#45** (plan UX, keychain startup, custom provider usage).

**中文 · 安全**
- 钥匙串改为设置里可选；默认仍用 `secrets.json`，避免冷启动弹系统密码框。

**中文 · 新增**
- 计划：顶部只显示执行进度；完整正文在资源面板 Markdown 审阅（批准/请求修改）；步骤按需展开。
- Plan/Goal 状态条（L04）。

**中文 · 修复**
- mac 交通灯与侧栏按钮重叠；输入框 placeholder 遮字；长对话滚动闪动；自定义中转时账户区与本地用量展示。

## [0.1.3] - 2026-07-24

> 中英文对照 / Bilingual notes.
>
> **Highlight:** OS keychain secrets, stream-stall cancel, MCP/Plugins enable, composer send queue, session switch fix.

### Security

- **API keys in OS keychain** (C07): `officialApiKey` / `relayApiKey` prefer macOS Keychain, Windows Credential Manager, or Linux Secret Service via `keyring`, with `secrets.json` (0600) fallback and one-time plaintext migration — community PR #34.

### Added

- **Composer follow-up send queue**: while the agent is busy, queue messages for the current session; auto-flush after the turn if you stay on that chat — community PR #40.
- **Stream stall cancel (I06)**: host watchdog emits `session://stream_stall` after pure silence (default 120s, Settings → Runtime); banner with Cancel turn / Keep waiting; tool events count as progress — community PR #37.
- **Journal write throttle (I04)**: mid-stream assistant journal flushes ≥500ms or on paragraph / turn end / stop / disconnect — community PR #37.
- **Changes panel — Workspace git status**: Session (agent tool edits) + Workspace (`git status`) sections; click for unified diff; refresh / open in editor / reveal / copy path — community PR #36.
- **Sidebar session list virtualization** (F07): windowed rendering for large project/orphan session groups (100+ rows); short lists unchanged — community PR #32.
- **Plugins manager** (L03): Settings → Extensions list / enable / disable / details / uninstall via `grok plugin` — community PR #39.
- **MCP enable + inject** (L03): Settings → Extensions toggles; enabled servers inject into ACP `session/new|load` and agent-home config — community PR #38.
- **ACP golden fixtures** (T06): offline protocol regression suite for wire shapes / mock stream / permissions — community PR #33.

### Fixed

- **Session switch re-stream**: switching historical sessions no longer re-types the whole assistant transcript as a live stream (Host FSM gate + frontend defense) — community PR #35.
- **Windows portable zip**: CI package finds product `Grok.exe` correctly.

### Community

- Integrated community PRs **#32–#40** (sonnemusk, shiaho777, tisrop).

**中文 · 安全**
- API 密钥优先写入系统钥匙串（Keychain / Credential Manager / Secret Service），失败时回退 `secrets.json`（0600），并支持一次性明文迁移。

**中文 · 新增**
- 忙时后续消息队列（当前会话自动发送）；流式卡顿取消提示 + 日志落盘节流；Changes 工作区 git 状态；侧栏会话虚拟列表；扩展页 Plugins 管理与 MCP 启用注入；ACP 协议 golden 回归。

**中文 · 修复**
- 切换历史会话不再整段重播流式回复；Windows 绿色版打包路径修正。

## [0.1.2] - 2026-07-24

> 中英文对照 / Bilingual notes.
>
> **Highlight:** session Changes/diff, fork & rewind, agent process limits, ask-user questionnaire.

### Added

- **Session Changes panel** (resource pane Files | Changes): track agent write/edit tools, unified diff from tool snippets or optional `git_file_diff` — community PR #28.
- **Session fork & rewind timeline**: fork full/partial history; rewind to a user prompt (local journal + best-effort agent) — community PR #29.
- **Agent process limits**: max concurrent warm agents (default 3) + idle recycle minutes (default 30); Settings → Runtime; `PROCESS_LIMIT` toast — community PR #30.
- **Ask user questionnaire**: in-app UI for `_x.ai/ask_user_question` (single/multi/free-text) instead of always cancelling — community PR #31.

### Community

- Integrated and closed community PRs **#28–#31**.

**中文 · 新增**
- 会话 Changes/diff 面板；会话分叉与回退时间线；并发 Agent 上限与闲置回收；Agent 问卷（ask_user）应用内作答。

## [0.1.1] - 2026-07-24

> 中英文对照 / Bilingual notes.
>
> **Highlight:** multi-account, Doctor support tools, context usage chip, Extensions (Skills/MCP), OAuth browser open, Windows 绿色版 + Linux deb/rpm.

### Added

- **Multi-account manager** (Settings → Account): compact hero, modal switcher, **Add account** = save current then OAuth; import/export account snapshots.
- **Doctor**: redacted support zip export; safe app-data reset (double in-app confirm; optional keep keys/accounts).
- **CLI install hardening**: HTTPS allowlist, streaming SHA-256, fail on published checksum mismatch.
- **Workbench UX**: session Markdown export; palette search by project path; connection status pill; keyboard shortcuts panel; optional desktop notifications for permission waits / finished turns.
- **Context usage chip** (composer): known tokens after compact, honest `~` estimate from visible chat, Compact… menu — community PR #25.
- **Settings → Extensions**: Skills + MCP inspect lists, project-scoped refresh, reveal paths, `/mcp` → Manage in Settings — community PR #27.
- **ACP connection test**: TCP + initialize probe and server setup one-liner in Runtime settings — community PR #23.
- Composer **file picker** (+ menu → Files / Folder) and **clipboard paste** for images/files.
- Open-source **maintenance playbook** (`docs/llm-wiki/maintain.md`).
- **Single-instance** plugin: second launch focuses the existing window.
- Thinking/reasoning **auto-collapse when done** (default); remembers expand/collapse choice.
- Error codes **QUOTA_EXCEEDED** / **CONNECT_FAILED** with clearer user-facing copy.
- **Import conversation** from markdown/JSON into a local session.
- **Linux x64** packages: AppImage + **.deb** + **.rpm** in release CI.
- **Windows x64 绿色版**: `Grok_*_x64-portable.zip` (unzip and run) alongside NSIS setup.
- **Traditional Chinese (zh-TW)** UI locale — community PR #18.
- **ACP API mode**: optional TCP remote ACP server (`host:port`) — community PR #20.

### Fixed

- **OAuth / device login**: open the authorize URL as soon as the CLI prints it (stream stdout); previously stuck on “Working…” with no browser — community PR #26.
- **Settings i18n**: Settings page uses full `createT` catalog (no raw keys / partial labels whitelist).
- **Settings → Session data mode** and **Add project trust**: replace `window.confirm` with in-app dialogs (Fixes #19).
- **Plan card**: keep `exit_plan_mode` `rpcId` so Approve / Request changes stay clickable (Fixes #17).
- **Plan mode**: handle `_x.ai/exit_plan_mode` + wire Plan card buttons.
- **Thinking UI**: multi-phase reasoning blocks; thought chunks bind to current assistant message.
- **Session ↔ project rebind** via composer project chip menu.
- Shell permission fallbacks use **underscore** optionIds — community PR #2.
- Session auto-title prompt follows **app locale** (incl. zh-TW) — community PR #1 / follow-ups.
- Composer stays **draftable while streaming**.
- macOS titlebar traffic-light inset / panel toggle drag.
- **Same-session history duplication** and stuck streaming flags.
- Login / connect error mapping (Access denied, quota, agent connect).

### Changed

- Release download table documents portable zip + Linux AppImage/deb/rpm.
- Bundle targets explicit: dmg / nsis / appimage / deb / rpm.

### Community

- Integrated and closed community PRs **#23–#27** (ACP probe, Doctor/workbench, context chip, OAuth browser, Extensions).
- Issues #3–#13 from launch-thread feedback; #17 / #19 fixed on main.
- PR #18 (zh-TW), PR #20 (ACP TCP) already on main.

**中文 · 新增**
- 多账号管理、Doctor 支持包/重置、CLI 安装校验、会话导出与连接状态、快捷键与桌面通知。
- 上下文用量芯片、设置 → 扩展（Skills/MCP）、ACP 连通测试。
- Windows **绿色版 zip**；Linux **AppImage / deb / rpm**。
- 多账号、导入对话、单实例、思考自动折叠、zh-TW、ACP API 模式等。

**中文 · 修复**
- 登录 OAuth/设备码时立即打开浏览器授权页（不再卡在 Working…）。
- 设置页 i18n 裸 key；`window.confirm` 替换；计划卡 RPC；历史重复与登录/连接错误提示等。

**中文 · 变更**
- 发布资源表与打包目标覆盖绿色版与 Linux 三件套。

## [0.1.0] - 2026-07-24

> 中英文对照 / Bilingual notes. English first (Keep a Changelog), then 中文摘要 under each section.
>
> **Highlight:** first public release — Grok Build desktop workbench, open-source packaging for macOS ARM / Intel + Windows.

### Added

- **Desktop workbench** for Grok Build (`grok agent stdio` ACP): projects, multi-session sidebar, streaming chat, live tool activity line, permission bar (Ask / allow once / session / YOLO).
- **First-run setup wizard**: multi-mirror CLI install, optional official account / API key / custom relay; CLI is a hard gate, account is skippable.
- **Account UI**: login surface, SuperGrok quota + usage heatmap, membership-oriented status.
- **Custom providers**: independent agent home (`GROK_HOME` / `agent-home`) so relays do not have to pollute `~/.grok`.
- **Rich media & files**: image / video / PDF / Office / code previews; path cards with smart open (ellipsis / sibling KB paths); resource pane + embedded multi-webview browser.
- **Automations (“已安排”)**: task list + silent create-from-chat (`grok-automation` fence stripped from bubbles); shell polling without blocking the main conversation.
- **i18n**: EN / 中文 UI via `src/i18n/`; tray menu follows locale.
- **In-app glass dialogs**: product UX never uses `window.confirm` / `prompt` / `alert`.
- **Packaging & open source**
  - GitHub Actions release matrix: macOS ARM64, macOS Intel, Windows x64.
  - Local cross-build: `cargo-xwin` + NSIS on macOS (`pnpm build:win`).
  - CHANGELOG-driven Release body (`scripts/changelog-for-release.py`) including macOS Gatekeeper / “damaged app” steps.
  - MIT license, bilingual README, CONTRIBUTING / SECURITY / CoC, issue & PR templates.

### Fixed

- Chat image cards: synchronous path resolve + cache to avoid zero-height flash / scroll jump while browsing history.
- Path open: strip agent `.../` ellipsis truncation; resolve files under project sibling folders (shared knowledge-base layout).
- Tauri feature allowlist: keep `macos-private-api` aligned for Windows cross-builds via cargo-xwin.
- Automation connect failures: do not leave empty “ghost” sessions in the sidebar.

### Changed

- Session continuity UX: single plain-text running tool line (not multi-row tool stack).
- Release process documented for AI maintainers: `docs/llm-wiki/release.md` + `docs/BUILD.md`.

### Notes

- **Not an official xAI product.** Real agents need a working [Grok Build](https://x.ai) CLI on the machine.
- macOS downloads are **unsigned / not notarized** — use `xattr -cr /Applications/Grok.app` if Gatekeeper blocks (see Release install notes).

**中文 · 新增**

- **Grok Build 桌面指挥台**：项目 / 多会话 / 流式对话 / 工具活动行 / 权限条（Ask · YOLO）。
- **首次向导**：CLI 多镜像安装（硬门禁）；账号 / Key / 中转可跳过。
- **账号与额度**、自定义中转（独立 `GROK_HOME`）、富媒体与资源预览、已安排自动化（对话静默创建，气泡不露 JSON）。
- **中英 UI + 托盘**、应用内毛玻璃弹窗（禁用系统 confirm/prompt/alert）。
- **开源与打包**：Actions 三端；本机 cargo-xwin 打 Windows；CHANGELOG 驱动 Release（含 macOS「已损坏」处理）；MIT 与双语 README。

**中文 · 修复**

- 聊天图片同步解析防滚动跳动；路径省略号 / 旁路知识库打开；Windows 交叉编译 private-api 白名单；自动化连接失败不留空壳会话。

**中文 · 变更**

- 工具活动改为单行纯文本；发版流程写入 `docs/llm-wiki/release.md` 供后续 AI 接手。

**中文 · 说明**

- **非 xAI 官方**；真 Agent 需本机 Grok Build CLI。macOS 未公证，遇 Gatekeeper 用 `xattr -cr`。
