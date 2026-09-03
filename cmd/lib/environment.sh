#!/bin/bash
# Shared fnOS environment. Source this from lifecycle scripts and manager.

resolve_data_dir() {
    if [ -n "${DATA_DIR:-}" ]; then printf '%s\n' "$DATA_DIR"; return; fi
    if [ -n "${TRIM_PKGHOME:-}" ]; then printf '%s/data\n' "$TRIM_PKGHOME"; return; fi
    printf '%s\n' "${HOME:-/tmp}/HStudio-data"
}

resolve_node_root() {
    local c node_version node_major
    local -a candidates
    if [ -n "${NODE_ROOT:-}" ]; then
        candidates=("$NODE_ROOT")
    else
        candidates=(/var/apps/nodejs_v24/target /var/apps/nodejs_v24)
    fi
    for c in "${candidates[@]}"; do
        [ -x "$c/bin/node" ] || continue
        node_version="$("$c/bin/node" --version 2>/dev/null || true)"
        node_major="$(printf '%s\n' "$node_version" | sed -nE 's/^v([0-9]+).*$/\1/p')"
        [ "${node_major:-0}" = 24 ] && { printf '%s\n' "$c"; return 0; }
    done
    return 1
}

resolve_python_root() {
    local c python_bin python_version python_minor
    local -a candidates
    if [ -n "${PYTHON_ROOT:-}" ]; then
        candidates=("$PYTHON_ROOT")
    else
        candidates=(/var/apps/python312/target /var/apps/python312)
    fi
    for c in "${candidates[@]}"; do
        python_bin=""
        [ -x "$c/bin/python3" ] && python_bin="$c/bin/python3"
        [ -z "$python_bin" ] && [ -x "$c/bin/python" ] && python_bin="$c/bin/python"
        [ -n "$python_bin" ] || continue
        python_version="$("$python_bin" --version 2>&1 || true)"
        python_minor="$(printf '%s\n' "$python_version" | sed -nE 's/^Python 3\.([0-9]+).*$/\1/p')"
        case "$python_minor" in
            11|12|13) printf '%s\n' "$c"; return 0 ;;
        esac
    done
    return 1
}

init_environment() {
    DATA_DIR="$(resolve_data_dir)"
    NODE_ROOT="$(resolve_node_root 2>/dev/null || true)"
    NODE_BIN="${NODE_ROOT:+$NODE_ROOT/bin/node}"
    NPM_BIN="${NODE_ROOT:+$NODE_ROOT/bin/npm}"
    PYTHON_ROOT="$(resolve_python_root 2>/dev/null || true)"
    PYTHON_BIN=""
    if [ -n "$PYTHON_ROOT" ]; then
        [ -x "$PYTHON_ROOT/bin/python3" ] && PYTHON_BIN="$PYTHON_ROOT/bin/python3"
        [ -z "$PYTHON_BIN" ] && [ -x "$PYTHON_ROOT/bin/python" ] && PYTHON_BIN="$PYTHON_ROOT/bin/python"
    fi
    NPM_GLOBAL="${DATA_DIR}/.npm-global"
    HSTUDIO_TOOLS_BIN="${DATA_DIR}/tools/bin"
    TRIM_CLI_BIN="${HSTUDIO_TOOLS_BIN}/trim-cli"
    TRIM_CLI_CONFIG_DIR="${DATA_DIR}/trim-cli"
    HERMES_WEB_UI_SKILLS_DIR="${DATA_DIR}/manager/hermes-skills-source"
    HERMES_AGENT_ROOT="${HERMES_AGENT_ROOT:-${DATA_DIR}/hermes-agent}"
    HERMES_AGENT_BRIDGE_DIR="${TRIM_PKGVAR:-${DATA_DIR}/run}"
    HERMES_AGENT_BRIDGE_ENDPOINT="${HERMES_AGENT_BRIDGE_ENDPOINT:-ipc://${HERMES_AGENT_BRIDGE_DIR}/hermes-agent-bridge.sock}"
    hermes_agent_python="${HERMES_AGENT_ROOT}/venv/bin/python"
    hermes_agent_bin="${HERMES_AGENT_ROOT}/venv/bin/hermes"
    if [ -x "$hermes_agent_python" ]; then
        HERMES_AGENT_BRIDGE_PYTHON="${HERMES_AGENT_BRIDGE_PYTHON:-$hermes_agent_python}"
        HERMES_AGENT_CLI_PYTHON="${HERMES_AGENT_CLI_PYTHON:-$hermes_agent_python}"
    fi
    if [ -x "$hermes_agent_bin" ]; then
        HERMES_BIN="${HERMES_BIN:-$hermes_agent_bin}"
    fi
    HSTUDIO_SKILLS_DIR=""
    for candidate in "${TRIM_APPDEST:-}/skills" "${TRIM_APPDEST:-}/app/skills" \
        "${TRIM_APPDEST:-}/.agents/skills"; do
        if [ -f "$candidate/trim-cli/SKILL.md" ]; then
            HSTUDIO_SKILLS_DIR="$candidate"
            break
        fi
    done
    export DATA_DIR NODE_ROOT NODE_BIN NPM_BIN PYTHON_ROOT PYTHON_BIN NPM_GLOBAL HSTUDIO_TOOLS_BIN
    export TRIM_CLI_BIN TRIM_CLI_CONFIG_DIR HSTUDIO_SKILLS_DIR HERMES_WEB_UI_SKILLS_DIR
    export HERMES_AGENT_ROOT HERMES_AGENT_BRIDGE_DIR HERMES_AGENT_BRIDGE_ENDPOINT
    [ -z "${HERMES_AGENT_BRIDGE_PYTHON:-}" ] || export HERMES_AGENT_BRIDGE_PYTHON
    [ -z "${HERMES_AGENT_CLI_PYTHON:-}" ] || export HERMES_AGENT_CLI_PYTHON
    [ -z "${HERMES_BIN:-}" ] || export HERMES_BIN
    export HOME="${DATA_DIR}"
    export HERMES_WEB_UI_HOME="${HERMES_WEB_UI_HOME:-${DATA_DIR}/hermes-home}"
    export HERMES_HOME="${HERMES_HOME:-${DATA_DIR}/hermes-home}"
    export npm_config_prefix="${NPM_GLOBAL}" NPM_CONFIG_PREFIX="${NPM_GLOBAL}"
    export npm_config_cache="${DATA_DIR}/.npm-cache" NPM_CONFIG_CACHE="${DATA_DIR}/.npm-cache"
    NPM_REGISTRY="https://registry.npmjs.org/"
    if [ -r "${DATA_DIR}/manager/npm-registry.json" ]; then
        configured_registry="$(sed -nE 's/.*"url"[[:space:]]*:[[:space:]]*"(https:\/\/[^" ]+)".*/\1/p' "${DATA_DIR}/manager/npm-registry.json" | head -1)"
        case "$configured_registry" in
            https://registry.npmjs.org/|https://registry.npmmirror.com/|https://mirrors.cloud.tencent.com/npm/) NPM_REGISTRY="$configured_registry" ;;
        esac
    fi
    export NPM_REGISTRY npm_config_registry="${NPM_REGISTRY}" NPM_CONFIG_REGISTRY="${NPM_REGISTRY}"
    export PATH="${NPM_GLOBAL}/bin:${HSTUDIO_TOOLS_BIN}:${HERMES_AGENT_ROOT}/venv/bin:${NODE_ROOT:+$NODE_ROOT/bin}:${PYTHON_ROOT:+$PYTHON_ROOT/bin}:${BUNDLED_RUNTIME_BIN:-}:${PATH:-/usr/local/bin:/usr/bin:/bin}"
    runtime_user_bin="${NPM_GLOBAL}/bin/hermes-web-ui"
    runtime_bundled_root="${DATA_DIR}/runtime/studio"
    runtime_state_file="${DATA_DIR}/manager/state.json"
    process_pid_file="${HERMES_WEB_UI_HOME}/server.pid"
    mkdir -p "$NPM_GLOBAL/bin" "$NPM_GLOBAL/lib/node_modules" "$npm_config_cache" \
        "$DATA_DIR/runtime/studio" "$DATA_DIR/manager" "$HERMES_WEB_UI_HOME" \
        "$HSTUDIO_TOOLS_BIN" "$TRIM_CLI_CONFIG_DIR" "$HERMES_AGENT_ROOT" \
        "$HERMES_AGENT_BRIDGE_DIR"
    chmod 700 "$TRIM_CLI_CONFIG_DIR" "$HERMES_AGENT_ROOT" "$HERMES_AGENT_BRIDGE_DIR" 2>/dev/null || true
}

json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
