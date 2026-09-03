#!/bin/bash
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(sed -n 's/^HERMES_STUDIO_VERSION=//p' "$ROOT/config/bootstrap/hermes-studio-version.env")"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/node/bin" "$T/bin" "$T/home" "$T/var" "$T/manager/backend" "$T/skills"
cp -R "$ROOT/cmd" "$T/cmd"
cp -R "$ROOT/config" "$T/config"
cp -R "$ROOT/.agents/skills/trim-cli" "$T/skills/trim-cli"
cp "$ROOT/tests/helpers/fake-node.sh" "$T/node/bin/node"
printf '%s\n' '// fake manager entry' > "$T/manager/backend/server.mjs"
printf '%s\n' '#!/bin/sh' \
  'case "$npm_config_prefix" in "$TRIM_PKGHOME/data/runtime/studio/.npm-stage."*) ;; *) exit 90 ;; esac' \
  '[ "$npm_config_prefix" != "$TRIM_PKGHOME/data/.npm-global" ] || exit 91' \
  'root="$npm_config_prefix/lib/node_modules/hermes-web-ui"' \
  'mkdir -p "$npm_config_prefix/bin" "$root/bin" "$root/dist/server"' \
  'printf "#!/bin/sh\n# hermes-web-ui\n" > "$root/bin/hermes-web-ui.mjs"' \
  'printf "%s\n" "{\"name\":\"hermes-web-ui\",\"version\":\"${HERMES_TEST_VERSION}\"}" > "$root/package.json"' \
  'printf "%s\n" "// server" > "$root/dist/server/index.js"' \
  'chmod +x "$root/bin/hermes-web-ui.mjs"' \
  'ln -s ../lib/node_modules/hermes-web-ui/bin/hermes-web-ui.mjs "$npm_config_prefix/bin/hermes-web-ui"' > "$T/node/bin/npm"
printf '%s\n' '#!/bin/sh' 'exit 22' > "$T/bin/curl"
chmod +x "$T/node/bin/node" "$T/node/bin/npm" "$T/bin/curl"
export HERMES_TEST_BOUNDED_LOG="$T/bounded.log"
if ! TRIM_APPDEST="$T" TRIM_PKGHOME="$T/home" TRIM_PKGVAR="$T/var" NODE_ROOT="$T/node" HERMES_TEST_VERSION="$VERSION" \
  PATH="$T/bin:$PATH" HSTUDIO_RUNTIME_BOOTSTRAP=1 LIFECYCLE_ROOT="$T" bash "$T/cmd/install_callback"; then
  cat "$T/var/info.log" >&2
  exit 1
fi
TRIM_APPDEST="$T" TRIM_PKGHOME="$T/home" TRIM_PKGVAR="$T/var" NODE_ROOT="$T/node" \
  bash "$ROOT/cmd/main" stop
test -x "$T/home/data/runtime/studio/$VERSION/bin/hermes-web-ui"
test "$(readlink "$T/home/data/runtime/studio/current")" = "$VERSION"
test ! -e "$T/home/data/.npm-global/bin/hermes-web-ui"
test ! -e "$T/home/data/.npm-global/lib/node_modules/hermes-web-ui"
grep -q "isolated npm runtime $VERSION verified and published as bundled Runtime" "$T/var/info.log"
grep -q 'archive unavailable; trying isolated npm fallback' "$T/var/info.log"
grep -qx '900000' "$T/bounded.log"
grep -q '"status":"success"' "$T/home/data/manager/runtime-bootstrap.json"
! grep -q '"callbackPid"' "$T/home/data/manager/runtime-bootstrap.json"
echo PASS npm fallback
