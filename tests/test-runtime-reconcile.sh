#!/bin/bash
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"
trap 'jobs -pr | xargs -r kill -KILL 2>/dev/null || true; rm -rf "$T"' EXIT

APP="$T/app"
HOME_ROOT="$T/home"
DATA="$HOME_ROOT/data"
NODE_ROOT="$T/node"
CALLS="$T/node-calls"
mkdir -p "$APP" "$DATA/hermes-home" "$DATA/manager" "$NODE_ROOT/bin" "$T/var"
cp -R "$ROOT/cmd" "$APP/cmd"

cat > "$NODE_ROOT/bin/node" <<'EOF'
#!/bin/bash
set -eu
if [ "${1:-}" = --version ]; then echo v24.15.0; exit 0; fi
if [ "${1:-}" = -e ]; then
  if [ "${3:-}" = hstudio-bounded ]; then shift 4; exec "$0" "$@"; fi
  exit 0
fi
case "${1:-}" in
  */manager/backend/server.mjs)
    exec python3 -c '
import os, signal, socket, sys
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
entry="$(readlink -f "$1")"
package_root="$(dirname "$(dirname "$entry")")"
if [ "${2:-}" = --version ]; then
  sed -nE 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/hermes-web-ui \1/p' "$package_root/package.json"
  exit 0
fi
printf '%s:%s\n' "${2:-}" "$entry" >> "$RECONCILE_CALLS"
if [ "${2:-}" = start ]; then
  if [ -n "${HERMES_TEST_START_FAIL_ENTRY:-}" ] \
      && [ "$entry" = "$(readlink -f "$HERMES_TEST_START_FAIL_ENTRY")" ]; then
    exit 0
  fi
  HERMES_WEB_UI_HOME="$HERMES_WEB_UI_HOME" setsid "$package_root/dist/server/index.js" >/dev/null 2>&1 &
  printf '%s\n' "$!" > "$HERMES_WEB_UI_HOME/server.pid"
elif [ "${2:-}" = stop ]; then
  rm -f "$HERMES_WEB_UI_HOME/server.pid"
fi
EOF
chmod +x "$NODE_ROOT/bin/node"
ln -s node "$NODE_ROOT/bin/npm"

mkdir -p "$APP/manager/backend"
cat > "$APP/manager/backend/server.mjs" <<'EOF'
import fs from 'node:fs'
import net from 'node:net'
const socket=process.env.MANAGER_SOCKET
try{fs.unlinkSync(socket)}catch{}
const server=net.createServer(()=>{})
server.listen(socket)
const stop=()=>server.close(()=>process.exit(0))
process.on('SIGTERM',stop)
process.on('SIGINT',stop)
EOF

make_runtime() {
  local root="$1" version="$2"
  mkdir -p "$root/bin" "$root/dist/server"
  printf '%s\n' '#!/usr/bin/env node' > "$root/bin/hermes-web-ui.mjs"
  chmod +x "$root/bin/hermes-web-ui.mjs"
  ln -s hermes-web-ui.mjs "$root/bin/hermes-web-ui"
  printf '{"name":"hermes-web-ui","version":"%s"}\n' "$version" > "$root/package.json"
  cat > "$root/dist/server/index.js" <<'EOF'
#!/bin/bash
trap 'exit 0' TERM
while :; do sleep 1; done
EOF
  chmod +x "$root/dist/server/index.js"
}

USER_PACKAGE="$DATA/.npm-global/lib/node_modules/hermes-web-ui"
BUNDLED_A="$DATA/runtime/studio/0.7.15"
BUNDLED_C="$DATA/runtime/studio/0.7.16"
BUNDLED_D="$DATA/runtime/studio/0.7.17"
BUNDLED_E="$DATA/runtime/studio/0.7.18"
BUNDLED_F="$DATA/runtime/studio/0.7.19"
BUNDLED_F_BACKUP="$DATA/runtime/studio/0.7.19.previous.test"
make_runtime "$USER_PACKAGE" 0.7.15
mkdir -p "$DATA/.npm-global/bin"
ln -s ../lib/node_modules/hermes-web-ui/bin/hermes-web-ui.mjs "$DATA/.npm-global/bin/hermes-web-ui"
make_runtime "$BUNDLED_A" 0.7.15
make_runtime "$BUNDLED_C" 0.7.16
ln -s 0.7.16 "$DATA/runtime/studio/current"

export RECONCILE_CALLS="$CALLS"
COMMON=(TRIM_APPDEST="$APP" TRIM_PKGHOME="$HOME_ROOT" TRIM_PKGVAR="$T/var" NODE_ROOT="$NODE_ROOT" HERMES_WEB_UI_HOME="$DATA/hermes-home" HSTUDIO_BOOTSTRAP_START=1)
START_COMMON=(TRIM_APPDEST="$APP" TRIM_PKGHOME="$HOME_ROOT" TRIM_PKGVAR="$T/var" NODE_ROOT="$NODE_ROOT" HERMES_WEB_UI_HOME="$DATA/hermes-home")

# Refreshing a bundled fallback must not interrupt a healthy preferred
# user-global Studio process.
HERMES_WEB_UI_HOME="$DATA/hermes-home" "$USER_PACKAGE/dist/server/index.js" &
user_pid=$!
printf '%s\n' "$user_pid" > "$DATA/hermes-home/server.pid"
env "${COMMON[@]}" bash "$APP/cmd/main" bootstrap-complete
kill -0 "$user_pid" 2>/dev/null
test ! -s "$CALLS"
kill -TERM "$user_pid" 2>/dev/null || true
wait "$user_pid" 2>/dev/null || true
rm -f "$DATA/hermes-home/server.pid"

# Saved bundled preferences must not select a second local installation.
printf '%s\n' '{"preferredRuntime":"bundled"}' > "$DATA/manager/state.json"
env "${START_COMMON[@]}" bash "$APP/cmd/main" studio-start
grep -Fq "start:$USER_PACKAGE/bin/hermes-web-ui.mjs" "$CALLS"
! grep -Fq "start:$BUNDLED_C/bin/hermes-web-ui.mjs" "$CALLS"
env "${START_COMMON[@]}" bash "$APP/cmd/main" stop

# Keep recognizing old processes for safe shutdown, but never start an old
# archive automatically when the official npm installation is missing.
rm -rf "$DATA/.npm-global"
if env "${START_COMMON[@]}" bash "$APP/cmd/main" studio-start; then
  echo 'unexpected legacy Runtime fallback' >&2
  exit 1
fi
test -d "$BUNDLED_A"
test -d "$BUNDLED_C"
echo 'PASS single npm installation and no local version fallback'
