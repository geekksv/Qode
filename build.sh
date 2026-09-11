#!/usr/bin/env bash
# Rebuilds web/wasm/main.wasm from the Go source and copies the matching
# wasm_exec.js glue into web/js/. Run this locally after changing any Go
# code under cmd/wasm or internal/, then commit the updated web/wasm/main.wasm
# and web/js/wasm_exec.js — Vercel serves web/ as a plain static site with
# no build step of its own, so the compiled binary has to be checked in.
#
# Requires Go on PATH (go.dev/dl). TinyGo would produce a smaller binary
# (see the plan doc's toolchain notes) but isn't required; this uses the
# standard toolchain's GOOS=js GOARCH=wasm target, which has full stdlib
# support (needed for archive/zip and encoding/csv) with no extra install.

set -euo pipefail
cd "$(dirname "$0")"

echo "Building main.wasm (GOOS=js GOARCH=wasm)..."
GOOS=js GOARCH=wasm go build -ldflags="-s -w" -o web/wasm/main.wasm ./cmd/wasm

GOROOT="$(go env GOROOT)"
EXEC_JS="$GOROOT/lib/wasm/wasm_exec.js"
if [ ! -f "$EXEC_JS" ]; then
  EXEC_JS="$GOROOT/misc/wasm/wasm_exec.js" # older Go versions
fi
cp "$EXEC_JS" web/js/wasm_exec.js

SIZE=$(du -h web/wasm/main.wasm | cut -f1)
echo "Done. web/wasm/main.wasm ($SIZE), web/js/wasm_exec.js refreshed."
