#!/bin/bash
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

mkdir -p "$T/node/bin" "$T/home"
cat > "$T/node/bin/node" <<'EOF'
#!/bin/sh
if [ "${1:-}" = "--version" ]; then
    echo v24.15.0
    exit 0
fi
if [ "${1:-}" = "-e" ]; then
    [ "${3:-}" = hstudio-bounded ] || exit 2
    shift 4
    exec "$0" "$@"
fi
entry="$(readlink -f "$1")"
root="$(dirname "$(dirname "$entry")")"
[ ! -e "$root/FAIL_HEALTH" ] || exit 9
version="$(sed -nE 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$root/package.json" | head -1)"
[ -n "$version" ] || exit 8
echo "hermes-web-ui $version"
EOF
chmod +x "$T/node/bin/node"

export TRIM_APPDEST="$ROOT" TRIM_PKGHOME="$T/home" DATA_DIR="$T/home/data" NODE_ROOT="$T/node"
. "$ROOT/cmd/lib/environment.sh"
. "$ROOT/cmd/lib/runtime.sh"
init_environment

make_archive() {
    local version="$1" marker="$2" archive="$3" fail_health="${4:-0}" source
    source="$T/source-$marker"
    rm -rf "$source"
    mkdir -p "$source/runtime/bin" "$source/runtime/dist/server"
    printf '%s\n' '#!/usr/bin/env node' > "$source/runtime/bin/hermes-web-ui.mjs"
    chmod +x "$source/runtime/bin/hermes-web-ui.mjs"
    printf '{"name":"hermes-web-ui","version":"%s"}\n' "$version" > "$source/runtime/package.json"
    printf '%s\n' '// server' > "$source/runtime/dist/server/index.js"
    printf '%s\n' "$marker" > "$source/runtime/BUILD"
    [ "$fail_health" = 0 ] || : > "$source/runtime/FAIL_HEALTH"
    tar -czf "$archive" -C "$source" runtime
}

install_archive() {
    local archive="$1" version="$2" hash
    hash="$(sha256sum "$archive" | awk '{print $1}')"
    install_runtime_archive "$archive" "$version" "$hash"
}

make_archive 1.0.0 first "$T/v1.tar.gz"
install_archive "$T/v1.tar.gz" 1.0.0
test "$(readlink "$runtime_bundled_root/current")" = 1.0.0
test "$(cat "$runtime_bundled_root/1.0.0/BUILD")" = first

make_archive 2.0.0 second "$T/v2.tar.gz"
install_archive "$T/v2.tar.gz" 2.0.0
test "$(readlink "$runtime_bundled_root/current")" = 2.0.0
test "$(readlink "$runtime_bundled_root/previous")" = 1.0.0
test "$(cat "$runtime_bundled_root/1.0.0/BUILD")" = first

# Crash recovery: if the version directory is healthy but a previous process
# died before switching current, retrying activation repairs current and keeps
# the displaced version as previous without re-extracting either tree.
rm -f "$runtime_bundled_root/current"
ln -s 1.0.0 "$runtime_bundled_root/current"
activate_bundled_runtime 2.0.0
test "$(readlink "$runtime_bundled_root/current")" = 2.0.0
test "$(readlink "$runtime_bundled_root/previous")" = 1.0.0

# A candidate that fails the executable health probe must never be published.
make_archive 3.0.0 unhealthy "$T/unhealthy.tar.gz" 1
if install_archive "$T/unhealthy.tar.gz" 3.0.0; then
    echo 'unhealthy Runtime was published' >&2
    exit 1
fi
test "$RUNTIME_ARCHIVE_ERROR" = health
test "$(readlink "$runtime_bundled_root/current")" = 2.0.0
test ! -e "$runtime_bundled_root/3.0.0"

# Space preflight uses the archive's expanded payload size plus headroom. A
# compressed-size multiplier would undercount the real 0.7.16 Runtime.
make_archive 3.1.0 low-space "$T/low-space.tar.gz"
mkdir -p "$T/low-space-bin"
cat > "$T/low-space-bin/df" <<'EOF'
#!/bin/sh
printf '%s\n' 'Filesystem 1024-blocks Used Available Capacity Mounted on' 'test 100 99 1 99% /'
EOF
chmod +x "$T/low-space-bin/df"
old_path="$PATH"
PATH="$T/low-space-bin:$PATH"
if install_archive "$T/low-space.tar.gz" 3.1.0; then
    echo 'low-space Runtime installation unexpectedly succeeded' >&2
    exit 1
fi
PATH="$old_path"
test "$RUNTIME_ARCHIVE_ERROR" = insufficient_space
test ! -e "$runtime_bundled_root/3.1.0"

# Replacing the currently selected version retains the replaced tree as previous.
make_archive 2.0.0 replacement "$T/replacement.tar.gz"
install_archive "$T/replacement.tar.gz" 2.0.0
test "$(cat "$runtime_bundled_root/2.0.0/BUILD")" = replacement
previous_target="$(readlink "$runtime_bundled_root/previous")"
case "$previous_target" in 2.0.0.previous.*) ;; *) exit 1 ;; esac
test "$(cat "$runtime_bundled_root/$previous_target/BUILD")" = second

# Inject a current-link rename failure after the candidate and old target moved.
# The transaction must restore both the same-version target and current pointer.
real_mv="$(command -v mv)"
mkdir -p "$T/fail-bin"
cat > "$T/fail-bin/mv" <<'EOF'
#!/bin/sh
for last do :; done
if [ "$last" = "$FAIL_MV_DEST" ]; then exit 73; fi
exec "$REAL_MV" "$@"
EOF
chmod +x "$T/fail-bin/mv"
make_archive 2.0.0 should-not-publish "$T/switch-fail.tar.gz"
old_previous="$(readlink "$runtime_bundled_root/previous")"
old_path="$PATH"
export REAL_MV="$real_mv" FAIL_MV_DEST="$runtime_bundled_root/current"
PATH="$T/fail-bin:$PATH"
if install_archive "$T/switch-fail.tar.gz" 2.0.0; then
    echo 'current switch failure unexpectedly succeeded' >&2
    exit 1
fi
PATH="$old_path"
unset REAL_MV FAIL_MV_DEST
test "$RUNTIME_ARCHIVE_ERROR" = current_switch
test "$(readlink "$runtime_bundled_root/current")" = 2.0.0
test "$(cat "$runtime_bundled_root/2.0.0/BUILD")" = replacement
test "$(readlink "$runtime_bundled_root/previous")" = "$old_previous"

# A traversal member and an escaping symlink are rejected before extraction.
mkdir -p "$T/traversal-source/runtime"
printf x > "$T/traversal-source/runtime/file"
tar -czf "$T/traversal.tar.gz" --transform='s#^runtime#../escape#' -C "$T/traversal-source" runtime
if install_archive "$T/traversal.tar.gz" 4.0.0; then exit 1; fi
test "$RUNTIME_ARCHIVE_ERROR" = unsafe_layout
test ! -e "$runtime_bundled_root/4.0.0"

make_archive 4.0.0 unsafe-link "$T/unsafe-link.tar.gz"
rm -f "$T/unsafe-link.tar.gz"
ln -s ../../outside "$T/source-unsafe-link/runtime/escape"
tar -czf "$T/unsafe-link.tar.gz" -C "$T/source-unsafe-link" runtime
if install_archive "$T/unsafe-link.tar.gz" 4.0.0; then exit 1; fi
test "$RUNTIME_ARCHIVE_ERROR" = unsafe_layout
test ! -e "$runtime_bundled_root/4.0.0"

echo 'PASS Runtime archive health, safe layout and atomic rollback'
