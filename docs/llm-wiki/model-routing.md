# 官方工具注入（仅自定义主模型）

## 原则

| 主路由 | 行为 |
|--------|------|
| **官方 Grok 订阅**（`active_source == official`） | **严禁** 注入 MCP `official-aux`、Host 识图预跑、侧信道 session rules。使用 Grok Build **默认原生** vision / `x_*` / `web_search`，避免双轨污染。 |
| **自定义 / 第三方**（DeepSeek、中转等） | 开关开启且官方凭证可用时，注入 **可调用** MCP `official-aux`；附图且主模型纯文本时 Host 识图预跑。 |

X / web **不做 Host 关键词预跑**；由 agent 通过 tools 调用 `official-aux__x_*` / `web_search`。

## 产品入口

**设置 → 账户 → 自定义提供商** 顶部：

| 控件 | 行为 |
|------|------|
| **注入官方工具能力** | `AppSettings.official_aux_inject`（默认 **开**）；**仅 custom 主路由生效** |
| **同时加载扩展 MCP** | `official_aux_with_user_mcp`（默认 **关**）；关时 session 只注入 `official-aux`，避免 Playwright 等 30s 握手拖死工具就绪 |
| 有官方登录 / 官方 API Key | 可开关 |
| 无官方凭证 | **置灰**不可用 |

深链：`#/settings/account/providers` · anchor `settings-anchor-official-aux-inject`。

## 官方侧信道（custom only）

主会话与官方能力**进程 + GROK_HOME 隔离**：

| 路径 | `GROK_HOME` | 用途 |
|------|-------------|------|
| ACP `agent stdio` + custom main | `agent-home`（无 auth.json） | 写码 / 主 tool loop |
| **Official aux** MCP / ACP | **`agent-home-official`** | 主模型经 MCP 调 `x_*` / `web_search` / `vision_describe`；识图 Host 预跑走 ACP |

**Host 预跑（仅 custom + 纯文本主模型）：**

| 时机 | 行为 | UI |
|------|------|-----|
| 附图 `@/path` | 剥离像素 → 官方 ACP 识图 → 文字注入主 prompt | 一条 tool 轨「识别图片内容」 |
| X / web | **不** Host 预跑；agent 调 MCP tools | 原生 tool 轨 |

**MCP `official-aux` 工具：**

| 工具名 | 侧信道 |
|--------|--------|
| `web_search` | 官方隔离凭证 |
| `x_keyword_search` | 同上（X/推特/x上 **首选**） |
| `x_semantic_search` | 同上 |
| `x_user_search` | 同上 |
| `x_thread_fetch` | 同上 |
| `vision_describe` | 同上（Host 已注入描述时勿再调） |

脚本：`scripts/official-aux-mcp.mjs`（工具 description 含中英别名，便于 `search_tool` 命中）。Host：`src-tauri/src/official_aux.rs`。

门闸实现：`should_inject_mcp_for_main()` = inject 开 ∧ 凭证可用 ∧ **`active_route() == Custom`**。

**Solo inject 与 Claude MCP：**  
默认 `official_aux_with_user_mcp=false` 时，spawn 设置 `GROK_CLAUDE_MCPS_ENABLED=false` / `GROK_CURSOR_MCPS_ENABLED=false`，避免把 `~/.claude.json` 里的 Playwright 等并进会话、拖慢 30s 才结束 connecting（官方-aux 本身约 10ms 即可就绪）。

**绝不**在 custom 主路由把官方 `auth.json` 写回主 `agent-home`。

## 开关与生效

- 改 `official_aux_inject` / `official_aux_with_user_mcp` → `settings_set` soft-respawn。  
- 改完后建议**重连会话**。  
- 切回官方订阅：自动不注入，无需手关（门闸看路由）。

## 相关

- 自定义提供商：`docs/llm-wiki/providers.md`  
- X 证据轨（产品）：`docs/features/x-search.md`  
