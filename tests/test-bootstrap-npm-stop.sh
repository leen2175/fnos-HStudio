#!/bin/bash
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"
bootstrap_pid=""
cleanup() {
    [ -z "$bootstrap_pid" ] || kill -KILL -- "-$bootstrap_pid" 2>/dev/null || true
    rm -rf "$T"
}
trap cleanup EXIT
mkdir -p "$T/app/config/bootstrap" "$T/app/config" "$T/app/skills" \
    "$T/app/manager/backend" "$T/home" "$T/var" "$T/node/bin" "$T/bin"
cp -R "$ROOT/cmd" "$T/app/cmd"
cp -R "$ROOT/.agents/skills/trim-cli" "$T/app/skills/trim-cli"
cp "$ROOT/config/bootstrap/hermes-studio-version.env" "$T/app/config/bootstrap/hermes-studio-version.env"
cp "$ROOT/config/runtime-manifest.json" "$T/app/config/runtime-manifest.json"
printf '%s\n' '// fake manager entry' > "$T/app/manager/backend/server.mjs"
printf '%s\n' '#!/bin/sh' 'exit 22' > "$T/bin/curl"

# This test shim mirrors the production Node wrapper's important property:
# npm runs as a detached process group and TERM to the wrapper is forwarded to
# that exact group.
cat > "$T/node/bin/node" <<'EOF'
#!/bin/bash
set -u
if [ "${1:-}" = --version ]; then echo v24.15.0; exit 0; fi
if [ "${1:-}" = -e ] && [ "${3:-}" = hstudio-runtime-manifest ]; then
    python3 - "${4:-}" <<'PY'
import json, re, sys
studio=json.load(open(sys.argv[1], encoding='utf-8'))['studio']
if not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?', studio['version']): raise SystemExit(2)
if not re.fullmatch(r'[0-9a-fA-F]{64}', studio['sha256']): raise SystemExit(2)
if isinstance(studio['size'], bool) or not isinstance(studio['size'], int) or studio['size'] < 1: raise SystemExit(2)
print(studio['version']); print(studio['sha256'].lower()); print(studio['size'])
PY
    exit $?
fi
if [ "${1:-}" = -e ] && [ "${3:-}" = hstudio-command-bounded ]; then
    timeout_ms="${4:-}"
    shift 4
    printf '%s\n' "$timeout_ms" > "$HSTUDIO_TEST_ROOT/bounded-timeout"
    setsid "$@" &
    child=$!
    printf '%s\n' "$child" > "$HSTUDIO_TEST_ROOT/npm-pid"
    scope_alive() { kill -0 -- "-$child" 2>/dev/null; }
    stop_child() {
        kill -TERM -- "-$child" 2>/dev/null || true
        for _ in $(seq 1 20); do
            scope_alive || break
            sleep 0.1
        done
        scope_alive && kill -KILL -- "-$child" 2>/dev/null || true
        while scope_alive; do sleep 0.05; done
        wait "$child" 2>/dev/null || true
        touch "$HSTUDIO_TEST_ROOT/npm-scope-gone"
        exit 143
    }
    trap stop_child TERM INT
    wait "$child"
    exit $?
fi
exit 1
EOF
cat > "$T/node/bin/npm" <<'EOF'
#!/bin/bash
trap 'touch "$HSTUDIO_TEST_ROOT/npm-leader-stopped"; exit 0' TERM INT
printf '%s\n' "$npm_config_prefix" > "$HSTUDIO_TEST_ROOT/npm-stage-path"
touch "$HSTUDIO_TEST_ROOT/npm-started"
bash -c 'trap "" TERM INT; touch "$HSTUDIO_TEST_ROOT/npm-descendant-started"; while :; do sleep 1; done' &
printf '%s\n' "$!" > "$HSTUDIO_TEST_ROOT/npm-descendant-pid"
wait
EOF
chmod +x "$T/node/bin/node" "$T/node/bin/npm" "$T/bin/curl"

export HSTUDIO_TEST_ROOT="$T"
mkdir -p "$T/home/data/runtime/studio/.npm-stage.keep"
printf '%s\n' keep > "$T/home/data/runtime/studio/.npm-stage.keep/SENTINEL"
DATA_DIR="$T/home/data" TRIM_APPDEST="$T/app" TRIM_PKGHOME="$T/home" TRIM_PKGVAR="$T/var" \
    NODE_ROOT="$T/node" HSTUDIO_RUNTIME_BOOTSTRAP=1 PATH="$T/bin:$PATH" \
    setsid bash "$T/app/cmd/install_callback" &
bootstrap_pid=$!

for _ in $(seq 1 100); do
    [ -e "$T/npm-started" ] && [ -s "$T/npm-pid" ] && [ -s "$T/npm-descendant-pid" ] \
        && [ -s "$T/npm-stage-path" ] && break
    kill -0 "$bootstrap_pid" 2>/dev/null || { cat "$T/var/info.log" >&2; exit 1; }
    sleep 0.1
done
test -e "$T/npm-started"
test "$(cat "$T/bounded-timeout")" = 900000
npm_pid="$(cat "$T/npm-pid")"
npm_descendant_pid="$(cat "$T/npm-descendant-pid")"
npm_stage_path="$(cat "$T/npm-stage-path")"
test -d "$npm_stage_path"
kill -0 "$npm_pid"
kill -0 "$npm_descendant_pid"

TRIM_APPDEST="$T/app" TRIM_PKGHOME="$T/home" TRIM_PKGVAR="$T/var" \
    NODE_ROOT="$T/node" bash "$T/app/cmd/main" stop
wait "$bootstrap_pid" 2>/dev/null || true
bootstrap_pid=""

test -e "$T/npm-leader-stopped"
test -e "$T/npm-scope-gone"
! kill -0 "$npm_pid" 2>/dev/null
! kill -0 "$npm_descendant_pid" 2>/dev/null
test ! -e "$npm_stage_path"
test -f "$T/home/data/runtime/studio/.npm-stage.keep/SENTINEL"
echo 'PASS stop terminates the exact bounded npm fallback process group'
