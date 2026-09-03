#!/bin/bash
process_pid_file="${DATA_DIR:-${HOME:-/tmp}}/hermes-home/server.pid"
bootstrap_state_file="${DATA_DIR:-${HOME:-/tmp}}/manager/runtime-bootstrap.json"
npm_operation_lock_file="${DATA_DIR:-${HOME:-/tmp}}/manager/npm-operation.json"
process_start_time() {
    local pid="$1"
    [ -r "/proc/$pid/stat" ] || return 1
    sed 's/^.*) //' "/proc/$pid/stat" 2>/dev/null | awk '{print $20}'
}

process_group_id() {
    local pid="$1"
    [ -r "/proc/$pid/stat" ] || return 1
    sed 's/^.*) //' "/proc/$pid/stat" 2>/dev/null | awk '{print $3}'
}

process_home_matches() {
    local pid="$1" expected="HERMES_WEB_UI_HOME=${HERMES_WEB_UI_HOME:-${DATA_DIR:-${HOME:-/tmp}}/hermes-home}"
    [ -r "/proc/$pid/environ" ] || return 1
    tr '\0' '\n' 2>/dev/null < "/proc/$pid/environ" | grep -Fqx -- "$expected"
}

process_runtime_server_path() {
    local pid="$1" arg
    [ -r "/proc/$pid/cmdline" ] || return 1
    while IFS= read -r arg; do
        case "$arg" in
            "${NPM_GLOBAL:-${DATA_DIR:-${HOME:-/tmp}}/.npm-global}"/lib/node_modules/hermes-web-ui/dist/server/index.js|\
            "${runtime_bundled_root:-${DATA_DIR:-${HOME:-/tmp}}/runtime/studio}"/*/dist/server/index.js|\
            "${runtime_legacy_root:-${DATA_DIR:-${HOME:-/tmp}}/node}"/dist/server/index.js|\
            "${runtime_legacy_root:-${DATA_DIR:-${HOME:-/tmp}}/node}"/lib/node_modules/hermes-web-ui/dist/server/index.js)
                printf '%s\n' "$arg"
                return 0
                ;;
        esac
    done < <(tr '\0' '\n' 2>/dev/null < "/proc/$pid/cmdline")
    return 1
}

process_runtime_path_matches() { process_runtime_server_path "$1" >/dev/null; }

process_runtime_entry() {
    local pid="$1" server root entry
    server="$(process_runtime_server_path "$pid" 2>/dev/null || true)"
    [ -n "$server" ] || return 1
    root="${server%/dist/server/index.js}"
    for entry in "$root/bin/hermes-web-ui" "$root/bin/hermes-web-ui.mjs"; do
        [ -f "$entry" ] && [ -r "$entry" ] || continue
        printf '%s\n' "$entry"
        return 0
    done
    return 1
}

process_matches() {
    local pid="$1"
    case "$pid" in ""|*[!0-9]*) return 1 ;; esac
    kill -0 "$pid" 2>/dev/null || return 1
    process_home_matches "$pid" && process_runtime_path_matches "$pid"
}

process_matches_snapshot() {
    local pid="$1" started="$2" current
    process_matches "$pid" || return 1
    current="$(process_start_time "$pid" 2>/dev/null || true)"
    [ -n "$started" ] && [ "$current" = "$started" ]
}

signal_process_scope() {
    local signal="$1" pid="$2" group
    group="$(process_group_id "$pid" 2>/dev/null || true)"
    if [ "$group" = "$pid" ]; then
        kill "-$signal" -- "-$pid" 2>/dev/null
    else
        kill "-$signal" "$pid" 2>/dev/null
    fi
}

read_process_pid() { [ -r "$process_pid_file" ] && sed -n '1p' "$process_pid_file" | grep -E '^[0-9]+$'; }
is_process_running() {
    local p
    p="$(read_process_pid 2>/dev/null || true)"
    [ -n "$p" ] || return 1
    if process_matches "$p"; then return 0; fi
    rm -f "$process_pid_file"
    return 1
}
stop_process_tree() {
    local p started
    p="${1:-$(read_process_pid 2>/dev/null || true)}"
    [ -n "$p" ] || return 0
    started="$(process_start_time "$p" 2>/dev/null || true)"
    process_matches_snapshot "$p" "$started" || { rm -f "$process_pid_file"; return 0; }
    signal_process_scope TERM "$p" || true
    for _ in 1 2 3 4 5; do
        process_matches_snapshot "$p" "$started" || break
        sleep 1
    done
    # The PID may have exited and been reused, or exec'd another program, while
    # we waited. Never escalate unless identity and start time still match.
    if process_matches_snapshot "$p" "$started"; then
        signal_process_scope KILL "$p" || true
        for _ in 1 2 3 4 5; do
            process_matches_snapshot "$p" "$started" || break
            sleep 1
        done
    fi
    if process_matches_snapshot "$p" "$started"; then
        return 1
    fi
    rm -f "$process_pid_file"
}

bootstrap_state_value() {
    local key="$1"
    [ -r "$bootstrap_state_file" ] || return 1
    sed -nE "s/.*\"${key}\"[[:space:]]*:[[:space:]]*(\"([^\"]*)\"|([0-9]+)).*/\2\3/p" \
        "$bootstrap_state_file" | head -1
}

bootstrap_process_matches() {
    local pid="$1" expected_callback="$2" started state_data arg found=1
    case "$pid" in ""|*[!0-9]*) return 1 ;; esac
    [ "$pid" -gt 1 ] 2>/dev/null || return 1
    kill -0 "$pid" 2>/dev/null || return 1
    started="$(bootstrap_state_value callbackStartTime 2>/dev/null || true)"
    state_data="$(bootstrap_state_value callbackDataDir 2>/dev/null || true)"
    [ -n "$started" ] && [ "$started" = "$(process_start_time "$pid" 2>/dev/null || true)" ] || return 1
    [ -n "$state_data" ] && [ "$state_data" = "${DATA_DIR:-}" ] || return 1
    [ -r "/proc/$pid/cmdline" ] && [ -r "/proc/$pid/environ" ] || return 1
    while IFS= read -r arg; do
        if [ "$arg" = "$expected_callback" ]; then found=0; break; fi
    done < <(tr '\0' '\n' 2>/dev/null < "/proc/$pid/cmdline")
    [ "$found" -eq 0 ] || return 1
    tr '\0' '\n' 2>/dev/null < "/proc/$pid/environ" | grep -Fqx -- "DATA_DIR=${DATA_DIR}" || return 1
    tr '\0' '\n' 2>/dev/null < "/proc/$pid/environ" | grep -Fqx -- 'HSTUDIO_RUNTIME_BOOTSTRAP=1' || return 1
    tr '\0' '\n' 2>/dev/null < "/proc/$pid/environ" | grep -Fqx -- "TRIM_APPDEST=${TRIM_APPDEST}" || return 1
}

stop_bootstrap_process() {
    local expected_callback="$1" pid started group
    pid="$(bootstrap_state_value callbackPid 2>/dev/null || true)"
    [ -n "$pid" ] || return 0
    started="$(process_start_time "$pid" 2>/dev/null || true)"
    bootstrap_process_matches "$pid" "$expected_callback" || return 0
    group="$(process_group_id "$pid" 2>/dev/null || true)"
    if [ "$group" = "$pid" ]; then
        kill -TERM -- "-$pid" 2>/dev/null || true
    else
        kill -TERM "$pid" 2>/dev/null || true
    fi
    # The callback EXIT trap may be removing a several-hundred-megabyte exact
    # staging directory on a slow NAS. Let that verified cleanup finish before
    # escalating the same process identity/group to KILL.
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
        bootstrap_process_matches "$pid" "$expected_callback" || return 0
        [ "$(process_start_time "$pid" 2>/dev/null || true)" = "$started" ] || return 0
        sleep 1
    done
    if bootstrap_process_matches "$pid" "$expected_callback" \
        && [ "$(process_start_time "$pid" 2>/dev/null || true)" = "$started" ]; then
        if [ "$group" = "$pid" ]; then
            kill -KILL -- "-$pid" 2>/dev/null || true
        else
            kill -KILL "$pid" 2>/dev/null || true
        fi
    fi
    for _ in 1 2 3 4 5; do
        bootstrap_process_matches "$pid" "$expected_callback" || return 0
        sleep 1
    done
    bootstrap_process_matches "$pid" "$expected_callback" && return 1
    return 0
}

npm_operation_value() {
    local key="$1" value
    [ -r "$npm_operation_lock_file" ] || return 1
    value="$(sed -nE "s/.*\"${key}\"[[:space:]]*:[[:space:]]*\"([^\"]*)\".*/\\1/p" \
        "$npm_operation_lock_file" | head -1)"
    if [ -z "$value" ]; then
        value="$(sed -nE "s/.*\"${key}\"[[:space:]]*:[[:space:]]*([0-9]+).*/\\1/p" \
            "$npm_operation_lock_file" | head -1)"
    fi
    [ -n "$value" ] || return 1
    printf '%s\n' "$value"
}

npm_operation_process_matches() {
    local pid="$1" started="$2" operation_id="$3" expected_group="$4"
    local current_group
    case "$pid:$expected_group" in
        *[!0-9:]*|:*|*:) return 1 ;;
    esac
    [ "$pid" -gt 1 ] 2>/dev/null && [ "$expected_group" = "$pid" ] || return 1
    kill -0 "$pid" 2>/dev/null || return 1
    [ "$(process_start_time "$pid" 2>/dev/null || true)" = "$started" ] || return 1
    current_group="$(process_group_id "$pid" 2>/dev/null || true)"
    [ "$current_group" = "$expected_group" ] || return 1
    [ -r "/proc/$pid/environ" ] || return 1
    tr '\0' '\n' 2>/dev/null < "/proc/$pid/environ" | grep -Fqx -- "DATA_DIR=${DATA_DIR}" || return 1
    tr '\0' '\n' 2>/dev/null < "/proc/$pid/environ" | grep -Fqx -- 'HSTUDIO_NPM_OPERATION=1' || return 1
    tr '\0' '\n' 2>/dev/null < "/proc/$pid/environ" | grep -Fqx -- \
        "HSTUDIO_NPM_OPERATION_ID=${operation_id}"
}

npm_operation_lock_unchanged() {
    local token="$1" operation_id="$2"
    [ "$(npm_operation_value claimToken 2>/dev/null || true)" = "$token" ] \
        && [ "$(npm_operation_value operationId 2>/dev/null || true)" = "$operation_id" ]
}

stop_npm_operation() {
    local status data_dir pid started operation_id group token
    [ -e "$npm_operation_lock_file" ] || return 0
    status="$(npm_operation_value status 2>/dev/null || true)"
    data_dir="$(npm_operation_value dataDir 2>/dev/null || true)"
    operation_id="$(npm_operation_value operationId 2>/dev/null || true)"
    token="$(npm_operation_value claimToken 2>/dev/null || true)"
    [ "$data_dir" = "${DATA_DIR}" ] && [ -n "$operation_id" ] && [ -n "$token" ] || return 1
    if [ "$status" = claiming ]; then
        # Claiming is the crash window between publishing the lock and
        # publishing a verifiable child identity. The Manager being gone does
        # not prove that no npm child survived, so preserve the lock for
        # explicit recovery instead of reopening an orphan-operation window.
        return 1
    fi
    [ "$status" = running ] || return 1
    pid="$(npm_operation_value childPid 2>/dev/null || true)"
    started="$(npm_operation_value childStartTime 2>/dev/null || true)"
    group="$(npm_operation_value processGroupId 2>/dev/null || true)"
    if npm_operation_process_matches "$pid" "$started" "$operation_id" "$group"; then
        kill -TERM -- "-$group" 2>/dev/null || true
        for _ in 1 2 3 4 5; do
            npm_operation_process_matches "$pid" "$started" "$operation_id" "$group" || break
            sleep 1
        done
        if npm_operation_process_matches "$pid" "$started" "$operation_id" "$group"; then
            kill -KILL -- "-$group" 2>/dev/null || true
            for _ in 1 2 3 4 5; do
                npm_operation_process_matches "$pid" "$started" "$operation_id" "$group" || break
                sleep 1
            done
        fi
    elif kill -0 "$pid" 2>/dev/null; then
        # The numeric PID is live but its identity no longer matches. Never
        # signal or unlock a possibly unrelated process.
        return 1
    fi
    npm_operation_process_matches "$pid" "$started" "$operation_id" "$group" && return 1
    if kill -0 -- "-$group" 2>/dev/null; then
        # The verified leader is gone but descendants remain. Without their
        # original identity snapshot, fail closed instead of killing broadly.
        return 1
    fi
    npm_operation_lock_unchanged "$token" "$operation_id" || return 1
    rm -f "$npm_operation_lock_file"
}
