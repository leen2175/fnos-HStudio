#!/bin/bash
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(sed -n 's/^HERMES_STUDIO_VERSION=//p' "$ROOT/config/bootstrap/hermes-studio-version.env")"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/node/bin" "$T/home" "$T/var" "$T/home/data/.npm-global/bin" \
  "$T/home/data/.npm-global/lib/node_modules/hermes-web-ui/bin" \
  "$T/home/data/.npm-global/lib/node_modules/hermes-web-ui/dist/server" \
  "$T/app/runtime" "$T/app/skills" "$T/app/manager/backend" "$T/stage/runtime/bin" "$T/stage/runtime/dist/server" \
  "$T/etc/bootstrap"
cp -R "$ROOT/.agents/skills/trim-cli" "$T/app/skills/trim-cli"
cp "$ROOT/config/bootstrap/hermes-studio-version.env" "$T/etc/bootstrap/hermes-studio-version.env"
cp "$ROOT/config/runtime-manifest.json" "$T/etc/runtime-manifest.json"
cp "$ROOT/tests/helpers/fake-node.sh" "$T/node/bin/node"
printf '%s\n' '// fake manager entry' > "$T/app/manager/backend/server.mjs"
cat > "$T/node/bin/npm" <<'EOF'
#!/bin/sh
[ -z "${NETWORK_CALLED:-}" ] || printf '%s\n' npm >> "$NETWORK_CALLED"
echo 'npm must not run during a package-only upgrade' >&2
exit 99
EOF
cat > "$T/node/bin/curl" <<'EOF'
#!/bin/sh
[ -z "${NETWORK_CALLED:-}" ] || printf '%s\n' curl >> "$NETWORK_CALLED"
exit 99
EOF
cat > "$T/home/data/.npm-global/lib/node_modules/hermes-web-ui/bin/hermes-web-ui.mjs" <<'EOF'
#!/bin/sh
# hermes-web-ui healthy test shim
EOF
printf '%s\n' '{"name":"hermes-web-ui","version":"0.7.15"}' > \
  "$T/home/data/.npm-global/lib/node_modules/hermes-web-ui/package.json"
printf '%s\n' '// server' > "$T/home/data/.npm-global/lib/node_modules/hermes-web-ui/dist/server/index.js"
ln -s ../lib/node_modules/hermes-web-ui/bin/hermes-web-ui.mjs \
  "$T/home/data/.npm-global/bin/hermes-web-ui"
printf '%s\n' '#!/bin/sh' '# bundled runtime' > "$T/stage/runtime/bin/hermes-web-ui"
printf '%s\n' "{\"name\":\"hermes-web-ui\",\"version\":\"$VERSION\"}" > "$T/stage/runtime/package.json"
printf '%s\n' '// bundled server' > "$T/stage/runtime/dist/server/index.js"
chmod +x "$T/node/bin/node" "$T/node/bin/npm" "$T/node/bin/curl" \
  "$T/home/data/.npm-global/lib/node_modules/hermes-web-ui/bin/hermes-web-ui.mjs" \
  "$T/stage/runtime/bin/hermes-web-ui"
tar -czf "$T/app/runtime/hermes-studio-runtime-$VERSION-linux-x64.tar.gz" -C "$T/stage" runtime
archive_hash="$(sha256sum "$T/app/runtime/hermes-studio-runtime-$VERSION-linux-x64.tar.gz" | awk '{print $1}')"
archive_size="$(stat -c '%s' "$T/app/runtime/hermes-studio-runtime-$VERSION-linux-x64.tar.gz")"
sed -i -E "s/\"sha256\": \"[^\"]+\"/\"sha256\": \"$archive_hash\"/; s/\"size\": [0-9]+/\"size\": $archive_size/" "$T/etc/runtime-manifest.json"
if ! TRIM_APPDEST="$T/app" TRIM_PKGHOME="$T/home" TRIM_PKGVAR="$T/var" TRIM_PKGETC="$T/etc" NODE_ROOT="$T/node" HERMES_TEST_VERSION="$VERSION" NETWORK_CALLED="$T/network-called" \
  PATH="$T/node/bin:$PATH" bash "$ROOT/cmd/upgrade_callback"; then
  cat "$T/var/info.log" >&2
  exit 1
fi
test ! -e "$T/network-called"
test ! -e "$T/home/data/manager/runtime-bootstrap.json"
grep -q 'package-only Runtime refresh complete; network fallback was disabled' "$T/var/info.log"
grep -q '"version":"0.7.15"' "$T/home/data/.npm-global/lib/node_modules/hermes-web-ui/package.json"
test -x "$T/home/data/runtime/studio/$VERSION/bin/hermes-web-ui"
test "$(readlink "$T/home/data/runtime/studio/current")" = "$VERSION"
selected="$(TRIM_APPDEST="$T/app" TRIM_PKGHOME="$T/home" TRIM_PKGVAR="$T/var" NODE_ROOT="$T/node" HERMES_TEST_VERSION="$VERSION" bash "$ROOT/cmd/main" runtime auto)"
test "${selected%%:*}" = user-global
selected_version="$(TRIM_APPDEST="$T/app" TRIM_PKGHOME="$T/home" TRIM_PKGVAR="$T/var" NODE_ROOT="$T/node" HERMES_TEST_VERSION="$VERSION" bash "$ROOT/cmd/main" runtime-version auto)"
test "$selected_version" = 0.7.15

# Reinstalling the same Offline version must still consume the verified FPK
# archive instead of trusting a merely version-reporting installed Runtime.
printf '%s\n' '// modified installed server' > "$T/home/data/runtime/studio/$VERSION/dist/server/index.js"
TRIM_APPDEST="$T/app" TRIM_PKGHOME="$T/home" TRIM_PKGVAR="$T/var" TRIM_PKGETC="$T/etc" NODE_ROOT="$T/node" HERMES_TEST_VERSION="$VERSION" NETWORK_CALLED="$T/network-called" \
  PATH="$T/node/bin:$PATH" bash "$ROOT/cmd/upgrade_callback"
test ! -e "$T/network-called"
grep -q '^// bundled server$' "$T/home/data/runtime/studio/$VERSION/dist/server/index.js"
grep -q '"version":"0.7.15"' "$T/home/data/.npm-global/lib/node_modules/hermes-web-ui/package.json"

# A Lite FPK has no Runtime archive. Its real upgrade callback must still be a
# network-free no-op and must not leave Manager-facing bootstrap state behind.
rm -f "$T/app/runtime/hermes-studio-runtime-$VERSION-linux-x64.tar.gz"
rm -rf "$T/home/data/runtime/studio"
mkdir -p "$T/home/runtime"
printf '%s\n' 'persistent cache, not an FPK payload' > "$T/home/runtime/hermes-studio-runtime-old.tar.gz"
TRIM_APPDEST="$T/app" TRIM_PKGHOME="$T/home" TRIM_PKGVAR="$T/var" TRIM_PKGETC="$T/etc" NODE_ROOT="$T/node" HERMES_TEST_VERSION="$VERSION" NETWORK_CALLED="$T/network-called" \
  PATH="$T/node/bin:$PATH" bash "$ROOT/cmd/upgrade_callback"
test ! -e "$T/network-called"
test ! -e "$T/home/data/manager/runtime-bootstrap.json"
test ! -e "$T/home/data/runtime/studio/current"
test -f "$T/home/runtime/hermes-studio-runtime-old.tar.gz"
TRIM_APPDEST="$T/app" TRIM_PKGHOME="$T/home" TRIM_PKGVAR="$T/var" NODE_ROOT="$T/node" \
  bash "$ROOT/cmd/main" stop
echo PASS upgrade callback consumes Offline Runtime, preserves user Runtime, and keeps Lite upgrades offline
