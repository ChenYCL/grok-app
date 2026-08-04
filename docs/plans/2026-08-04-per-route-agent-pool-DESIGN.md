# Goal — 单进程多会话池（per-route agent process pooling）

> **状态：DESIGN（未实现）** — 需要独立测试周期，不与本期稳定性改动同批落地。
> 关联：`docs/plans/2026-08-04-session-stability-tools-ux.md`（本期已落地项）。

## 为什么是设计而非实现

把 "每个 App 会话 = 一个 `grok agent stdio` 进程" 改为 "一个进程 = 多个会话" 需要
两个正确性关键改造：

1. **ACP 事件按 `sessionId` 路由**（`acp_client.rs decode_session_update` /
   `session_manager/events.rs handle_acp_event`）——多会话时一个进程上的流/工具/
   prompt_complete 事件必须精确落到所属 LiveSession。路由错位 = 数据串扰，这是
   稳定性红线。
2. **`AcpClient` 多会话状态机**（`agent_session_id` 单值 → 集合；`prompt_complete`
   回退按会话匹配；`State` 事件不互相覆盖）。

这两块都需要专门的测试周期（golden fixtures + 多会话并发测试）。本期为守住
"进一步提升稳定性"的目标，先落地全部低风险项，本设计留作后续工作包。

## 目标（Outcome）

- 会话切换从"冷 spawn + initialize + auth + session/new"变成"进程内 session/load"，
  冷连接从数秒 → <100ms。
- 中断恢复用 `session/load` 快速重建，而非整进程重建。
- 进程数从 N（每 App 会话 1 个）降到 per-route 1。

## 池边界（与切模型/切服务商的关系，已确认）

- **切模型**：不受影响。模型是会话级（`session/set_model` / `session/new` meta
  `modelId`），进程内可任意切，反而更快。
- **custom ↔ custom 切服务商**：同一 config.toml 内多个 `[model.<id>]` section，
  base_url/api_key 各自携带 → **同进程内支持**，无需分池。
- **official ↔ custom 切**：OIDC（auth.json）与 api_key（无 auth.json）不能共存于
  一个进程 → **池键 = `session_data_mode + route 大类（official | custom）`**，
  GROK_HOME 隔离（复用 `grok_home_override`，`official_aux.rs:400` 已用
  `agent-home-official`）。
- **shared 模式**（home 固定 `~/.grok`）：无法 per-route 隔离，退化为单进程池。

## 分期

### Phase A — 事件路由改造（前置，独立）
- `decode_session_update` 输出携带 `sessionId`；`handle_acp_event` 按 sid 分发。
- 单会话行为不变（回归测试：`acp_golden_test` / `routing_tests`）。

### Phase B — AcpClient 多会话状态机
- `agent_session_ids: Vec<String>`；`open_session` 追加而非覆盖。
- `prompt_complete` 回退按会话匹配；`set_model`/`set_mode`/`update_mcp_servers`
  保持按 sid 参数化（已具备）。
- 多会话并发 prompt 的 golden 测试。

### Phase C — SessionManager 池
- 连接时：同池键存在 warm 进程 → 其上 `session/load`（resume）或 `session/new`。
- 进程级健康监控 + 崩溃时按会话 `session/load` 重建。
- `prepare_route_auth_for_agent` 按目标池 home 写 auth（官方 OIDC 不污染 custom 池）。

## 验收

- 冷连 > 2 个 App 会话后，切换耗时 <100ms（无 spawn）。
- 双池（official + custom）并发会话各自正常。
- 进程崩溃后所有受影响会话 10s 内恢复（session/load）。
- `cargo test` + `acp_golden_test` 全绿；无事件串扰用例。
