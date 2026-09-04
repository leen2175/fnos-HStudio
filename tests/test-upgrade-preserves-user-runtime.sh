#!/bin/bash
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "${T:?}"' EXIT

mkdir -p "$T/home/data/runtime/studio" "$T/home/data/.npm-global" "$T/home/data/manager" "$T/var" "$T/test-bin"
printf '%s\n' runtime > "$T/home/data/runtime/studio/SENTINEL"
printf '%s\n' npm > "$T/home/data/.npm-global/SENTINEL"
printf '%s\n' manager > "$T/home/data/manager/SENTINEL"
for command in npm curl; do
    printf '%s\n' '#!/bin/sh' 'touch "$NETWORK_CALLED"' 'exit 99' > "$T/test-bin/$command"
    chmod +x "$T/test-bin/$command"
done

TRIM_APPDEST="$T/app" TRIM_PKGHOME="$T/home" TRIM_PKGVAR="$T/var" \
    NETWORK_CALLED="$T/network-called" PATH="$T/test-bin:$PATH" \
    bash "$ROOT/cmd/upgrade_callback"

test ! -e "$T/network-called"
grep -qx runtime "$T/home/data/runtime/studio/SENTINEL"
grep -qx npm "$T/home/data/.npm-global/SENTINEL"
grep -qx manager "$T/home/data/manager/SENTINEL"
grep -q 'FPK adapter upgraded; .npm-global and user config preserved' "$T/var/info.log"

echo 'PASS online FPK upgrade preserves Runtime and user data without network access'
