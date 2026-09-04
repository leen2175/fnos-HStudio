#!/bin/bash
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"
trap 'jobs -pr | xargs -r kill -KILL 2>/dev/null || true; rm -rf "$T"' EXIT

export DATA_DIR="$T/core-data" HOME="$T/core-data" HERMES_WEB_UI_HOME="$T/core-data/hermes-home"
export TRIM_APPDEST="$T/bootstrap-app"
export NPM_GLOBAL="$DATA_DIR/.npm-global"
runtime_bundled_root="$DATA_DIR/runtime/studio"
runtime_legacy_root="$DATA_DIR/node"
process_pid_file="$HERMES_WEB_UI_HOME/server.pid"
export HERMES_WEB_UI_HOME NPM_GLOBAL
mkdir -p "$runtime_bundled_root/1.0.0/dist/server" "$HERMES_WEB_UI_HOME"
. "$ROOT/cmd/lib/process.sh"

# Runtime bootstrap runs in its own process group. App stop must terminate only
# the callback whose PID, start time, command and environment all match state.
bootstrap_callback="$T/bootstrap-cmd/install_callback"
mkdir -p "$(dirname "$bootstrap_callback")" "$(dirname "$bootstrap_state_file")"
cat > "$bootstrap_callback" <<'EOF'
#!/bin/bash
trap 'printf stopped > "$BOOTSTRAP_STOP_MARKER"; exit 143' TERM
while :; do sleep 1; done
EOF
chmod +x "$bootstrap_callback"
BOOTSTRAP_STOP_MARKER="$T/bootstrap-stopped" DATA_DIR="$DATA_DIR" \
    HSTUDIO_RUNTIME_BOOTSTRAP=1 TRIM_APPDEST="$TRIM_APPDEST" \
    setsid /bin/bash "$bootstrap_callback" &
bootstrap_pid=$!
for _ in 1 2 3 4 5; do
    bootstrap_started="$(awk '{print $22}' "/proc/$bootstrap_pid/stat" 2>/dev/null || true)"
    [ -n "$bootstrap_started" ] && break
    sleep 1
done
printf '{"status":"running","callbackPid":%s,"callbackStartTime":"%s","callbackDataDir":"%s"}\n' \
    "$bootstrap_pid" "$bootstrap_started" "$DATA_DIR" > "$bootstrap_state_file"
stop_bootstrap_process "$bootstrap_callback"
wait "$bootstrap_pid" 2>/dev/null || true
test -f "$T/bootstrap-stopped"
! kill -0 "$bootstrap_pid" 2>/dev/null

# A Manager-owned npm mutation survives a hard Manager exit unless the fnOS
# stop path drains its verified detached process group. The lock identity must
# match PID start time, app data directory and operation environment exactly.
npm_worker="$T/npm-worker"
cat > "$npm_worker" <<'EOF'
#!/bin/bash
trap 'printf stopped > "$NPM_STOP_MARKER"; exit 0' TERM
while :; do sleep 1; done
EOF
chmod +x "$npm_worker"
operation_id=operation-owned
NPM_STOP_MARKER="$T/npm-stopped" DATA_DIR="$DATA_DIR" HSTUDIO_NPM_OPERATION=1 \
    HSTUDIO_NPM_OPERATION_ID="$operation_id" setsid "$npm_worker" &
npm_pid=$!
for _ in 1 2 3 4 5; do
    npm_started="$(process_start_time "$npm_pid" 2>/dev/null || true)"
    npm_group="$(process_group_id "$npm_pid" 2>/dev/null || true)"
    [ -n "$npm_started" ] && [ "$npm_group" = "$npm_pid" ] && break
    sleep 1
done
printf '{"status":"running","claimToken":"claim-owned","operationId":"%s","dataDir":"%s","childPid":%s,"childStartTime":"%s","processGroupId":%s}\n' \
    "$operation_id" "$DATA_DIR" "$npm_pid" "$npm_started" "$npm_group" > "$npm_operation_lock_file"
stop_npm_operation
wait "$npm_pid" 2>/dev/null || true
test -f "$T/npm-stopped"
test ! -e "$npm_operation_lock_file"

# A reused/lookalike PID must never be signalled or unlocked.
NPM_STOP_MARKER="$T/lookalike-stopped" DATA_DIR="$DATA_DIR" HSTUDIO_NPM_OPERATION=1 \
    HSTUDIO_NPM_OPERATION_ID=other-operation setsid "$npm_worker" &
lookalike_pid=$!
for _ in 1 2 3 4 5; do
    lookalike_started="$(process_start_time "$lookalike_pid" 2>/dev/null || true)"
    lookalike_group="$(process_group_id "$lookalike_pid" 2>/dev/null || true)"
    [ -n "$lookalike_started" ] && [ "$lookalike_group" = "$lookalike_pid" ] && break
    sleep 1
done
printf '{"status":"running","claimToken":"claim-lookalike","operationId":"operation-owned","dataDir":"%s","childPid":%s,"childStartTime":"%s","processGroupId":%s}\n' \
    "$DATA_DIR" "$lookalike_pid" "$lookalike_started" "$lookalike_group" > "$npm_operation_lock_file"
if stop_npm_operation; then
    echo 'lookalike npm process was treated as owned' >&2
    exit 1
fi
kill -0 "$lookalike_pid" 2>/dev/null
test -e "$npm_operation_lock_file"
kill -KILL -- "-$lookalike_group" 2>/dev/null || true
wait "$lookalike_pid" 2>/dev/null || true
rm -f "$npm_operation_lock_file"

# A fully stale running lock with a published child identity is safe to prune.
printf '{"status":"running","claimToken":"claim-stale","operationId":"operation-stale","dataDir":"%s","childPid":999999,"childStartTime":"1","processGroupId":999999}\n' \
    "$DATA_DIR" > "$npm_operation_lock_file"
stop_npm_operation
test ! -e "$npm_operation_lock_file"

# A dead Manager does not make a claiming lock safe to prune: a child may have
# started before its identity could be published. Keep the exact lock closed.
printf '{"status":"claiming","claimToken":"claim-dead-manager","operationId":"operation-dead-manager","dataDir":"%s","managerPid":999999,"managerStartTime":"1"}\n' \
    "$DATA_DIR" > "$npm_operation_lock_file"
if stop_npm_operation; then
    echo 'dead Manager claiming npm lock was silently pruned' >&2
    exit 1
fi
test -e "$npm_operation_lock_file"
grep -Fq '"claimToken":"claim-dead-manager"' "$npm_operation_lock_file"
rm -f "$npm_operation_lock_file"

# Malformed state likewise remains fail-closed for explicit recovery rather
# than authorizing a broad kill or unlock.
printf '%s\n' '{' > "$npm_operation_lock_file"
if stop_npm_operation; then
    echo 'malformed npm operation lock was silently accepted' >&2
    exit 1
fi
test -e "$npm_operation_lock_file"
rm -f "$npm_operation_lock_file"

cat > "$runtime_bundled_root/1.0.0/dist/server/index.js" <<'EOF'
#!/bin/bash
trap 'printf terminated > "$TERM_MARKER"; exit 0' TERM
while :; do sleep 1; done
EOF
chmod +x "$runtime_bundled_root/1.0.0/dist/server/index.js"
TERM_MARKER="$T/term-marker" HERMES_WEB_UI_HOME="$HERMES_WEB_UI_HOME" \
    "$runtime_bundled_root/1.0.0/dist/server/index.js" &
server_pid=$!
printf '%s\n' "$server_pid" > "$process_pid_file"
is_process_running
stop_process_tree
wait "$server_pid" 2>/dev/null || true
test -f "$T/term-marker"
! kill -0 "$server_pid" 2>/dev/null

# A lookalike path outside all package Runtime roots must never be killed.
mkdir -p "$T/unrelated/dist/server"
cp "$runtime_bundled_root/1.0.0/dist/server/index.js" "$T/unrelated/dist/server/index.js"
TERM_MARKER="$T/unrelated-marker" HERMES_WEB_UI_HOME="$HERMES_WEB_UI_HOME" \
    "$T/unrelated/dist/server/index.js" &
unrelated_pid=$!
printf '%s\n' "$unrelated_pid" > "$process_pid_file"
stop_process_tree
kill -0 "$unrelated_pid" 2>/dev/null
test ! -e "$T/unrelated-marker"
kill -KILL "$unrelated_pid" 2>/dev/null || true
wait "$unrelated_pid" 2>/dev/null || true

# If the original PID execs a different program after TERM, the final identity
# check must prevent escalation to KILL even though the numeric PID is unchanged.
cat > "$runtime_bundled_root/1.0.0/dist/server/index.js" <<'EOF'
#!/bin/bash
trap 'exec sleep 30' TERM
while :; do sleep 1; done
EOF
chmod +x "$runtime_bundled_root/1.0.0/dist/server/index.js"
HERMES_WEB_UI_HOME="$HERMES_WEB_UI_HOME" "$runtime_bundled_root/1.0.0/dist/server/index.js" &
reused_pid=$!
printf '%s\n' "$reused_pid" > "$process_pid_file"
stop_process_tree
kill -0 "$reused_pid" 2>/dev/null
test ! -e "$process_pid_file"
kill -KILL "$reused_pid" 2>/dev/null || true
wait "$reused_pid" 2>/dev/null || true

# Exercise the public lifecycle split: studio-* controls the Studio process but
# leaves Manager and its socket intact; fnOS stop shuts both down.
APP="$T/app"
PKGHOME="$T/pkg-home"
PKGVAR="$T/pkg-var"
APP_DATA="$PKGHOME/data"
CALL_LOG="$T/node-calls"
export CALL_LOG
mkdir -p "$APP/manager/backend" "$APP_DATA/manager" "$APP_DATA/hermes-home" \
    "$APP_DATA/.npm-global/bin" "$APP_DATA/.npm-global/lib/node_modules/hermes-web-ui/bin" \
    "$APP_DATA/.npm-global/lib/node_modules/hermes-web-ui/dist/server" "$T/node/bin" "$PKGVAR"

cat > "$APP/manager/backend/server.mjs" <<'EOF'
#!/bin/bash
trap '
if [ -e "$MANAGER_STOP_RACE_MARKER" ]; then
    HERMES_WEB_UI_HOME="$MANAGER_STUDIO_HOME" "$MANAGER_STUDIO_ENTRY" &
    spawned=$!
    printf "%s\n" "$spawned" > "$MANAGER_STUDIO_PID_FILE"
    printf "%s\n" "$spawned" > "$MANAGER_STUDIO_WITNESS"
fi
exit 0
' TERM
while :; do sleep 1; done
EOF
chmod +x "$APP/manager/backend/server.mjs"
MANAGER_STOP_RACE_MARKER="$T/manager-stop-race" \
    MANAGER_STUDIO_HOME="$APP_DATA/hermes-home" \
    MANAGER_STUDIO_ENTRY="$APP_DATA/.npm-global/lib/node_modules/hermes-web-ui/dist/server/index.js" \
    MANAGER_STUDIO_PID_FILE="$APP_DATA/hermes-home/server.pid" \
    MANAGER_STUDIO_WITNESS="$T/manager-spawned-studio.pid" \
    DATA_DIR="$APP_DATA" "$APP/manager/backend/server.mjs" &
manager_pid=$!
printf '%s\n' "$manager_pid" > "$APP_DATA/manager/manager.pid"
: > "$APP/manager.sock"

cat > "$T/node/bin/node" <<'EOF'
#!/bin/sh
if [ "${1:-}" = "--version" ]; then echo v24.15.0; exit 0; fi
if [ "${1:-}" = "-e" ]; then
    if [ "${3:-}" = hstudio-bounded ]; then
        shift 4
        entry="$(readlink -f "$1")"
        root="$(dirname "$(dirname "$entry")")"
        if [ "${2:-}" = --version ] && [ -e "$root/HANG_VERSION" ]; then
            printf '%s\n' "$root" >> "$HANG_VERSION_PROBES"
            sleep 0.1
            exit 124
        fi
        exec "$0" "$@"
    fi
    case "${3:-}" in
        http://*) [ -z "${HEALTH_URL_LOG:-}" ] || printf '%s\n' "$3" >> "$HEALTH_URL_LOG" ;;
    esac
    [ "${FAKE_HEALTH_FAIL:-0}" != 1 ]
    exit $?
fi
entry="$(readlink -f "$1")"
root="$(dirname "$(dirname "$entry")")"
if [ "${2:-}" = "--version" ]; then
    version="$(sed -nE 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$root/package.json" | head -1)"
    echo "hermes-web-ui $version"
    exit 0
fi
printf '%s\n' "${2:-}" >> "$CALL_LOG"
if [ "${2:-}" = start ]; then
    [ -z "${START_PORT_LOG:-}" ] || printf '%s:%s\n' "${3:-}" "${4:-}" >> "$START_PORT_LOG"
    HERMES_WEB_UI_HOME="$HERMES_WEB_UI_HOME" setsid "$root/dist/server/index.js" >/dev/null 2>&1 &
    printf '%s\n' "$!" > "$HERMES_WEB_UI_HOME/server.pid"
elif [ "${2:-}" = stop ]; then
    rm -f "$HERMES_WEB_UI_HOME/server.pid"
fi
exit 0
EOF
chmod +x "$T/node/bin/node"
printf '%s\n' '#!/usr/bin/env node' > "$APP_DATA/.npm-global/lib/node_modules/hermes-web-ui/bin/hermes-web-ui.mjs"
printf '%s\n' '{"name":"hermes-web-ui","version":"7.0.0"}' > "$APP_DATA/.npm-global/lib/node_modules/hermes-web-ui/package.json"
cat > "$APP_DATA/.npm-global/lib/node_modules/hermes-web-ui/dist/server/index.js" <<'EOF'
#!/bin/bash
trap 'exit 0' TERM
while :; do sleep 1; done
EOF
chmod +x "$APP_DATA/.npm-global/lib/node_modules/hermes-web-ui/bin/hermes-web-ui.mjs" \
    "$APP_DATA/.npm-global/lib/node_modules/hermes-web-ui/dist/server/index.js"
ln -s ../lib/node_modules/hermes-web-ui/bin/hermes-web-ui.mjs "$APP_DATA/.npm-global/bin/hermes-web-ui"

HERMES_WEB_UI_HOME="$APP_DATA/hermes-home" \
    "$APP_DATA/.npm-global/lib/node_modules/hermes-web-ui/dist/server/index.js" &
studio_pid=$!
printf '%s\n' "$studio_pid" > "$APP_DATA/hermes-home/server.pid"

# An explicit Studio start is a user request and clears a stale full-stop
# marker left by an earlier fnOS stop.
mkdir -p "$APP_DATA/manager"
: > "$APP_DATA/manager/stopping"

TRIM_APPDEST="$APP" TRIM_PKGHOME="$PKGHOME" TRIM_PKGVAR="$PKGVAR" NODE_ROOT="$T/node" \
    HERMES_WEB_UI_HOME="$APP_DATA/hermes-home" bash "$ROOT/cmd/main" studio-stop
wait "$studio_pid" 2>/dev/null || true
grep -qx stop "$CALL_LOG" || { cat "$PKGVAR/info.log" >&2; cat "$CALL_LOG" >&2; exit 1; }
kill -0 "$manager_pid" 2>/dev/null
test -e "$APP/manager.sock"

TRIM_APPDEST="$APP" TRIM_PKGHOME="$PKGHOME" TRIM_PKGVAR="$PKGVAR" NODE_ROOT="$T/node" \
    HERMES_WEB_UI_HOME="$APP_DATA/hermes-home" TRIM_SERVICE_PORT=9864 \
    START_PORT_LOG="$T/start-port.log" HEALTH_URL_LOG="$T/health-url.log" \
    bash "$ROOT/cmd/main" studio-start
test ! -e "$APP_DATA/manager/stopping"
for _ in 1 2 3 4 5; do grep -qx start "$CALL_LOG" 2>/dev/null && break; sleep 1; done
grep -qx start "$CALL_LOG"
test "$(tail -n 1 "$T/start-port.log")" = '--port:9864'
test "$(tail -n 1 "$T/health-url.log")" = 'http://127.0.0.1:9864/health'
kill -0 "$manager_pid" 2>/dev/null

# Automatic bootstrap/updater restarts must never clear a concurrent fnOS stop
# marker. Ordinary explicit start above is still allowed to clear a stale one.
: > "$APP_DATA/manager/stopping"
if TRIM_APPDEST="$APP" TRIM_PKGHOME="$PKGHOME" TRIM_PKGVAR="$PKGVAR" NODE_ROOT="$T/node" \
    HERMES_WEB_UI_HOME="$APP_DATA/hermes-home" HSTUDIO_MANAGER_UPDATE=1 \
    bash "$ROOT/cmd/main" studio-start; then
    echo 'automatic Studio restart ignored stopping marker' >&2
    exit 1
fi
test -e "$APP_DATA/manager/stopping"
rm -f "$APP_DATA/manager/stopping"

TRIM_APPDEST="$APP" TRIM_PKGHOME="$PKGHOME" TRIM_PKGVAR="$PKGVAR" NODE_ROOT="$T/node" \
    HERMES_WEB_UI_HOME="$APP_DATA/hermes-home" TRIM_SERVICE_PORT=9864 HERMES_PORT=9865 \
    START_PORT_LOG="$T/start-port.log" HEALTH_URL_LOG="$T/health-url.log" \
    bash "$ROOT/cmd/main" studio-restart
test "$(tail -n 1 "$T/start-port.log")" = '--port:9865'
test "$(tail -n 1 "$T/health-url.log")" = 'http://127.0.0.1:9865/health'
kill -0 "$manager_pid" 2>/dev/null

# A durable update journal blocks ordinary starts, but the Manager updater may
# start its own staged Runtime for the post-publish health check. The updater
# must not delete the journal; commit/rollback remains Manager-owned.
: > "$APP_DATA/manager/studio-update-recovery-required"
if TRIM_APPDEST="$APP" TRIM_PKGHOME="$PKGHOME" TRIM_PKGVAR="$PKGVAR" NODE_ROOT="$T/node" \
    HERMES_WEB_UI_HOME="$APP_DATA/hermes-home" bash "$ROOT/cmd/main" studio-start; then
    echo 'ordinary Studio start bypassed update recovery journal' >&2
    exit 1
fi
TRIM_APPDEST="$APP" TRIM_PKGHOME="$PKGHOME" TRIM_PKGVAR="$PKGVAR" NODE_ROOT="$T/node" \
    HERMES_WEB_UI_HOME="$APP_DATA/hermes-home" HSTUDIO_MANAGER_UPDATE=1 \
    bash "$ROOT/cmd/main" studio-start
test -e "$APP_DATA/manager/studio-update-recovery-required"
rm -f "$APP_DATA/manager/studio-update-recovery-required"

# Simulate an in-flight Manager update publishing and starting a new Studio
# after the lifecycle's first Studio stop check but during Manager shutdown.
: > "$T/manager-stop-race"
TRIM_APPDEST="$APP" TRIM_PKGHOME="$PKGHOME" TRIM_PKGVAR="$PKGVAR" NODE_ROOT="$T/node" \
    HERMES_WEB_UI_HOME="$APP_DATA/hermes-home" bash "$ROOT/cmd/main" stop
wait "$manager_pid" 2>/dev/null || true
! kill -0 "$manager_pid" 2>/dev/null
spawned_after_first_stop="$(cat "$T/manager-spawned-studio.pid")"
! kill -0 "$spawned_after_first_stop" 2>/dev/null
test ! -e "$APP/manager.sock"
test -s "$APP_DATA/manager/stopping"

# A Manager crash or failed rollback leaves this marker. fnOS stop/upgrade must
# fail closed instead of replacing adapter files around a half-published npm
# package.
: > "$APP_DATA/manager/studio-update-recovery-required"
if TRIM_APPDEST="$APP" TRIM_PKGHOME="$PKGHOME" TRIM_PKGVAR="$PKGVAR" NODE_ROOT="$T/node" \
    HERMES_WEB_UI_HOME="$APP_DATA/hermes-home" bash "$ROOT/cmd/main" stop; then
    echo 'lifecycle ignored incomplete Studio update recovery' >&2
    exit 1
fi
rm -f "$APP_DATA/manager/studio-update-recovery-required"

# Studio stop must not probe selected/current/previous/legacy candidates: any
# one of their --version commands may hang for its full bound. The running
# process path already identifies the only optional CLI stop entry we need.
for candidate in \
    "$APP_DATA/runtime/studio/8.0.0" \
    "$APP_DATA/runtime/studio/8.0.1" \
    "$APP_DATA/node"; do
    mkdir -p "$candidate/bin" "$candidate/dist/server"
    printf '%s\n' '#!/usr/bin/env node' > "$candidate/bin/hermes-web-ui"
    printf '%s\n' '{"name":"hermes-web-ui","version":"8.0.0"}' > "$candidate/package.json"
    printf '%s\n' '// server' > "$candidate/dist/server/index.js"
    : > "$candidate/HANG_VERSION"
    chmod +x "$candidate/bin/hermes-web-ui"
done
rm -f "$APP_DATA/runtime/studio/current" "$APP_DATA/runtime/studio/previous"
ln -s 8.0.0 "$APP_DATA/runtime/studio/current"
ln -s 8.0.1 "$APP_DATA/runtime/studio/previous"
HERMES_WEB_UI_HOME="$APP_DATA/hermes-home" \
    "$APP_DATA/.npm-global/lib/node_modules/hermes-web-ui/dist/server/index.js" &
studio_pid=$!
printf '%s\n' "$studio_pid" > "$APP_DATA/hermes-home/server.pid"
: > "$T/hanging-version-probes"
SECONDS=0
HANG_VERSION_PROBES="$T/hanging-version-probes" \
    TRIM_APPDEST="$APP" TRIM_PKGHOME="$PKGHOME" TRIM_PKGVAR="$PKGVAR" NODE_ROOT="$T/node" \
    HERMES_WEB_UI_HOME="$APP_DATA/hermes-home" timeout 30 bash "$ROOT/cmd/main" studio-stop
test "$SECONDS" -lt 30
wait "$studio_pid" 2>/dev/null || true
! kill -0 "$studio_pid" 2>/dev/null
test ! -s "$T/hanging-version-probes"

# Upgrade must fail closed when the application cannot be stopped, and must
# expose a useful fnOS lifecycle error instead of silently continuing.
UPGRADE_APP="$T/upgrade-app"
mkdir -p "$UPGRADE_APP/cmd" "$T/upgrade-var"
cp "$ROOT/cmd/upgrade_init" "$UPGRADE_APP/cmd/upgrade_init"
printf '%s\n' '#!/bin/sh' 'exit 7' > "$UPGRADE_APP/cmd/main"
chmod +x "$UPGRADE_APP/cmd/main"
if TRIM_APPDEST="$UPGRADE_APP" TRIM_PKGVAR="$T/upgrade-var" \
    TRIM_TEMP_LOGFILE="$T/upgrade-error.log" bash "$UPGRADE_APP/cmd/upgrade_init"; then
    echo 'upgrade_init unexpectedly ignored stop failure' >&2
    exit 1
fi
grep -Fqx 'HStudio could not stop safely before upgrade' "$T/upgrade-error.log"

for init_name in install_init uninstall_init; do
    INIT_APP="$T/${init_name}-app"
    mkdir -p "$INIT_APP/cmd"
    cp "$ROOT/cmd/$init_name" "$INIT_APP/cmd/$init_name"
    printf '%s\n' '#!/bin/sh' 'exit 7' > "$INIT_APP/cmd/main"
    chmod +x "$INIT_APP/cmd/main"
    if TRIM_APPDEST="$INIT_APP" TRIM_TEMP_LOGFILE="$T/${init_name}-error.log" \
        bash "$INIT_APP/cmd/$init_name"; then
        echo "$init_name unexpectedly ignored stop failure" >&2
        exit 1
    fi
    test -s "$T/${init_name}-error.log"
done

# fnOS status represents the Manager service: Manager-only is running, while a
# surviving Studio after a Manager crash must not mask the failed service.
rm -f "$T/manager-stop-race" "$APP_DATA/manager/manager.pid" \
    "$APP_DATA/hermes-home/server.pid"
DATA_DIR="$APP_DATA" "$APP/manager/backend/server.mjs" &
status_manager_pid=$!
printf '%s\n' "$status_manager_pid" > "$APP_DATA/manager/manager.pid"
TRIM_APPDEST="$APP" TRIM_PKGHOME="$PKGHOME" TRIM_PKGVAR="$PKGVAR" NODE_ROOT="$T/node" \
    HERMES_WEB_UI_HOME="$APP_DATA/hermes-home" bash "$ROOT/cmd/main" status

HERMES_WEB_UI_HOME="$APP_DATA/hermes-home" \
    "$APP_DATA/.npm-global/lib/node_modules/hermes-web-ui/dist/server/index.js" &
status_studio_pid=$!
printf '%s\n' "$status_studio_pid" > "$APP_DATA/hermes-home/server.pid"
kill -KILL "$status_manager_pid"
wait "$status_manager_pid" 2>/dev/null || true
set +e
TRIM_APPDEST="$APP" TRIM_PKGHOME="$PKGHOME" TRIM_PKGVAR="$PKGVAR" NODE_ROOT="$T/node" \
    HERMES_WEB_UI_HOME="$APP_DATA/hermes-home" bash "$ROOT/cmd/main" status
status_rc=$?
set -e
test "$status_rc" -eq 3
kill -0 "$status_studio_pid" 2>/dev/null
kill -TERM "$status_studio_pid" 2>/dev/null || true
wait "$status_studio_pid" 2>/dev/null || true
rm -f "$APP_DATA/hermes-home/server.pid"

echo 'PASS PID identity, bounded cleanup, Manager status and Studio-only lifecycle controls'
