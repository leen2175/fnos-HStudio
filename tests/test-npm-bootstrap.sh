#!/bin/bash
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "${T:?}"' EXIT
mkdir -p "$T/node/bin" "$T/home/data/manager" "$T/var" "$T/skills"
cp -R "$ROOT/cmd" "$T/cmd"
cp -R "$ROOT/.agents/skills/trim-cli" "$T/skills/trim-cli"
cp "$ROOT/tests/helpers/fake-node.sh" "$T/node/bin/node"
# Prevent the bootstrap handoff from starting a server in this portable test.
touch "$T/home/data/manager/stopping"
printf '%s\n' '{"id":"taobao","url":"https://registry.npmmirror.com/"}' > "$T/home/data/manager/npm-registry.json"
cat > "$T/node/bin/npm" <<'EOF'
#!/bin/bash
set -eu
printf '%s\n' "$*" >> "$TRIM_PKGHOME/npm-calls"
if [ "$1" = view ]; then
  [[ "$*" == *--registry=https://registry.npmjs.org/* ]]
  echo "${TEST_LATEST:-9.8.7}"
  exit 0
fi
[ "$npm_config_prefix" = "$TRIM_PKGHOME/data/.npm-global" ]
[[ "$*" == *hermes-web-ui@9.8.7* ]]
[[ "$*" == *--registry=https://registry.npmmirror.com/* ]]
[ "${TEST_INSTALL_FAIL:-0}" != 1 ] || exit 1
root="$npm_config_prefix/lib/node_modules/hermes-web-ui"
mkdir -p "$npm_config_prefix/bin" "$root/bin" "$root/dist/server"
printf '%s\n' '#!/usr/bin/env node' > "$root/bin/hermes-web-ui.mjs"
printf '%s\n' '{"name":"hermes-web-ui","version":"9.8.7"}' > "$root/package.json"
printf '%s\n' '// server' > "$root/dist/server/index.js"
chmod +x "$root/bin/hermes-web-ui.mjs"
ln -sf ../lib/node_modules/hermes-web-ui/bin/hermes-web-ui.mjs "$npm_config_prefix/bin/hermes-web-ui"
EOF
chmod +x "$T/node/bin/node" "$T/node/bin/npm"
export TRIM_APPDEST="$T" TRIM_PKGHOME="$T/home" TRIM_PKGVAR="$T/var" NODE_ROOT="$T/node" HSTUDIO_RUNTIME_BOOTSTRAP=1
# No locked version metadata is provided. An invalid official response fails
# closed before install; a network/install failure remains safely retryable.
if TEST_LATEST=invalid bash "$T/cmd/install_callback"; then exit 1; fi
! grep -q '^install ' "$T/home/npm-calls"
if TEST_INSTALL_FAIL=1 bash "$T/cmd/install_callback"; then exit 1; fi
bash "$T/cmd/install_callback"
test -x "$T/home/data/.npm-global/bin/hermes-web-ui"
test ! -e "$T/home/data/runtime/studio"
grep -q '"status":"success"' "$T/home/data/manager/runtime-bootstrap.json"
calls="$(wc -l < "$T/home/npm-calls")"
# Restart/bootstrap must not force a version change or touch a healthy install.
TEST_LATEST=1.0.0 bash "$T/cmd/install_callback"
test "$(wc -l < "$T/home/npm-calls")" = "$calls"
echo 'PASS official latest npm bootstrap, mirror transport, retry, preservation'
