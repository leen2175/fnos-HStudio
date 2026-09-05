#!/bin/bash
# Test-only Node/Hermes shim. It preserves the command lines and environment
# fields inspected by lifecycle identity checks without starting a real server.
set -u

if [ "${1:-}" = --version ]; then
    echo v24.15.0
    exit 0
fi

if [ "${1:-}" = -e ]; then
    case "${3:-}" in
        hstudio-bounded)
            [ -z "${HERMES_TEST_BOUNDED_LOG:-}" ] || printf '%s\n' "${4:-}" >> "$HERMES_TEST_BOUNDED_LOG"
            shift 4
            exec "$0" "$@"
            ;;
        hstudio-command-bounded)
            [ -z "${HERMES_TEST_BOUNDED_LOG:-}" ] || printf '%s\n' "${4:-}" >> "$HERMES_TEST_BOUNDED_LOG"
            shift 4
            exec "$@"
            ;;
        *) [ "${HERMES_TEST_HEALTH_FAIL:-0}" != 1 ]; exit $? ;;
    esac
fi

case "${1:-}" in
    */manager/backend/server.mjs)
        case "${HERMES_TEST_MANAGER_DELAY:-0}" in
            0) ;;
            *[!0-9.]*) exit 2 ;;
            *) sleep "$HERMES_TEST_MANAGER_DELAY" ;;
        esac
        exec python3 -c '
import os, signal, socket
socket_path=os.environ["MANAGER_SOCKET"]
try: os.unlink(socket_path)
except FileNotFoundError: pass
server=socket.socket(socket.AF_UNIX)
server.bind(socket_path)
server.listen(1)
def stop(*_):
    server.close()
    try: os.unlink(socket_path)
    except FileNotFoundError: pass
    raise SystemExit(0)
signal.signal(signal.SIGTERM,stop)
signal.signal(signal.SIGINT,stop)
while True: signal.pause()
' "$1"
        ;;
esac

entry="$(readlink -f "${1:-}")"
root="$(dirname "$(dirname "$entry")")"
version="$(sed -nE 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' \
    "$root/package.json" 2>/dev/null | head -1)"

if [ "${2:-}" = --version ]; then
    [ -n "$version" ] || exit 8
    echo "hermes-web-ui $version"
    exit 0
fi

case "${2:-}" in
    start)
        server="$root/dist/server/index.js"
        HERMES_WEB_UI_HOME="$HERMES_WEB_UI_HOME" setsid bash -c \
            'trap "exit 0" TERM INT; while :; do sleep 1; done' "$server" \
            >/dev/null 2>&1 &
        printf '%s\n' "$!" > "$HERMES_WEB_UI_HOME/server.pid"
        ;;
    stop)
        rm -f "$HERMES_WEB_UI_HOME/server.pid"
        ;;
esac
