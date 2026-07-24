#!/usr/bin/env bash
# Build a Windows portable (绿色版) zip from a release Grok.exe and upload to GitHub Release.
# Usage (CI): bash scripts/package-windows-portable.sh v0.1.1
# Or: TAG=v0.1.1 bash scripts/package-windows-portable.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

TAG="${1:-${TAG:-}}"
if [[ -z "$TAG" ]]; then
  TAG="v$(python3 -c 'import json; print(json.load(open("package.json"))["version"])')"
fi
VER="${TAG#v}"

EXE="$(find src-tauri/target -type f -name 'Grok.exe' -path '*/release/Grok.exe' 2>/dev/null | head -n 1 || true)"
if [[ -z "$EXE" || ! -f "$EXE" ]]; then
  echo "error: Grok.exe not found under src-tauri/target/**/release/" >&2
  find src-tauri/target -name 'Grok.exe' 2>/dev/null | head -20 || true
  exit 1
fi

STAGE="dist-portable/Grok_${VER}_x64-portable"
rm -rf dist-portable
mkdir -p "$STAGE"
cp "$EXE" "$STAGE/Grok.exe"
python3 - "$VER" "$STAGE" <<'PY'
import sys
from pathlib import Path

ver, stage = sys.argv[1], Path(sys.argv[2])
(stage / "README-portable.txt").write_text(
    f"""Grok App portable (绿色版) v{ver}
================================
1. 解压本目录到任意位置（无需安装）。
2. 双击 Grok.exe 运行。
3. 需要系统已安装 Microsoft Edge WebView2 Runtime（Win10/11 通常已自带）。
4. 真 Agent 能力仍需本机 Grok Build CLI（grok.exe）并完成登录。
5. SmartScreen 可能提示未知发布者 → 更多信息 → 仍要运行。

Extract anywhere and run Grok.exe. WebView2 required. Grok Build CLI still needed for agent sessions.
""",
    encoding="utf-8",
)
print("wrote", stage / "README-portable.txt")
PY

OUT="Grok_${VER}_x64-portable.zip"
(cd dist-portable && zip -r "../${OUT}" "Grok_${VER}_x64-portable")
ls -lah "$OUT"
if command -v gh >/dev/null 2>&1 && [[ -n "${GH_TOKEN:-${GITHUB_TOKEN:-}}" ]]; then
  gh release upload "$TAG" "$OUT" --clobber
  echo "uploaded $OUT to $TAG"
else
  echo "skip upload (gh/token missing); artifact at $OUT"
fi
