#!/bin/bash
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

export TRIM_APPDEST="$T/app"
export TRIM_PKGHOME="$T/home"
export TRIM_PKGVAR="$T/var"
unset HERMES_AGENT_ROOT HERMES_AGENT_BRIDGE_ENDPOINT HERMES_AGENT_BRIDGE_PYTHON \
    HERMES_AGENT_CLI_PYTHON HERMES_BIN
mkdir -p "$TRIM_PKGHOME/data/hermes-agent/venv/bin"
: > "$TRIM_PKGHOME/data/hermes-agent/venv/bin/python"
: > "$TRIM_PKGHOME/data/hermes-agent/venv/bin/hermes"
chmod +x "$TRIM_PKGHOME/data/hermes-agent/venv/bin/python" \
    "$TRIM_PKGHOME/data/hermes-agent/venv/bin/hermes"

. "$ROOT/cmd/lib/environment.sh"
init_environment

test "$HERMES_AGENT_BRIDGE_ENDPOINT" = "ipc://$TRIM_PKGVAR/hermes-agent-bridge.sock"
test -d "$HERMES_AGENT_BRIDGE_DIR"
test -z "${HERMES_AGENT_BRIDGE_PYTHON+x}"
test -z "${HERMES_AGENT_CLI_PYTHON+x}"
test -z "${HERMES_BIN+x}"
case ":$PATH:" in *":$TRIM_PKGHOME/data/hermes-agent/venv/bin:"*) exit 1 ;; esac

unset TRIM_PKGVAR HERMES_AGENT_BRIDGE_ENDPOINT HERMES_AGENT_BRIDGE_PYTHON \
    HERMES_AGENT_CLI_PYTHON HERMES_BIN
init_environment
test "$HERMES_AGENT_BRIDGE_ENDPOINT" = "ipc://$TRIM_PKGHOME/data/run/hermes-agent-bridge.sock"
test -d "$TRIM_PKGHOME/data/run"

export HERMES_AGENT_BRIDGE_ENDPOINT='ipc:///custom/bridge.sock'
export HERMES_AGENT_BRIDGE_PYTHON='/custom/python'
export HERMES_AGENT_CLI_PYTHON='/custom/cli-python'
export HERMES_BIN='/custom/hermes'
init_environment

test "$HERMES_AGENT_BRIDGE_ENDPOINT" = 'ipc:///custom/bridge.sock'
test "$HERMES_AGENT_BRIDGE_PYTHON" = '/custom/python'
test "$HERMES_AGENT_CLI_PYTHON" = '/custom/cli-python'
test "$HERMES_BIN" = '/custom/hermes'

echo 'PASS Hermes Studio Runtime bridge environment'
