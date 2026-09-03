#!/bin/bash
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
export DATA_DIR="$T/data"
export NPM_GLOBAL="$DATA_DIR/.npm-global"
export NODE_BIN="$ROOT/tests/helpers/fake-node.sh"
mkdir -p "$DATA_DIR/node/bin" "$DATA_DIR/node/dist/server" "$DATA_DIR/runtime/studio"
printf '%s\n' '#!/bin/sh' '# hermes-web-ui legacy entry' > "$DATA_DIR/node/bin/hermes-web-ui"
printf '%s\n' '{"name":"hermes-web-ui","version":"0.7.13"}' > "$DATA_DIR/node/package.json"
printf '%s\n' '// legacy server' > "$DATA_DIR/node/dist/server/index.js"
printf '%s' 'large legacy sentinel' > "$DATA_DIR/node/large-runtime-payload"
chmod +x "$DATA_DIR/node/bin/hermes-web-ui"

. "$ROOT/cmd/lib/migration.sh"
. "$ROOT/cmd/lib/runtime.sh"

migrate_legacy_runtime
migrate_legacy_runtime
test -f "$DATA_DIR/node/large-runtime-payload"
test ! -e "$DATA_DIR/runtime/studio/legacy"
test "$(bundled_entry)" = "$DATA_DIR/node/bin/hermes-web-ui"
health_check_runtime "$(bundled_entry)"

echo 'PASS legacy Runtime remains an in-place fallback without a duplicate copy'
