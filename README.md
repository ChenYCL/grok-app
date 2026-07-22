# Grok App

本机 **Grok Build** 的桌面指挥台（Tauri 2 + React + TypeScript）。

> **MIT · 非 xAI 官方** · 姐妹项目 [grok-go](../grok-go)（只读导入配置，不内嵌网关 UI）

## 启动

```bash
pnpm install
pnpm dev          # Tauri + Vite（推荐）
pnpm test
cd src-tauri && cargo test
```

可选：`GROK_APP_ACP=mock pnpm dev` 仅用于无 CLI 的 CI/联调。**默认走真 `grok agent stdio`。**

## 首次打开（暖路径）

1. `pnpm dev` 启动（默认真 `grok agent stdio`，需本机有 `grok`）
2. 顶栏 Setup 应显示 **CLI ✓**（自动探测 `~/.grok/bin/grok` 或 PATH）
3. 若已 `grok` 登录：Setup **Auth ✓**（读取 `~/.grok/auth.json`）；否则打开 Onboarding 三选一
4. 点 **添加项目** → 系统文件夹选择器 → 确认信任
5. 点 **连接 Agent** → 状态变为 Ready 后发消息
6. 权限条默认 **Ask**；Allow once / Allow for session / Deny

## 与参考图

对照 `docs/参考图.png`：左栏导航形态、Recents、Chat 中栏、Plan 卡、底栏 chips、极深暗色。  
**政策差异：** 底栏默认 **Ask**，不是 Always approve。说明见 `docs/验收/visual-diff.md`。

## 架构要点

- Host 独占会话 FSM；UI 只投影事件
- 默认 ACP：`grok agent stdio` JSON-RPC（见 `docs/SPIKE-ACP.md`）
- 独立会话数据：`~/.grok-app`（`GROK_APP_HOME` 可覆盖）
- 密钥：本地 secrets 文件 0600 + redact；不写回 grok-go

## 验收

- `docs/验收/matrix-progress.md`
- `docs/验收/visual-diff.md`
- `docs/SPIKE-ACP.md`
