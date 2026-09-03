#!/bin/bash
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(sed -n 's/^HERMES_STUDIO_VERSION=//p' "$ROOT/config/bootstrap/hermes-studio-version.env")"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

make_fixture() {
    rm -rf "${T:?}/app" "${T:?}/home" "${T:?}/var" "${T:?}/node" "${T:?}/network-used"
    mkdir -p "$T/app/config/bootstrap" "$T/app/config" "$T/app/skills" "$T/app/runtime" \
        "$T/app/manager/backend" "$T/home" "$T/var" "$T/node/bin"
    cp -R "$ROOT/cmd" "$T/app/cmd"
    cp -R "$ROOT/.agents/skills/trim-cli" "$T/app/skills/trim-cli"
    cp "$ROOT/config/bootstrap/hermes-studio-version.env" "$T/app/config/bootstrap/hermes-studio-version.env"
    cp "$ROOT/config/runtime-manifest.json" "$T/app/config/runtime-manifest.json"
    printf '%s' 'archive-must-not-be-read' > "$T/app/runtime/hermes-studio-runtime-$VERSION-linux-x64.tar.gz"
    cp "$ROOT/tests/helpers/fake-node.sh" "$T/node/bin/node"
    printf '%s\n' '// fake manager entry' > "$T/app/manager/backend/server.mjs"
    cat > "$T/node/bin/npm" <<EOF
#!/bin/sh
touch "$T/network-used"
exit 90
EOF
    cat > "$T/node/bin/curl" <<EOF
#!/bin/sh
touch "$T/network-used"
exit 90
EOF
    chmod +x "$T/node/bin/node" "$T/node/bin/npm" "$T/node/bin/curl"
}

expect_manifest_failure() {
    local expected="$1"
    if TRIM_APPDEST="$T/app" TRIM_PKGHOME="$T/home" TRIM_PKGVAR="$T/var" \
        NODE_ROOT="$T/node" HERMES_TEST_VERSION="$VERSION" HSTUDIO_RUNTIME_BOOTSTRAP=1 \
        PATH="$T/node/bin:$PATH" bash "$T/app/cmd/install_callback"; then
        echo "invalid Runtime manifest unexpectedly accepted: $expected" >&2
        exit 1
    fi
    grep -q "$expected" "$T/app/install-error.log"
    test ! -e "$T/network-used"
    test ! -e "$T/home/data/cache/downloads/$VERSION.tar.gz"
    ! grep -q 'found package Runtime archive' "$T/var/info.log"
}

make_fixture
rm -f "$T/app/config/runtime-manifest.json"
expect_manifest_failure 'missing or unreadable Runtime manifest'

make_fixture
sed -i -E '0,/"version": "[^"]+"/s//"version": "latest"/' "$T/app/config/runtime-manifest.json"
expect_manifest_failure 'invalid Runtime manifest'

make_fixture
sed -i -E '0,/"sha256": "[^"]+"/s//"sha256": ""/' "$T/app/config/runtime-manifest.json"
expect_manifest_failure 'invalid Runtime manifest'

make_fixture
sed -i -E '0,/"size": [0-9]+/s//"size": 0/' "$T/app/config/runtime-manifest.json"
expect_manifest_failure 'invalid Runtime manifest'

make_fixture
sed -i -E '0,/"version": "[^"]+"/s//"version": "9.9.9"/' "$T/app/config/runtime-manifest.json"
expect_manifest_failure 'does not match Runtime manifest'

echo 'PASS Runtime manifest is fail-closed before archive or network bootstrap'
