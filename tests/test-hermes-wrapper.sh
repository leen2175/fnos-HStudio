#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"
trap 'rm -rf -- "${T:?}"' EXIT

APP_CENTER="$T/appcenter/HStudio"
LIFECYCLE="$T/var-apps/HStudio"
NODE_ROOT="$T/node"
GLOBAL="$LIFECYCLE/home/data/.npm-global"
PACKAGE="$GLOBAL/lib/node_modules/hermes-web-ui"
LINK="$T/usr-local/bin/hermes-web-ui"
mkdir -p "$APP_CENTER/bin" "$LIFECYCLE/cmd/lib" "$NODE_ROOT/bin" \
    "$PACKAGE/bin" "$PACKAGE/dist/server" "$GLOBAL/bin" "$(dirname "$LINK")"
cp "$ROOT/app/bin/hermes-web-ui" "$APP_CENTER/bin/hermes-web-ui"
cp "$ROOT/cmd/lib/environment.sh" "$ROOT/cmd/lib/runtime.sh" "$LIFECYCLE/cmd/lib/"
cp "$ROOT/tests/helpers/fake-node.sh" "$NODE_ROOT/bin/node"
chmod +x "$APP_CENTER/bin/hermes-web-ui" "$NODE_ROOT/bin/node"
printf '%s\n' '{"name":"hermes-web-ui","version":"9.8.7"}' > "$PACKAGE/package.json"
printf '%s\n' '#!/usr/bin/env node' > "$PACKAGE/bin/hermes-web-ui.mjs"
printf '%s\n' 'export {}' > "$PACKAGE/dist/server/index.js"
chmod +x "$PACKAGE/bin/hermes-web-ui.mjs"
ln -s ../lib/node_modules/hermes-web-ui/bin/hermes-web-ui.mjs "$GLOBAL/bin/hermes-web-ui"
ln -s "$APP_CENTER/bin/hermes-web-ui" "$LINK"

output="$(env -u TRIM_APPDEST -u TRIM_PKGHOME \
    LIFECYCLE_ROOT="$LIFECYCLE" NODE_ROOT="$NODE_ROOT" "$LINK" --version)"
test "$output" = 'hermes-web-ui 9.8.7'

echo 'PASS packaged Hermes wrapper resolves appcenter and lifecycle roots through a symlink'
