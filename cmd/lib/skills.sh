#!/bin/bash
# Build the source consumed by Hermes Studio's exclusive SKILLS_DIR override.
# It must contain both upstream Runtime Skills and HStudio's trim-cli Skill.

prepare_hermes_skill_source() {
    local entry="$1" candidate resolved runtime_root upstream_skills trim_skill target parent stage previous
    [ -n "$entry" ] || return 1
    [ -n "${HSTUDIO_SKILLS_DIR:-}" ] || return 1
    trim_skill="$HSTUDIO_SKILLS_DIR/trim-cli"
    [ -f "$trim_skill/SKILL.md" ] || return 1

    resolved="$entry"
    if command -v readlink >/dev/null 2>&1; then
        candidate="$(readlink -f "$entry" 2>/dev/null || true)"
        [ -n "$candidate" ] && resolved="$candidate"
    fi
    runtime_root="$(CDPATH='' cd -- "$(dirname -- "$resolved")/.." 2>/dev/null && pwd)" || return 1
    upstream_skills=""
    upstream_skills="$runtime_root/dist/skills"
    [ -d "$upstream_skills" ] || return 1

    target="${HERMES_WEB_UI_SKILLS_DIR:?}"
    parent="$(dirname -- "$target")"
    stage="$parent/.hermes-skills-source.$$"
    previous="$parent/.hermes-skills-source.previous.$$"
    mkdir -p "$parent" || return 1
    rm -rf -- "$stage" "$previous"
    mkdir "$stage" || return 1
    if ! cp -R "$upstream_skills"/. "$stage"/; then
        rm -rf -- "$stage"
        return 1
    fi
    rm -rf -- "$stage/trim-cli"
    if ! cp -R "$trim_skill" "$stage/trim-cli"; then
        rm -rf -- "$stage"
        return 1
    fi
    chmod 755 "$stage/trim-cli/scripts/trim-cli" \
        "$stage/trim-cli/bin/trim-cli-linux-x64" \
        "$stage/trim-cli/bin/trim-cli-linux-arm64" 2>/dev/null || true

    if [ -e "$target" ] || [ -L "$target" ]; then
        if ! mv "$target" "$previous"; then
            rm -rf -- "$stage"
            return 1
        fi
    fi
    if ! mv "$stage" "$target"; then
        [ -e "$previous" ] && mv "$previous" "$target"
        rm -rf -- "$stage"
        return 1
    fi
    rm -rf -- "$previous"
}
