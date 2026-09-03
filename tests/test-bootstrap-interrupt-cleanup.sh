#!/bin/bash
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(sed -n 's/^HERMES_STUDIO_VERSION=//p' "$ROOT/config/bootstrap/hermes-studio-version.env")"
T="$(mktemp -d)"
callback_pid=""
cleanup() {
    if [ -n "$callback_pid" ]; then
        kill -KILL -- "-$callback_pid" 2>/dev/null || true
    fi
    rm -rf -- "${T:?}"
}
trap cleanup EXIT

mkdir -p "$T/node/bin" "$T/source/runtime/bin" "$T/source/runtime/dist/server" \
    "$T/home" "$T/var" "$T/app/manager/backend" "$T/app/runtime" \
    "$T/app/skills/trim-cli/bin" "$T/app/skills/trim-cli/scripts" "$T/test-bin"
cp -R "$ROOT/cmd" "$T/cmd"
cp -R "$ROOT/config" "$T/config"
cp "$ROOT/tests/helpers/fake-node.sh" "$T/node/bin/node"
printf '%s\n' '// fake manager entry' > "$T/app/manager/backend/server.mjs"
printf '%s\n' '---' 'name: trim-cli' '---' > "$T/app/skills/trim-cli/SKILL.md"
printf '%s\n' '#!/bin/sh' 'echo trim-cli' > "$T/app/skills/trim-cli/scripts/trim-cli"
printf '%s\n' '#!/bin/sh' 'echo trim-cli-x64' > "$T/app/skills/trim-cli/bin/trim-cli-linux-x64"
printf '%s\n' '#!/bin/sh' 'echo trim-cli-arm64' > "$T/app/skills/trim-cli/bin/trim-cli-linux-arm64"
printf '%s\n' '#!/usr/bin/env node' > "$T/source/runtime/bin/hermes-web-ui"
printf '%s\n' "{\"name\":\"hermes-web-ui\",\"version\":\"$VERSION\"}" > "$T/source/runtime/package.json"
printf '%s\n' '// server' > "$T/source/runtime/dist/server/index.js"
chmod +x "$T/node/bin/node" "$T/source/runtime/bin/hermes-web-ui" \
    "$T/app/skills/trim-cli/scripts/trim-cli" "$T/app/skills/trim-cli/bin/"*
tar -czf "$T/app/runtime/hermes-studio-runtime-$VERSION-linux-x64.tar.gz" -C "$T/source" runtime
archive_hash="$(sha256sum "$T/app/runtime/hermes-studio-runtime-$VERSION-linux-x64.tar.gz" | awk '{print $1}')"
archive_size="$(stat -c '%s' "$T/app/runtime/hermes-studio-runtime-$VERSION-linux-x64.tar.gz")"
sed -i -E "s/\"sha256\": \"[^\"]+\"/\"sha256\": \"$archive_hash\"/; s/\"size\": [0-9]+/\"size\": $archive_size/; /\"urls\": \[/,/\]/c\\    \"urls\": []" "$T/config/runtime-manifest.json"

real_tar="$(command -v tar)"
real_rm="$(command -v rm)"
cat > "$T/test-bin/tar" <<'EOF'
#!/bin/bash
set -eu
if [ "${1:-}" != -xzf ]; then exec "$REAL_TAR" "$@"; fi
stage=""
previous=""
for argument in "$@"; do
    if [ "$previous" = -C ]; then stage="$argument"; break; fi
    previous="$argument"
done
[ -n "$stage" ] || exit 2
mkdir -p "$stage/runtime"
printf '%s\n' interrupted > "$stage/runtime/partial"
printf '%s\n' "$stage" > "$EXTRACT_STAGE_FILE"
trap 'exit 143' TERM INT
while :; do sleep 1; done
EOF
cat > "$T/test-bin/rm" <<'EOF'
#!/bin/bash
set -eu
last=""
for last do :; done
if [ -d "$last" ]; then
    case "$last" in
      */.staging.*)
        printf '%s\n' started > "$CLEANUP_DELAY_MARKER"
        sleep 6
        "$REAL_RM" "$@"
        printf '%s\n' complete > "$CLEANUP_DELAY_MARKER"
        exit 0
        ;;
    esac
fi
exec "$REAL_RM" "$@"
EOF
chmod +x "$T/test-bin/tar" "$T/test-bin/rm"

# These resemble transient names but are not owned by this callback and must
# never be removed by its exact-path cleanup.
mkdir -p "$T/home/data/runtime/studio/.staging.keep" "$T/home/data/runtime/studio/0.6.0"
printf '%s\n' keep > "$T/home/data/runtime/studio/.staging.keep/SENTINEL"
printf '%s\n' keep > "$T/home/data/runtime/studio/0.6.0/SENTINEL"

setsid env DATA_DIR="$T/home/data" TRIM_APPDEST="$T/app" TRIM_PKGHOME="$T/home" TRIM_PKGVAR="$T/var" \
    NODE_ROOT="$T/node" HERMES_TEST_VERSION="$VERSION" HSTUDIO_RUNTIME_BOOTSTRAP=1 \
    LIFECYCLE_ROOT="$T" REAL_TAR="$real_tar" REAL_RM="$real_rm" \
    CLEANUP_DELAY_MARKER="$T/cleanup-delay" EXTRACT_STAGE_FILE="$T/extract-stage" \
    PATH="$T/test-bin:$PATH" bash "$T/cmd/install_callback" &
callback_pid=$!
for _ in $(seq 1 100); do
    [ -s "$T/extract-stage" ] && break
    kill -0 "$callback_pid" 2>/dev/null || break
    sleep 0.05
done
if [ ! -s "$T/extract-stage" ]; then
    cat "$T/var/info.log" >&2 2>/dev/null || true
    cat "$T/home/data/manager/runtime-bootstrap.json" >&2 2>/dev/null || true
    exit 1
fi
stage="$(sed -n '1p' "$T/extract-stage")"
test -f "$stage/runtime/partial"
TRIM_APPDEST="$T/app" TRIM_PKGHOME="$T/home" TRIM_PKGVAR="$T/var" NODE_ROOT="$T/node" \
    bash "$T/cmd/main" stop
if wait "$callback_pid"; then
    echo 'interrupted Runtime bootstrap unexpectedly succeeded' >&2
    exit 1
fi
callback_pid=""

grep -qx complete "$T/cleanup-delay"
test ! -e "$stage"
test ! -e "${stage}.members"
test ! -e "${stage}.verbose"
test -f "$T/home/data/runtime/studio/.staging.keep/SENTINEL"
test -f "$T/home/data/runtime/studio/0.6.0/SENTINEL"
grep -q '"status":"failed"' "$T/home/data/manager/runtime-bootstrap.json"

echo 'PASS bootstrap stop allows delayed exact Runtime staging cleanup to finish'
