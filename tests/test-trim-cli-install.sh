#!/bin/bash
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
PKGHOME="$T/vol2/@apphome/HStudio"
PKGVAR="$T/vol2/@appdata/HStudio"

mkdir -p "$T/app/skills/trim-cli/bin" "$T/app/skills/trim-cli/scripts" \
  "$T/app/skills/trim-cli/entries" "$T/app/skills/trim-cli/reference" \
  "$PKGHOME" "$PKGVAR"
printf '%s\n' '---' 'name: trim-cli' '---' > "$T/app/skills/trim-cli/SKILL.md"
printf '%s\n' '{"name":"trim-cli","version":"0.1.0"}' > "$T/app/skills/trim-cli/manifest.json"
cp "$ROOT/.agents/skills/trim-cli/scripts/trim-cli" "$T/app/skills/trim-cli/scripts/trim-cli"
printf '%s\n' '#!/bin/sh' 'echo cli-v1 "$@"' > "$T/app/skills/trim-cli/bin/trim-cli-linux-x64"
printf '%s\n' '#!/bin/sh' 'echo cli-arm64-v1 "$@"' > "$T/app/skills/trim-cli/bin/trim-cli-linux-arm64"
chmod +x "$T/app/skills/trim-cli/scripts/trim-cli" "$T/app/skills/trim-cli/bin/"*

TRIM_APPDEST="$T/app" TRIM_PKGHOME="$PKGHOME" TRIM_PKGVAR="$PKGVAR" \
  bash "$ROOT/cmd/install_callback"

test -x "$PKGHOME/data/tools/bin/trim-cli"
test -f "$PKGHOME/data/hermes-home/skills/trim-cli/SKILL.md"
test -f "$PKGHOME/data/.agents/skills/trim-cli/SKILL.md"
test -f "$PKGHOME/data/.claude/skills/trim-cli/SKILL.md"
test "$(stat -c '%a' "$PKGHOME/data/trim-cli")" = 700
test "$(TRIM_APPDEST="$T/app" TRIM_PKGHOME="$PKGHOME" bash -c \
  '. "'$ROOT'/cmd/lib/environment.sh"; init_environment; command -v trim-cli')" \
  = "$PKGHOME/data/tools/bin/trim-cli"
TRIM_APPDEST="$T/app" TRIM_PKGHOME="$PKGHOME" bash -c \
  '. "'$ROOT'/cmd/lib/environment.sh"; init_environment; test "$HSTUDIO_SKILLS_DIR" = "'$T'/app/skills"; test "$HERMES_WEB_UI_SKILLS_DIR" = "'$PKGHOME'/data/manager/hermes-skills-source"; trim-cli --help' \
  | grep -q 'cli-v1 --help'
mkdir -p "$T/usr-local-bin"
ln -s "$T/app/skills/trim-cli/scripts/trim-cli" "$T/usr-local-bin/trim-cli"
env -u TRIM_CLI_BIN PATH="$T/usr-local-bin:/usr/bin:/bin" \
  "$T/usr-local-bin/trim-cli" --help | grep -q 'cli-v1 --help'

mkdir -p "$T/arm-bin" "$T/arm-home" "$T/arm-var"
printf '%s\n' '#!/bin/sh' 'echo aarch64' > "$T/arm-bin/uname"
chmod +x "$T/arm-bin/uname"
TRIM_APPDEST="$T/app" TRIM_PKGHOME="$T/arm-home" TRIM_PKGVAR="$T/arm-var" \
  PATH="$T/arm-bin:$PATH" bash "$ROOT/cmd/install_callback"
"$T/arm-home/data/tools/bin/trim-cli" --help | grep -q 'cli-arm64-v1 --help'

printf '%s\n' 'user-customized-skill' > "$PKGHOME/data/.agents/skills/trim-cli/SKILL.md"
printf '%s\n' '#!/bin/sh' 'echo cli-v2 "$@"' > "$T/app/skills/trim-cli/bin/trim-cli-linux-x64"
chmod +x "$T/app/skills/trim-cli/bin/trim-cli-linux-x64"
TRIM_APPDEST="$T/app" TRIM_PKGHOME="$PKGHOME" TRIM_PKGVAR="$PKGVAR" \
  bash "$ROOT/cmd/install_callback"
grep -q 'user-customized-skill' "$PKGHOME/data/.agents/skills/trim-cli/SKILL.md"
"$PKGHOME/data/tools/bin/trim-cli" --help | grep -q 'cli-v2 --help'

TRIM_APPNAME=HStudio TRIM_PKGHOME="$PKGHOME" TRIM_PKGVAR="$PKGVAR" \
  wizard_delete_data=false bash "$ROOT/cmd/uninstall_callback"
test -d "$PKGHOME/data"
ln -s "$PKGHOME" "$T/semantic-home"
ln -s "$PKGVAR" "$T/semantic-var"
TRIM_APPNAME=HStudio TRIM_PKGHOME="$T/semantic-home" TRIM_PKGVAR="$T/semantic-var" \
  wizard_delete_data=true bash "$ROOT/cmd/uninstall_callback"
test ! -e "$PKGHOME/data"
test ! -e "$PKGVAR"

# Every target is validated before any deletion starts.
mkdir -p "$PKGHOME/data" "$T/vol2/not-appdata/HStudio"
printf '%s\n' keep > "$PKGHOME/data/sentinel"
if TRIM_APPNAME=HStudio TRIM_PKGHOME="$PKGHOME" TRIM_PKGVAR="$T/vol2/not-appdata/HStudio" \
    wizard_delete_data=true bash "$ROOT/cmd/uninstall_callback"; then
  echo 'uninstall_callback deleted before validating every target' >&2
  exit 1
fi
test -f "$PKGHOME/data/sentinel"

# An attacker-controlled data symlink must not escape the application home.
rm -rf "$PKGHOME/data"
mkdir -p "$T/outside" "$PKGVAR"
printf '%s\n' keep > "$T/outside/sentinel"
ln -s "$T/outside" "$PKGHOME/data"
if TRIM_APPNAME=HStudio TRIM_PKGHOME="$PKGHOME" TRIM_PKGVAR="$PKGVAR" \
    wizard_delete_data=true bash "$ROOT/cmd/uninstall_callback"; then
  echo 'uninstall_callback accepted a symlinked data directory' >&2
  exit 1
fi
test -f "$T/outside/sentinel"
test -d "$PKGVAR"

# Destructive cleanup must reject broad or malformed fnOS paths.
mkdir -p "$T/safe-home/data"
if TRIM_APPNAME=HStudio TRIM_PKGHOME=/ TRIM_PKGVAR=/var wizard_delete_data=true bash "$ROOT/cmd/uninstall_callback"; then
  echo 'uninstall_callback accepted unsafe cleanup roots' >&2
  exit 1
fi
test -d "$T/safe-home/data"

echo 'PASS trim-cli offline install, discovery, preservation and cleanup'
