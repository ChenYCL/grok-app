# 自动化任务体系（设计）

**状态**：设计就绪 · **不阻塞**主对话 / 项目树 / i18n 等 P0。  
**原则**：能接 Build 就接 Build；壳层只做编排与展示。

## Grok Build 内置能力（调研）

来源：`~/.grok/docs/user-guide/20-background-tasks.md` 等。

| 能力 | 机制 | 说明 |
|------|------|------|
| 后台命令 | `run_terminal_command` + `background: true` | 长任务不阻塞会话 |
| 周期提示 | `/loop [interval] <prompt>` | 最小 60s，自动过期约 7 天 |
| 调度器 | `scheduler_create` / `list` / `delete` | 更底层的 recurring API |
| 监控 | `monitor` 工具 | 事件流；输出过大自动停 |
| 子 Agent | 子 agent / fleet | 并行探索与执行 |

**没有**独立的「Automations 产品实体 API」文档；桌面侧「自动化」宜映射到：

1. **会话内**：用户用自然语言描述 → Agent 用 `/loop` 或 `scheduler_create` 落地；  
2. **壳层清单**：Host 记录「名称 / 间隔 / prompt / 绑定项目 / 状态」，必要时再调 CLI/ACP。

## 推荐架构（分阶段）

### P1 — 描述驱动创建（不阻塞）

1. Composer「+」菜单项 **「创建自动化」**（文案 i18n）。  
2. 打开对话框：任务名、自然语言描述、建议间隔、绑定当前项目。  
3. 写入本地 `~/.grok-app/automations.json`（独立于 CLI）。  
4. 「启用」时：向当前/新会话发送结构化 prompt，指示 Agent 使用 `/loop` 或 scheduler；或 Host 直接调 CLI headless（若有稳定接口）。

### P2 — 与 Build 调度对齐

- 若 ACP/CLI 暴露 scheduler 列表：同步到壳层 UI。  
- 否则：壳层用本地定时器 + `grok agent headless` 触发（需包装与鉴权）。

### P3 — 完整自动化工作台

- 列表 / 启停 / 运行历史 / 失败告警。  
- 与侧栏「Automations」入口打通（现为 soon）。

## 与本应用的接法（当前）

- **不要**阻塞：会话占位、静默连接、i18n、权限 YOLO。  
- UI 可先放 **入口占位**（+ 面板项 disabled 或打开设计说明）。  
- 数据目录：`paths::automations_file()`（待实现）。  

## 验收（将来）

- 用户用中文描述「每 30 分钟检查测试是否绿」→ 壳层能存配置 → 启用后有可观察的周期行为。  
- 移除自动化不删用户项目磁盘文件。
