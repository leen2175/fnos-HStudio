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
  if [ "${3:-}" = hstudio-runtime-manifest ]; then
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

# When current changes from an old bundled version to a new one, reconcile must
# stop the actual old process and start the newly selected Runtime.
rm -rf "$DATA/.npm-global"
printf '%s\n' '{"preferredRuntime":"bundled"}' > "$DATA/manager/state.json"
HERMES_WEB_UI_HOME="$DATA/hermes-home" "$BUNDLED_A/dist/server/index.js" &
old_pid=$!
printf '%s\n' "$old_pid" > "$DATA/hermes-home/server.pid"
env "${COMMON[@]}" bash "$APP/cmd/main" bootstrap-complete
wait "$old_pid" 2>/dev/null || true
! kill -0 "$old_pid" 2>/dev/null
for _ in 1 2 3 4 5; do grep -q '^start:' "$CALLS" 2>/dev/null && break; sleep 1; done
grep -Fq "stop:$BUNDLED_A/bin/hermes-web-ui.mjs" "$CALLS"
grep -Fq "start:$BUNDLED_C/bin/hermes-web-ui.mjs" "$CALLS"

env "${COMMON[@]}" bash "$APP/cmd/main" stop

# A dangling current pointer must still start the healthy previous Runtime.
rm -f "$DATA/runtime/studio/current" "$DATA/runtime/studio/previous" "$CALLS"
ln -s missing "$DATA/runtime/studio/current"
ln -s 0.7.15 "$DATA/runtime/studio/previous"
env "${START_COMMON[@]}" bash "$APP/cmd/main" studio-start
for _ in 1 2 3 4 5; do grep -Fq "start:$BUNDLED_A/bin/hermes-web-ui.mjs" "$CALLS" 2>/dev/null && break; sleep 1; done
grep -Fq "start:$BUNDLED_A/bin/hermes-web-ui.mjs" "$CALLS"
test "$(readlink "$DATA/runtime/studio/current")" = 0.7.15
env "${START_COMMON[@]}" bash "$APP/cmd/main" stop

# A later Runtime D can pass CLI health but fail its real HTTP startup. Because
# B was promoted after the previous fallback, D can rotate B into previous and
# the verified startup path still falls back to B, then promotes B again.
make_runtime "$BUNDLED_D" 0.7.17
rm -f "$DATA/runtime/studio/current" "$DATA/runtime/studio/previous" "$CALLS"
ln -s 0.7.17 "$DATA/runtime/studio/current"
ln -s 0.7.15 "$DATA/runtime/studio/previous"
env "${START_COMMON[@]}" HERMES_TEST_START_FAIL_ENTRY="$BUNDLED_D/bin/hermes-web-ui.mjs" \
  bash "$APP/cmd/main" studio-start
grep -Fq "start:$BUNDLED_D/bin/hermes-web-ui.mjs" "$CALLS"
grep -Fq "start:$BUNDLED_A/bin/hermes-web-ui.mjs" "$CALLS"
test "$(readlink "$DATA/runtime/studio/current")" = 0.7.15
env "${START_COMMON[@]}" bash "$APP/cmd/main" stop

# A healthy managed process must only make studio-start idempotent when it is
# the exact selected Runtime. Replace a healthy old B process with selected E.
make_runtime "$BUNDLED_E" 0.7.18
rm -f "$DATA/runtime/studio/current" "$DATA/runtime/studio/previous" "$CALLS"
ln -s 0.7.18 "$DATA/runtime/studio/current"
ln -s 0.7.15 "$DATA/runtime/studio/previous"
HERMES_WEB_UI_HOME="$DATA/hermes-home" "$BUNDLED_A/dist/server/index.js" &
mismatched_pid=$!
printf '%s\n' "$mismatched_pid" > "$DATA/hermes-home/server.pid"
env "${START_COMMON[@]}" bash "$APP/cmd/main" studio-start
wait "$mismatched_pid" 2>/dev/null || true
! kill -0 "$mismatched_pid" 2>/dev/null
grep -Fq "start:$BUNDLED_E/bin/hermes-web-ui.mjs" "$CALLS"
env "${START_COMMON[@]}" bash "$APP/cmd/main" stop

# Replacing an archive with the same package version stores the old tree under
# a unique backup name. If the new tree fails HTTP startup, promote that exact
# healthy previous target rather than resolving the shared semantic version.
make_runtime "$BUNDLED_F" 0.7.19
make_runtime "$BUNDLED_F_BACKUP" 0.7.19
rm -f "$DATA/runtime/studio/current" "$DATA/runtime/studio/previous" "$CALLS"
ln -s 0.7.19 "$DATA/runtime/studio/current"
ln -s 0.7.19.previous.test "$DATA/runtime/studio/previous"
env "${START_COMMON[@]}" HERMES_TEST_START_FAIL_ENTRY="$BUNDLED_F/bin/hermes-web-ui.mjs" \
  bash "$APP/cmd/main" studio-start
grep -Fq "start:$BUNDLED_F/bin/hermes-web-ui.mjs" "$CALLS"
grep -Fq "start:$BUNDLED_F_BACKUP/bin/hermes-web-ui.mjs" "$CALLS"
test "$(readlink "$DATA/runtime/studio/current")" = 0.7.19.previous.test
test "$(readlink "$DATA/runtime/studio/previous")" = 0.7.19

# A later bootstrap of the same manifest version must accept the exact healthy
# current backup. It must not reactivate the failed semantic-version directory
# or restart the already healthy process.
mkdir -p "$APP/config/bootstrap" "$APP/skills"
printf '%s\n' 'HERMES_STUDIO_VERSION=0.7.19' > "$APP/config/bootstrap/hermes-studio-version.env"
printf '%s\n' \
  '{"schema":1,"studio":{"version":"0.7.19","sha256":"0000000000000000000000000000000000000000000000000000000000000000","size":1,"urls":[]}}' \
  > "$APP/config/runtime-manifest.json"
cp -R "$ROOT/.agents/skills/trim-cli" "$APP/skills/trim-cli"
stable_pid="$(cat "$DATA/hermes-home/server.pid")"
calls_before="$(wc -l < "$CALLS")"
env "${START_COMMON[@]}" HSTUDIO_RUNTIME_BOOTSTRAP=1 bash "$APP/cmd/install_callback"
kill -0 "$stable_pid" 2>/dev/null
test "$(cat "$DATA/hermes-home/server.pid")" = "$stable_pid"
test "$(readlink "$DATA/runtime/studio/current")" = 0.7.19.previous.test
test "$(wc -l < "$CALLS")" = "$calls_before"
env "${START_COMMON[@]}" bash "$APP/cmd/main" stop

echo 'PASS bootstrap completion preserves user Runtime and reconciles changed bundled Runtime'
