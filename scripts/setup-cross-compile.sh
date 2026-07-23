#!/usr/bin/env bash
# Install Rust targets used by Grok App desktop builds.
# Run once on each developer machine (or after rustup update).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v rustup >/dev/null 2>&1; then
  echo "error: rustup not found. Install from https://rustup.rs" >&2
  exit 1
fi

echo "==> Ensuring stable toolchain"
rustup toolchain install stable
rustup default stable

HOST="$(rustc -vV | sed -n 's/^host: //p')"
echo "Host triple: $HOST"

# Desktop targets we care about for local / CI parity.
TARGETS=(
  "aarch64-apple-darwin" # macOS Apple Silicon
  "x86_64-apple-darwin"  # macOS Intel
  "x86_64-pc-windows-msvc" # Windows x64 (build on Windows or CI)
)

for t in "${TARGETS[@]}"; do
  echo "==> rustup target add $t"
  rustup target add "$t" || {
    echo "warn: failed to add $t (ok if unsupported on this host)" >&2
  }
done

if [[ "$(uname -s)" == "Darwin" ]]; then
  echo "==> macOS: Xcode CLT check"
  xcode-select -p >/dev/null 2>&1 || {
    echo "warn: Xcode Command Line Tools missing — run: xcode-select --install" >&2
  }
fi

echo "Done. Build with:"
echo "  pnpm build:mac-arm | pnpm build:mac-intel | pnpm build:win"
echo "  ./scripts/build-local.sh all-mac"
