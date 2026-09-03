#!/bin/bash
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(sed -n 's/^HERMES_STUDIO_VERSION=//p' "$ROOT/config/bootstrap/hermes-studio-version.env")"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/node/bin" "$T/stage/runtime/bin" "$T/stage/runtime/dist/server" "$T/home" "$T/var" "$T/app/manager/backend"
cp -R "$ROOT/cmd" "$T/cmd"
cp -R "$ROOT/config" "$T/config"
mkdir -p "$T/app/runtime" "$T/app/skills/trim-cli/bin" "$T/app/skills/trim-cli/scripts"
printf '%s\n' '---' 'name: trim-cli' '---' > "$T/app/skills/trim-cli/SKILL.md"
printf '%s\n' '#!/bin/sh' 'echo trim-cli' > "$T/app/skills/trim-cli/scripts/trim-cli"
printf '%s\n' '#!/bin/sh' 'echo trim-cli-x64' > "$T/app/skills/trim-cli/bin/trim-cli-linux-x64"
printf '%s\n' '#!/bin/sh' 'echo trim-cli-arm64' > "$T/app/skills/trim-cli/bin/trim-cli-linux-arm64"
cp "$ROOT/tests/helpers/fake-node.sh" "$T/node/bin/node"
printf '%s\n' '// fake manager entry' > "$T/app/manager/backend/server.mjs"
printf '%s\n' '#!/bin/sh' 'echo "hermes-web-ui ${HERMES_TEST_VERSION}"' > "$T/stage/runtime/bin/hermes-web-ui"
printf '%s\n' "{\"name\":\"hermes-web-ui\",\"version\":\"$VERSION\"}" > "$T/stage/runtime/package.json"
printf '%s\n' '// server' > "$T/stage/runtime/dist/server/index.js"
chmod +x "$T/node/bin/node" "$T/stage/runtime/bin/hermes-web-ui" \
  "$T/app/skills/trim-cli/scripts/trim-cli" "$T/app/skills/trim-cli/bin/"*
tar -czf "$T/app/runtime/hermes-studio-runtime-$VERSION-linux-x64.tar.gz" -C "$T/stage" runtime
archive_hash="$(sha256sum "$T/app/runtime/hermes-studio-runtime-$VERSION-linux-x64.tar.gz" | awk '{print $1}')"
archive_size="$(stat -c '%s' "$T/app/runtime/hermes-studio-runtime-$VERSION-linux-x64.tar.gz")"
sed -i -E "s/\"sha256\": \"[^\"]+\"/\"sha256\": \"$archive_hash\"/; s/\"size\": [0-9]+/\"size\": $archive_size/; /\"urls\": \[/,/\]/c\\    \"urls\": []" "$T/config/runtime-manifest.json"
if ! TRIM_APPDEST="$T/app" TRIM_PKGHOME="$T/home" TRIM_PKGVAR="$T/var" NODE_ROOT="$T/node" HERMES_TEST_VERSION="$VERSION" HSTUDIO_RUNTIME_BOOTSTRAP=1 LIFECYCLE_ROOT="$T" \
  bash "$T/cmd/install_callback"; then
  cat "$T/var/info.log" >&2
  exit 1
fi
TRIM_APPDEST="$T/app" TRIM_PKGHOME="$T/home" TRIM_PKGVAR="$T/var" NODE_ROOT="$T/node" \
  bash "$T/cmd/main" stop
test -x "$T/home/data/runtime/studio/$VERSION/bin/hermes-web-ui"
echo PASS offline archive
