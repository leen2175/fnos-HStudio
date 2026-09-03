#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"
APP="$T/app"
PKGHOME="$T/home"
PKGVAR="$T/var"
NODE_ROOT="$T/node"

cleanup() {
    if [ -r "$PKGHOME/data/manager/manager.pid" ]; then
        pid="$(sed -n '1p' "$PKGHOME/data/manager/manager.pid" 2>/dev/null || true)"
        case "$pid" in ''|*[!0-9]*) ;; *) kill -TERM "$pid" 2>/dev/null || true ;; esac
    fi
    rm -rf -- "${T:?}"
}
trap cleanup EXIT

mkdir -p "$APP/manager/backend" "$NODE_ROOT/bin" "$PKGHOME" "$PKGVAR"
cp -a "$ROOT/cmd" "$APP/cmd"
cp "$ROOT/tests/helpers/fake-node.sh" "$NODE_ROOT/bin/node"
chmod +x "$NODE_ROOT/bin/node"
: > "$APP/manager/backend/server.mjs"

start_app() {
    TRIM_APPDEST="$APP" TRIM_PKGHOME="$PKGHOME" TRIM_PKGVAR="$PKGVAR" \
        NODE_ROOT="$NODE_ROOT" bash "$APP/cmd/main" start
}
stop_app() {
    TRIM_APPDEST="$APP" TRIM_PKGHOME="$PKGHOME" TRIM_PKGVAR="$PKGVAR" \
        NODE_ROOT="$NODE_ROOT" bash "$APP/cmd/main" stop
}
pid_active() {
    local pid="$1" state
    kill -0 "$pid" 2>/dev/null || return 1
    state="$(sed 's/^.*) //' "/proc/$pid/stat" 2>/dev/null | awk '{print $1}')"
    [ "$state" != Z ]
}
wait_inactive() {
    local pid="$1"
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
        pid_active "$pid" || return 0
        sleep 0.1
    done
    return 1
}

start_app & first=$!
start_app & second=$!
first_rc=0; second_rc=0
wait "$first" || first_rc=$?
wait "$second" || second_rc=$?
if [ "$first_rc" -ne 0 ] || [ "$second_rc" -ne 0 ]; then
    printf 'concurrent start failed: first=%s second=%s\n' "$first_rc" "$second_rc" >&2
    cat "$PKGVAR/info.log" >&2 2>/dev/null || true
    cat "$PKGVAR/last-error.log" >&2 2>/dev/null || true
    exit 1
fi

manager_pid="$(cat "$PKGHOME/data/manager/manager.pid")"
kill -0 "$manager_pid"
test -S "$APP/manager.sock"
test ! -e "$PKGHOME/data/manager/start.lock"
test "$(pgrep -f -c -- "$APP/manager/backend/server.mjs")" -eq 1

stop_app
wait_inactive "$manager_pid"

# A lifecycle process that dies while holding the lock must not permanently
# block the application. Reclaim only an identity-mismatched stale lock.
mkdir -p "$PKGHOME/data/manager/start.lock"
printf '%s\n' 999999 > "$PKGHOME/data/manager/start.lock/pid"
printf '%s\n' 1 > "$PKGHOME/data/manager/start.lock/starttime"
if ! start_app; then
    cat "$PKGVAR/info.log" >&2 2>/dev/null || true
    cat "$PKGVAR/last-error.log" >&2 2>/dev/null || true
    exit 1
fi
replacement_pid="$(cat "$PKGHOME/data/manager/manager.pid")"
kill -0 "$replacement_pid"
test -S "$APP/manager.sock"
test ! -e "$PKGHOME/data/manager/start.lock"
stop_app

# fnOS stop takes the same lock as Manager start. Even if stop lands between
# process spawn and socket readiness, it must return with no late Manager.
HERMES_TEST_MANAGER_DELAY=1 start_app & racing_start=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do
    [ -d "$PKGHOME/data/manager/start.lock" ] && break
    sleep 0.1
done
stop_app
wait "$racing_start" 2>/dev/null || true
test ! -e "$PKGHOME/data/manager/manager.pid"
test ! -e "$APP/manager.sock"

# A verified Manager may need longer than the old five-second window to finish
# a durable update rollback. It must be allowed to exit cleanly after TERM
# instead of being killed while its shutdown handler is still running.
cat > "$APP/manager/backend/server.mjs" <<'EOF'
#!/bin/bash
trap '
    printf "%s\n" term > "$MANAGER_GRACEFUL_MARKER"
    sleep 6
    printf "%s\n" graceful > "$MANAGER_GRACEFUL_MARKER"
    exit 0
' TERM
while :; do sleep 1; done
EOF
chmod +x "$APP/manager/backend/server.mjs"
MANAGER_GRACEFUL_MARKER="$T/manager-graceful" DATA_DIR="$PKGHOME/data" \
    "$APP/manager/backend/server.mjs" &
delayed_manager_pid=$!
printf '%s\n' "$delayed_manager_pid" > "$PKGHOME/data/manager/manager.pid"
stop_app
wait "$delayed_manager_pid"
grep -qx graceful "$T/manager-graceful"
test ! -e "$PKGHOME/data/manager/manager.pid"

echo 'PASS Manager start locking and extended graceful shutdown window'
