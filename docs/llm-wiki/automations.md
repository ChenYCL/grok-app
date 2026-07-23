# 自动化 / 已安排任务

**状态**：P1 UI + 本地存储已落地 · 应用打开时由壳层轮询触发。  
**原则**：能接 Build 就接 Build；壳层做清单、表单与编排。

## 产品入口（Codex 对标）

| 入口 | 行为 |
|------|------|
| 侧栏 logo 下 **新建会话** | 无项目归属的草稿会话 → 首次发送落入「其他会话」 |
| 侧栏 **已安排** | 主栏打开任务列表（`#/automations`） |
| 列表 **创建 → 用 AI 创建** | 切到无项目会话，预填引导 prompt |
| 列表 **创建 → 手动创建** | 右侧表单：标题 / 指令 / 项目 / 模型 / 推理 / 频率 / 时间 / 通知 |
| Composer「+」→ 创建自动化 | 跳转已安排页 |

## 数据

- 文件：`~/.grok-app/automations.json`（`paths::automations_file()`）
- 浏览器兜底：`localStorage["grok-app.automations"]`
- 字段：`title` `prompt` `enabled` `projectId` `modelId` `effort` `frequency` `time` `weekdays` `notify` `lastRunAt` `nextRunAt`

## 执行

1. 壳层每 30s 检查 `enabled` 且 `nextRunAt` 到期的任务（或懒算当次槽位）。
2. 不打断 `streaming` / 连接中会话。
3. 触发时：在绑定项目（或 orphan）下 `session_create` → `session_connect` → `session_send` prompt。
4. 写回 `lastRunAt` / `nextRunAt`；`once` 跑完后自动 `enabled=false`。

与 Build 的 `/loop`、`scheduler_*` 可并存：用户也可在会话里让 Agent 直接调度；壳层清单是独立 SoT。

## Tauri 命令

- `automations_list`
- `automation_create` / `automation_update`
- `automation_set_enabled`
- `automation_mark_run`
- `automation_delete`

## 验收

- [x] 侧栏新建会话不依赖当前项目，会话出现在「其他会话」
- [x] 已安排列表 / 筛选 / 搜索 / 启停 / 删除
- [x] 手动表单创建与编辑
- [x] AI 创建入口预填 composer
- [x] 应用打开时到期可触发（不阻塞主对话架构）
- [ ] 后台无窗口常驻触发（可选 P2：系统服务 / headless CLI）
- [ ] 与 CLI scheduler 双向同步（可选 P2）
