#!/bin/bash
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

mkdir -p "$T/app/skills/trim-cli/bin" "$T/app/skills/trim-cli/scripts" \
  "$T/runtime/bin" "$T/runtime/dist/skills/upstream-one" "$T/home"
printf '%s\n' 'name: trim-cli' > "$T/app/skills/trim-cli/SKILL.md"
printf '%s\n' '#!/bin/sh' 'exit 0' > "$T/app/skills/trim-cli/scripts/trim-cli"
printf '%s\n' x64 > "$T/app/skills/trim-cli/bin/trim-cli-linux-x64"
printf '%s\n' arm64 > "$T/app/skills/trim-cli/bin/trim-cli-linux-arm64"
printf '%s\n' 'name: upstream-one' > "$T/runtime/dist/skills/upstream-one/SKILL.md"
printf '%s\n' '#!/bin/sh' 'exit 0' > "$T/runtime/bin/hermes-web-ui"
chmod +x "$T/runtime/bin/hermes-web-ui"

TRIM_APPDEST="$T/app" TRIM_PKGHOME="$T/home" DATA_DIR="$T/home/data" \
  bash -c '. "'$ROOT'/cmd/lib/environment.sh"; . "'$ROOT'/cmd/lib/skills.sh"; init_environment; prepare_hermes_skill_source "'$T'/runtime/bin/hermes-web-ui"; test -f "$HERMES_WEB_UI_SKILLS_DIR/upstream-one/SKILL.md"; test -f "$HERMES_WEB_UI_SKILLS_DIR/trim-cli/SKILL.md"'

test -f "$T/runtime/dist/skills/upstream-one/SKILL.md"
test ! -e "$T/runtime/dist/skills/trim-cli"
test -f "$T/app/skills/trim-cli/SKILL.md"

mkdir -p "$T/user-home/data/.npm-global/bin" \
  "$T/user-home/data/.npm-global/lib/node_modules/hermes-web-ui/bin" \
  "$T/user-home/data/.npm-global/lib/node_modules/hermes-web-ui/dist/skills/upstream-two"
printf '%s\n' 'name: upstream-two' > \
  "$T/user-home/data/.npm-global/lib/node_modules/hermes-web-ui/dist/skills/upstream-two/SKILL.md"
printf '%s\n' '#!/bin/sh' 'exit 0' > \
  "$T/user-home/data/.npm-global/lib/node_modules/hermes-web-ui/bin/hermes-web-ui.mjs"
ln -s ../lib/node_modules/hermes-web-ui/bin/hermes-web-ui.mjs \
  "$T/user-home/data/.npm-global/bin/hermes-web-ui"
TRIM_APPDEST="$T/app" TRIM_PKGHOME="$T/user-home" DATA_DIR="$T/user-home/data" \
  bash -c '. "'$ROOT'/cmd/lib/environment.sh"; . "'$ROOT'/cmd/lib/runtime.sh"; . "'$ROOT'/cmd/lib/skills.sh"; init_environment; prepare_hermes_skill_source "$NPM_GLOBAL/bin/hermes-web-ui"; test -f "$HERMES_WEB_UI_SKILLS_DIR/upstream-two/SKILL.md"; test -f "$HERMES_WEB_UI_SKILLS_DIR/trim-cli/SKILL.md"'

echo 'PASS bundled/user-global merged upstream and trim-cli Skill source'
