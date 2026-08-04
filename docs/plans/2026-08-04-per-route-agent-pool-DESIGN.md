# 2026-08-04 — 单进程多会话池（per-route agent process reuse）

> **状态：IMPLEMENTED（保守版，本期已落地）**
> 已实现：① 事件按 `sessionId` 路由（防串扰安全网）；② parked 进程复用
> （同 route/policy/effort/sandbox 时新会话直接 session/load|new，免冷 spawn）。
> 未做：单进程**并发多会话宿主**（一个进程同时跑两个活跃 turn）——见「边界」。

## 已实现（本期）

### Phase A — 事件按 sessionId 路由（安全网）
- `acp_client.rs`：`event_tx` 改为 `(Option<String>, AcpEvent)`；
  `handle_session_update` 从通知 params 提取 `sessionId` 并随事件下发（CLI 网关
  每个 update 都带）。进程级事件（State/stderr/ProcessExited/Error）不带 sid。
- `session_manager/events.rs handle_acp_event`：事件带 sid 时严格路由到
  live/background/parked 中 `agent_session_id == sid` 的会话；不匹配即**丢弃**
  （复用进程上孤儿会话的残流永远不会写进别的 chat）。
- `official_aux.rs` 事件泵同步解包。

### Phase C — parked 进程复用（免冷 spawn）
- `ParkedAgent` 增加 `sandbox_profile`（进程级 spawn flag，来自 `AcpClient`）。
- `connect_inner`：冷 spawn 前查找可复用 parked 进程，复用门（纯函数
  `reuse_gate`）要求 **policy / effort / sandbox / route 大类（official|custom）**
  全部匹配；model 是会话级不参与门。
- 复用执行：在已有进程上 `open_session_at(cwd=新项目)` → session/load（恢复）或
  session/new，复用进程的 `process_id` 与事件泵保持，sid 路由防旧会话残流串扰。
- 失败安全：open_session 失败 → kill 旧进程 → 回退冷 spawn。

## 边界（未做 / 为什么）

- **单进程并发多会话宿主**（一个进程同时跑两个活跃 turn）不做：需要
  `AcpClient` 多会话状态机（`agent_session_id` 集合、prompt_complete 回退按会话
  匹配、pending prompt 按会话隔离），且 CLI 并发 prompt 的事件交织需要更严的
  golden 测试。收益边际小（App 是单焦点 UI），风险高（数据串扰红线）。
- 复用进程在**同一时刻只绑定一个活跃 App 会话**（live 或 background 其一）；
  被移交的旧会话在进程上成为孤儿 agent session，由 sid 路由丢弃其残流，进程
  空闲回收或下次该 App 会话重连 session/load 时自然收敛。

## 池边界（与切模型/切服务商的关系，已确认）

- **切模型**：不受影响。模型会话级（`session/set_model` / meta `modelId`），
  进程内可任意切。
- **custom ↔ custom 切服务商**：同一 config.toml 多 section，同进程支持。
- **official ↔ custom 切**：OIDC（auth.json）与 api_key 不能共存一个进程 →
  复用门按 route 大类隔离；换池 = 冷 spawn 一次（与本期前成本相同）。
- **shared 模式**（home 固定 `~/.grok`）：无法 per-route 隔离，复用门仍按
  route 大类限制（official 进程不供 custom 会话复用）。

## 验证

- `cargo test -- --test-threads=1` 989/989（含新 `reuse_gate` 单测）。
- 事件流类型改造已过 `acp_golden_test`（handshake fixture 同步更新）。
