#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"

# Finder-launched terminals may not inherit Pi's managed Node path.
if ! command -v node >/dev/null 2>&1; then
  for node in "$HOME"/.local/share/pi-node/node-*/bin/node; do
    if [ -x "$node" ]; then
      export PATH="$(dirname "$node"):$PATH"
    fi
  done
fi
if ! command -v node >/dev/null 2>&1; then
  printf 'Node.js 22.19+ is required. Add node and pi to PATH.\n' >&2
  exit 1
fi
exec node ./scripts/launch.mjs "$@"
