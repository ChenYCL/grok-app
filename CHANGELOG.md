# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-07-23

> 中英文对照 / Bilingual notes. English first (Keep a Changelog), then 中文摘要 under each section.
>
> **Highlight:** first open-source-ready desktop workbench for **Grok Build** CLI — sessions, media previews, automations, account UI, and multi-platform packaging.

### Added

- **Desktop workbench** for Grok Build (`grok agent stdio` ACP): projects, sessions, streaming chat, tool activity line, permission bar (Ask / session approve / YOLO).
- **First-run setup wizard**: CLI install (multi-mirror), optional account / API key / custom relay; hard-gate on CLI presence.
- **Account panel**: official login surface, SuperGrok quota + heatmap, usage-oriented status.
- **Custom providers**: independent agent home (`GROK_HOME`) so relays stay out of the default `~/.grok` profile when desired.
- **Rich media & files**: image / video / office / PDF / code previews, path cards, resource pane with embedded browser (multi-webview).
- **Automations**: scheduled tasks list + silent create-from-chat (`grok-automation` fence); shell polling without blocking the main conversation.
- **i18n**: English / 中文 UI strings via `src/i18n/`; tray menu localization.
- **In-app glass dialogs**: no `window.confirm` / `prompt` / `alert` for product UX.
- **Packaging**: GitHub Actions release for macOS ARM64, macOS Intel, Windows x64; local build scripts aligned with sister project GrokGo.

### Notes

- **Not an official xAI product.** Requires a working [Grok Build](https://x.ai) CLI on the machine for real agent sessions.
- Sister project: [GrokGo](https://github.com/RongleCat/grok-go) (local gateway for Codex / OpenAI-compatible clients) — Grok App can import config but does not embed the gateway UI.

**中文 · 新增**

- **Grok Build 桌面指挥台**：项目 / 会话 / 流式对话 / 工具行 / 权限条。
- **首次向导**：CLI 安装（多镜像）、账户可跳过；CLI 为硬门禁。
- **账号与额度**、自定义中转（独立 `GROK_HOME`）、富媒体与资源预览、已安排自动化（含对话静默创建）。
- **中英 UI**、托盘文案、应用内毛玻璃弹窗。
- **打包发布**：macOS ARM / Intel + Windows CI；与 GrokGo 对齐的发版脚本。

**中文 · 说明**

- **非 xAI 官方**；真 Agent 需本机 Grok Build CLI。姐妹项目 [GrokGo](https://github.com/RongleCat/grok-go)。
