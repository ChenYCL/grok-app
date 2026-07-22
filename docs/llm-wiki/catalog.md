# Grok Build 对齐：模型 / 推理 / 权限

源码：`src/lib/grokCatalog.ts`。

## 模型

以本机 `grok models` 为准。当前默认：

| ID | 说明 |
|----|------|
| `grok-4.5` | 默认（CLI default） |
| `grok-build` | 文档与 agent 配置中的经典别名，可选 |

更新方式：跑 `grok models`，改 `GROK_BUILD_MODELS`，并在本文件记一笔日期。

## 推理强度（effort）

对应 CLI `--reasoning-effort` / `--effort`：`high` | `medium` | `low`。

## 会话模式（mode）

桌面壳：`agent` | `plan` | `ask`。

## 权限（含 YOLO）— 对齐 Grok Build permission modes

| App ID | Grok Build 模式 | 含义 | CLI / 配置 |
|--------|-----------------|------|------------|
| `ask` | `default` | 默认询问 | 默认 |
| `accept_edits` | `acceptEdits` | 自动批准文件编辑类工具 | `defaultMode` |
| `allow_for_session` | （Host 会话缓存） | 本会话内允许已批 scope | session cache |
| `dont_ask` | `dontAsk` | 未预批则拒绝（不弹窗） | headless / 高安全 |
| `always_approve` | `bypassPermissions` | **YOLO 无限制** | `--always-approve` / yolo |

YOLO 必须在 UI 二次确认后才可启用（composer + 设置）。

Host：`PermissionPolicy`（`src-tauri/src/permission.rs`）。
