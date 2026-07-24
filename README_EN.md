<p align="center">
  <img src="assets/logo.png" alt="Grok App" width="128" height="128" />
</p>

<h1 align="center">Grok App</h1>

<p align="center"><strong>Desktop workbench for local Grok Build</strong></p>
<p align="center"><em>Sessions, projects, media, automations — for the real <code>grok</code> CLI</em></p>

<p align="center">
  <a href="./README.md">中文</a> ·
  <a href="./README_EN.md">English</a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
  <a href="https://github.com/RongleCat/grok-app/stargazers"><img src="https://img.shields.io/github/stars/RongleCat/grok-app?style=social" alt="GitHub stars" /></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey" alt="Platforms" />
  <img src="https://img.shields.io/badge/Tauri-2-orange" alt="Tauri 2" />
  <img src="https://img.shields.io/badge/note-unofficial-yellow" alt="Unofficial" />
</p>

<p align="center">
  <a href="https://x.com/cgnot996"><img src="https://img.shields.io/badge/X-铁柱AGI%20%40cgnot996-black?logo=x&logoColor=white" alt="X 铁柱AGI" /></a>
  <img src="https://img.shields.io/badge/WeChat-铁柱AGI-07C160?logo=wechat&logoColor=white" alt="WeChat 铁柱AGI" />
</p>

<p align="center">
  <strong>Follow the author</strong><br/>
  <a href="https://x.com/cgnot996"><strong>X / Twitter → 铁柱AGI @cgnot996</strong></a><br/>
  WeChat Official Account: search <strong>「铁柱AGI」</strong> (scan or WeChat Search below)
</p>

<p align="center">
  <img src="assets/wechat/mp-search-scan.png" alt="WeChat Search 铁柱AGI — scan to follow" width="480" />
</p>

<p align="center">
  Repo ·
  <a href="https://github.com/RongleCat/grok-app">RongleCat/grok-app</a>
</p>

---

> [!NOTE]
> ## Note
>
> **Grok App is not an official xAI product.** It wraps the local [Grok Build](https://x.ai) CLI (`grok agent stdio`) into a desktop workbench: sessions, projects, permissions, media previews, and scheduled tasks.
>
> Real agent power needs a working **Grok Build CLI** installed and signed in. Without CLI you can install from the first-run wizard, or use `GROK_APP_ACP=mock` for UI-only development.

---

## Contents

1. [Overview](#overview)
2. [Features](#features)
3. [Screenshots](#screenshots)
4. [Install & first run](#install--first-run)
5. [macOS “damaged” / Gatekeeper](#macos-damaged--gatekeeper)
6. [Config paths](#config-paths)
7. [Develop & build](#develop--build)
8. [Docs & contributing](#docs--contributing)
9. [Contributors](#contributors)
10. [Follow the author](#follow-the-author)

---

## Overview

The `grok` CLI is powerful in a terminal. Day-to-day work still needs multi-project sessions, a permission bar, rich previews, scheduled jobs, and bilingual UI.

**Grok App** is that workbench:

1. Install the app and prepare Grok Build CLI  
2. Add a project / new session  
3. Connect the agent; chat under Ask or YOLO  
4. Preview artifacts, schedule automations, manage account & relays in Settings  

**Stack:** Tauri 2 + Rust · React + TypeScript + Vite · Tailwind CSS

---

## Features

| Area | What you get |
|------|----------------|
| **Real Build sessions** | Default `grok agent stdio` (ACP); host-owned session FSM; optional remote ACP |
| **Projects & sessions** | Trusted dirs, virtualized sidebar, archive / orphan, fork & rewind |
| **Git worktrees** | Project chip lists linked worktrees; switch session cwd in one click |
| **Permissions** | Default Ask; allow once / session / deny; YOLO; **per-project** permission tier |
| **Plan / Goal** | Sticky execution progress; resource-pane Markdown review + steps; Goal entry |
| **Slash · Extensions** | Slash palette, Skills; Settings → Extensions for MCP / Plugins |
| **Composer** | Follow-up send queue while busy; paste screenshots; context usage chip |
| **Media & files** | Image / video / PDF / Office / code preview; **edit & save** text in Resources; Changes (session diffs + workspace git) |
| **Agent runtime** | Process limits & idle recycle; stall cancel; structured error deck (CLI / auth / network / crash) |
| **Automations** | Scheduled list; natural-language create-from-chat (silent fence, no JSON in UI) |
| **Account & quota** | Multi-account switcher, official login, SuperGrok quota + heatmap, custom-provider local usage |
| **Custom relays** | Independent `GROK_HOME` agent profile (keeps `~/.grok` clean when desired) |
| **Security** | Optional OS keychain for API keys (default `secrets.json` 0600); in-app confirms only |
| **i18n** | Simplified Chinese / Traditional Chinese / English + tray |
| **Packaging** | macOS ARM / Intel · Windows x64 (setup + portable) · Linux x64 (AppImage / deb / rpm) |

---

## Screenshots

> From the current macOS development build.

| Workbench · SuperGrok | Account & quota |
|:---:|:---:|
| ![Workbench](assets/screenshots/workbench.png) | ![Account](assets/screenshots/account.png) |

| Light theme | Session & media |
|:---:|:---:|
| ![Light](assets/screenshots/light.png) | ![Chat](assets/screenshots/chat.png) |

---

## Install & first run

### 1. Download

Get installers from [Releases](https://github.com/RongleCat/grok-app/releases):

| Platform | Artifact |
|----------|----------|
| macOS Apple Silicon | `Grok_*_aarch64.dmg` |
| macOS Intel | `Grok_*_x64.dmg` |
| Windows x64 | `*-setup.exe` installer + `*-portable.zip` |
| Linux x64 | AppImage / `.deb` / `.rpm` |

The bundle product name is **Grok** (matches the window title).

**Arch / Manjaro / EndeavourOS:** prefer the **AppImage** (`chmod +x` then run). Official CI does not publish a separate AUR package; AppImage is distro-agnostic.

### 2. First run

1. Launch → **Setup wizard** ensures CLI is installed (multi-mirror install supported)  
2. (Optional) Official login / API key / custom relay — skippable  
3. **Add project** → trust a folder  
4. **Connect agent** → chat when Ready  
5. Permission bar defaults to **Ask**; use YOLO only when you want unattended runs  

### 3. Requirements

- Local **Grok Build CLI** (`grok`), often `~/.grok/bin/grok` or on `PATH`  
- Windows: `%USERPROFILE%\.grok\bin\grok.exe` or `PATH`  

---

## macOS “damaged” / Gatekeeper

Release builds are **not Apple-notarized** (paid Developer ID required). Gatekeeper may block downloads — that is expected.

**Recommended:**

```bash
xattr -cr /Applications/Grok.app
open /Applications/Grok.app
```

**Also works:**

- Finder: **right-click** → **Open** → confirm  
- **System Settings → Privacy & Security** → **Open Anyway**  

Only download from this repo’s official [Releases](https://github.com/RongleCat/grok-app/releases).

---

## Config paths

Default data root (override with **`GROK_APP_HOME`**):

| Platform | Typical path |
|----------|----------------|
| macOS | `~/Library/Application Support/com.grokapp.grok-app/` |
| Windows | `%APPDATA%\grokapp\grok-app\` |
| Fallback | `~/.grok-app/` |

```text
<app-data>/
  projects.json
  sessions_index.json
  settings.json
  secrets.json          # metadata (+ API-key fallback); keys prefer OS keychain
  automations.json
  projects/
  sessions/
  logs/
  agent-home/           # independent-mode GROK_HOME
```

API keys prefer the OS secret store (macOS Keychain / Windows Credential Manager /
Linux Secret Service) with a `secrets.json` (mode `0600`) fallback when the OS store
is unavailable. Do not commit secrets.

Grok Build’s own config remains under **`~/.grok`** (CLI login, `auth.json`, …).  
**shared** session mode can use `~/.grok`; **independent** mode uses `agent-home/`.

---

## Develop & build

```bash
# Needs: Node 22+, pnpm 9, Rust stable, Xcode CLT (macOS)
pnpm install

pnpm dev                 # full app (real CLI by default)
pnpm dev:ui              # frontend only
GROK_APP_ACP=mock pnpm dev

pnpm typecheck && pnpm test
cd src-tauri && cargo test

pnpm build
```

Cross-compile and release notes: [docs/BUILD.md](./docs/BUILD.md).

Release (write the matching `CHANGELOG.md` section first):

```bash
./scripts/release-tag.sh 0.1.1
./scripts/release-tag.sh 0.1.1 --push
```

---

## Docs & contributing

| Audience | Link |
|----------|------|
| AI agents / product rules | [`docs/llm-wiki/`](./docs/llm-wiki/) |
| Build & release | [docs/BUILD.md](./docs/BUILD.md) |
| Changelog | [CHANGELOG.md](./CHANGELOG.md) |
| Contributing | [CONTRIBUTING.md](./CONTRIBUTING.md) |
| Code of conduct | [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md) |
| Security | [SECURITY.md](./SECURITY.md) |

Issues and PRs are welcome.

## Contributors

Thanks to everyone who has contributed to Grok App — community PRs and issues shape the product.

| Contributor | Highlights (selected) |
|-------------|------------------------|
| [sonnemusk](https://github.com/sonnemusk) | Session Changes / fork & rewind, MCP·Plugins, permission tiers, worktrees, resource edit, paste screenshots, error deck, and many more |
| [Sdefendre](https://github.com/Sdefendre) | Session titles follow locale; Grok Build permission optionIds |
| [jason920612](https://github.com/jason920612) | Remote ACP (API mode); Traditional Chinese locale |
| [shiaho777](https://github.com/shiaho777) | Cancelable login; stop re-streaming history on session switch |
| [2530185073](https://github.com/2530185073) | Custom provider account + local usage UI |
| [tisrop](https://github.com/tisrop) | Composer follow-up send queue while agent is busy |

Full graph:

[![Contributors](https://contrib.rocks/image?repo=RongleCat/grok-app)](https://github.com/RongleCat/grok-app/graphs/contributors)

## License

[MIT](./LICENSE) © RongleCat

---

## Follow the author

Updates, walkthroughs, and AI practice content land first on:

| Channel | Link |
|---------|------|
| **X / Twitter** | [铁柱AGI @cgnot996](https://x.com/cgnot996) ← highly recommended |
| **WeChat Official Account** | Search **「铁柱AGI」**, or scan / use the card below |

<p align="center">
  <img src="assets/wechat/mp-search-scan.png" alt="WeChat Search 铁柱AGI" width="420" />
</p>

<p align="center">
  If Grok App helps you, please star the repo and follow
  <a href="https://x.com/cgnot996"><strong>@cgnot996</strong></a> on X
  and the WeChat account <strong>铁柱AGI</strong> 🙏
</p>
