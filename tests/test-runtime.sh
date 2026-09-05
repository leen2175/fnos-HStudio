#!/bin/bash
set -eu
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
export DATA_DIR="$T/data" HOME="$T/data" NODE_ROOT=""
mkdir -p "$DATA_DIR/.npm-global/bin" \
  "$DATA_DIR/.npm-global/lib/node_modules/hermes-web-ui/bin" \
  "$DATA_DIR/.npm-global/lib/node_modules/hermes-web-ui/dist/server" \
  "$DATA_DIR/runtime/studio/1.0.0/bin" "$DATA_DIR/runtime/studio/1.0.0/dist/server"
cat > "$T/node" <<'EOF'
#!/bin/sh
if [ "${1:-}" = -e ] && [ "${3:-}" = hstudio-bounded ]; then
    shift 4
    exec "$0" "$@"
fi
if [ "${2:-}" = --version ] && [ "${HERMES_TEST_TIMEOUT_BUNDLED:-0}" = 1 ]; then
    case "$1" in
        "$DATA_DIR"/runtime/studio/*)
            printf '%s\n' "$1" >> "$HERMES_TEST_BUNDLED_PROBES"
            exit 124
            ;;
    esac
fi
echo 'hermes-web-ui 9.9.9'
EOF
chmod +x "$T/node"
export NODE_BIN="$T/node"
cat > "$DATA_DIR/.npm-global/lib/node_modules/hermes-web-ui/bin/hermes-web-ui.mjs" <<'EOF'
#!/bin/sh
echo 'hermes-web-ui 9.9.9'
EOF
printf '%s\n' '{"name":"hermes-web-ui","version":"9.9.9"}' > \
  "$DATA_DIR/.npm-global/lib/node_modules/hermes-web-ui/package.json"
printf '%s\n' '// server' > "$DATA_DIR/.npm-global/lib/node_modules/hermes-web-ui/dist/server/index.js"
ln -s ../lib/node_modules/hermes-web-ui/bin/hermes-web-ui.mjs "$DATA_DIR/.npm-global/bin/hermes-web-ui"
cp "$DATA_DIR/.npm-global/lib/node_modules/hermes-web-ui/bin/hermes-web-ui.mjs" \
  "$DATA_DIR/runtime/studio/1.0.0/bin/hermes-web-ui"
printf '%s\n' '{"name":"hermes-web-ui","version":"9.9.9"}' > "$DATA_DIR/runtime/studio/1.0.0/package.json"
printf '%s\n' '// server' > "$DATA_DIR/runtime/studio/1.0.0/dist/server/index.js"
ln -s 1.0.0 "$DATA_DIR/runtime/studio/current"
chmod +x "$DATA_DIR/.npm-global/lib/node_modules/hermes-web-ui/bin/hermes-web-ui.mjs" \
  "$DATA_DIR/runtime/studio/1.0.0/bin/hermes-web-ui"
. "$(dirname "$0")/../cmd/lib/environment.sh"
. "$(dirname "$0")/../cmd/lib/runtime.sh"

# A declared nodejs_v24 dependency must never silently select an older Node or
# an unrelated PATH installation. NODE_ROOT remains injectable for tests, but
# it is accepted only when the binary reports major version 24.
mkdir -p "$T/node23/bin" "$T/node24/bin"
printf '%s\n' '#!/bin/sh' 'echo v23.11.0' > "$T/node23/bin/node"
printf '%s\n' '#!/bin/sh' 'echo v24.15.0' > "$T/node24/bin/node"
chmod +x "$T/node23/bin/node" "$T/node24/bin/node"
NODE_ROOT="$T/node23"
if resolve_node_root >/dev/null 2>&1; then
  echo 'nodejs_v23 was incorrectly accepted' >&2
  exit 1
fi
NODE_ROOT="$T/node24"
[ "$(resolve_node_root)" = "$T/node24" ]
NODE_ROOT=""

# Hermes Agent uses the fnOS Python runtime only when it is within the
# upstream-supported 3.11-3.13 range. The package dependency is python312.
mkdir -p "$T/python310/bin" "$T/python312/bin" "$T/python314/bin"
printf '%s\n' '#!/bin/sh' 'echo Python 3.10.14' > "$T/python310/bin/python3"
printf '%s\n' '#!/bin/sh' 'echo Python 3.12.11' > "$T/python312/bin/python3"
printf '%s\n' '#!/bin/sh' 'echo Python 3.14.0' > "$T/python314/bin/python3"
chmod +x "$T/python310/bin/python3" "$T/python312/bin/python3" "$T/python314/bin/python3"
PYTHON_ROOT="$T/python310"
if resolve_python_root >/dev/null 2>&1; then
  echo 'python3.10 was incorrectly accepted' >&2
  exit 1
fi
PYTHON_ROOT="$T/python312"
[ "$(resolve_python_root)" = "$T/python312" ]
PYTHON_ROOT="$T/python314"
if resolve_python_root >/dev/null 2>&1; then
  echo 'python3.14 was incorrectly accepted' >&2
  exit 1
fi
PYTHON_ROOT=""

NPM_GLOBAL="$DATA_DIR/.npm-global"; runtime_user_bin="$NPM_GLOBAL/bin/hermes-web-ui"; runtime_bundled_root="$DATA_DIR/runtime/studio"
export NPM_GLOBAL
health_check_runtime "$runtime_user_bin" || { echo user health failed; exit 1; }
select_runtime auto; [ "$RUNTIME_SOURCE" = user-global ]
# A bounded-out bundled probe must not delay or obscure a healthy user Runtime
# in auto/user-global modes. The fixture records a simulated timeout if the
# bundled CLI is touched at all.
: > "$T/bundled-probes"
HERMES_TEST_BUNDLED_PROBES="$T/bundled-probes" HERMES_TEST_TIMEOUT_BUNDLED=1 \
  select_runtime auto
[ "$RUNTIME_SOURCE" = user-global ]
test ! -s "$T/bundled-probes"
# Old saved preferences and even healthy archived copies are not candidates.
mkdir -p "$DATA_DIR/manager"
printf '%s\n' '{"preferredRuntime":"bundled"}' > "$DATA_DIR/manager/state.json"
select_runtime
[ "$RUNTIME_SOURCE" = user-global ]
rm -f "$runtime_user_bin"
if select_runtime; then
  echo 'unexpected fallback to a locally managed version' >&2
  exit 1
fi
test -d "$DATA_DIR/runtime/studio/1.0.0"
echo PASS
