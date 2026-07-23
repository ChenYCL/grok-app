#!/usr/bin/env bash
# Bump version in package.json + tauri.conf.json + Cargo.toml (+ i18n footer) for a release.
# Usage: ./scripts/release-tag.sh 0.1.1
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VER="${1:-}"
if [[ -z "$VER" ]]; then
  echo "usage: $0 <semver>   e.g. $0 0.1.1" >&2
  exit 1
fi
VER="${VER#v}"
if ! [[ "$VER" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-].*)?$ ]]; then
  echo "error: invalid semver: $VER" >&2
  exit 1
fi

export VER
echo "==> Setting version $VER"

python3 - <<'PY'
import json, os, re
from pathlib import Path

ver = os.environ["VER"]

# package.json
p = Path("package.json")
data = json.loads(p.read_text())
data["version"] = ver
p.write_text(json.dumps(data, indent=2) + "\n")
print("package.json ->", ver)

# tauri.conf.json
p = Path("src-tauri/tauri.conf.json")
data = json.loads(p.read_text())
data["version"] = ver
p.write_text(json.dumps(data, indent=2) + "\n")
print("tauri.conf.json ->", ver)

# Cargo.toml [package] version only (first match)
p = Path("src-tauri/Cargo.toml")
text = p.read_text()
text2, n = re.subn(r'(?m)^version\s*=\s*"[^"]+"', f'version = "{ver}"', text, count=1)
if n != 1:
    raise SystemExit("failed to patch Cargo.toml version")
p.write_text(text2)
print("Cargo.toml ->", ver)

# i18n version footer
p = Path("src/i18n/messages.ts")
if p.is_file():
    t = p.read_text()
    t2 = re.sub(r"(Grok v)[0-9]+\.[0-9]+\.[0-9]+", rf"\g<1>{ver}", t)
    p.write_text(t2)
    print("i18n versionFooter ->", ver)
PY

TAG="v$VER"
if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "warn: tag $TAG already exists locally" >&2
fi

echo ""
echo "Review the diff, then:"
echo "  git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src/i18n/messages.ts"
echo "  git commit -m \"chore: release $TAG\""
echo "  git tag $TAG"
echo "  git push origin HEAD && git push origin $TAG"
