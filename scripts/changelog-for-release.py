#!/usr/bin/env python3
"""Extract a version section from CHANGELOG.md for GitHub Release body.

Usage:
  python3 scripts/changelog-for-release.py 0.1.0
  python3 scripts/changelog-for-release.py v0.1.0

Output: Markdown to stdout:
  - title
  - downloads table
  - CHANGELOG section for that version (update list)
  - install notes (macOS Gatekeeper / damaged app + Windows + CLI)

Exit 1 if the version section is missing (fail the release job intentionally).

Maintainer rule (AI): edit INSTALL_NOTES / ASSETS_TABLE here for all future
releases; do not hand-edit a single GitHub Release body.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHANGELOG = ROOT / "CHANGELOG.md"

ASSETS_TABLE = """## Downloads / 下载

| Platform / 平台 | File (typical) / 文件 |
|-----------------|------------------------|
| macOS Apple Silicon | `Grok_*_aarch64.dmg` |
| macOS Intel | `Grok_*_x64.dmg` |
| Windows x64 | `Grok_*_x64-setup.exe` |

Product name in installers is **Grok**. 安装包产品名为 **Grok**。
"""

INSTALL_NOTES = """
---

## Install notes / 安装说明

### macOS — “App is damaged” / 提示已损坏、无法打开

Release builds are **not Apple-notarized** (unsigned). Gatekeeper may block the app after download. This is **expected**.

未做 Apple 公证时，下载后可能提示「已损坏」「无法验证开发者」等，**属预期**。

**Recommended / 推荐：**

```bash
# After dragging Grok.app into Applications / 拖到「应用程序」后
xattr -cr /Applications/Grok.app
open /Applications/Grok.app
```

**Also works / 其他方式：**

1. Finder: **right-click** the app → **Open** → confirm again  
   （右键 App → **打开** → 再次确认）
2. **System Settings → Privacy & Security** → **Open Anyway**  
   （**系统设置 → 隐私与安全性** → **仍要打开**）

Only download from this repo’s official Releases.

### Windows

- SmartScreen may warn until code signing is configured → **More info** → **Run anyway**.  
  SmartScreen 可能提示未知发布者 → **更多信息** → **仍要运行**。
- Needs **WebView2** (usually preinstalled on Windows 10/11).

### Grok Build CLI

Real agent sessions need a local **Grok Build** CLI (`grok` / `grok.exe`) installed and signed in.  
真 Agent 能力依赖本机已安装并可登录的 Grok Build CLI。

### Changelog source

Full history: [`CHANGELOG.md`](https://github.com/RongleCat/grok-app/blob/main/CHANGELOG.md)
"""


def normalize_version(raw: str) -> str:
    v = raw.strip()
    if v.startswith("v") or v.startswith("V"):
        v = v[1:]
    return v


def extract_section(text: str, version: str) -> str | None:
    """Return body under ## [version] ... until next ## [ or EOF."""
    # Allow optional date suffix: ## [0.1.0] - 2026-07-24
    pat = re.compile(
        rf"^## \[{re.escape(version)}\][^\n]*\n(.*?)(?=^## \[|\Z)",
        re.MULTILINE | re.DOTALL,
    )
    m = pat.search(text)
    if not m:
        return None
    body = m.group(1).strip()
    return body


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: changelog-for-release.py <semver|vX.Y.Z>", file=sys.stderr)
        return 2
    version = normalize_version(sys.argv[1])
    if not CHANGELOG.is_file():
        print(f"error: missing {CHANGELOG}", file=sys.stderr)
        return 1
    text = CHANGELOG.read_text(encoding="utf-8")
    section = extract_section(text, version)
    if not section:
        print(
            f"error: no CHANGELOG section for [{version}]. "
            f"Add `## [{version}] - YYYY-MM-DD` before tagging.",
            file=sys.stderr,
        )
        return 1

    header = f"# Grok App v{version}\n\n"
    out = (
        header
        + ASSETS_TABLE
        + "\n"
        + f"## What's new / 更新内容 — v{version}\n\n"
        + section
        + "\n"
        + INSTALL_NOTES
    )
    if not out.endswith("\n"):
        out += "\n"
    # Windows CI defaults to cp1252; bilingual CHANGELOG needs UTF-8.
    try:
        sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    except Exception:
        pass
    try:
        sys.stdout.write(out)
    except UnicodeEncodeError:
        sys.stdout.buffer.write(out.encode("utf-8"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
