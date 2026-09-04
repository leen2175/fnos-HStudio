#!/bin/bash
# Runtime selection and health checks. This file is intentionally dependency-free.

runtime_state_file="${DATA_DIR:-${HOME:-/tmp}}/manager/state.json"
runtime_user_bin="${NPM_GLOBAL:-${HOME:-/tmp}/.npm-global}/bin/hermes-web-ui"
runtime_bundled_root="${DATA_DIR:-${HOME:-/tmp}}/runtime/studio"
runtime_legacy_root="${DATA_DIR:-${HOME:-/tmp}}/node"
RUNTIME_INSTALL_STAGE_PATH=""
RUNTIME_INSTALL_CANDIDATE_PATH=""

cleanup_runtime_install_transients() {
    local path parent name
    for path in "${RUNTIME_INSTALL_STAGE_PATH:-}" "${RUNTIME_INSTALL_CANDIDATE_PATH:-}"; do
        [ -n "$path" ] || continue
        parent="$(dirname -- "$path")"
        name="$(basename -- "$path")"
        [ "$parent" = "$runtime_bundled_root" ] || continue
        case "$name" in
            .staging."$$".*|.candidate.*."$$".*) rm -rf -- "$path" ;;
            *) continue ;;
        esac
        if [ "$path" = "${RUNTIME_INSTALL_STAGE_PATH:-}" ]; then
            rm -f -- "${path}.members" "${path}.verbose"
        fi
    done
    RUNTIME_INSTALL_STAGE_PATH=""
    RUNTIME_INSTALL_CANDIDATE_PATH=""
}

# Run a command in its own process group with a hard wall-clock bound. Node is
# the declared fnOS dependency, so this does not need optional coreutils such
# as `timeout`. hstudio-bounded executes a JavaScript entry through Node;
# hstudio-command-bounded executes an arbitrary program such as npm.
run_bounded_supervisor() {
    local node="$1" mode="$2" timeout_ms="$3"
    shift 3
    [ -x "$node" ] || return 127
    "$node" -e '
const {spawn}=require("node:child_process")
const mode=process.argv[1]
const timeoutMs=Number(process.argv[2])
const nodeMode=mode==="hstudio-bounded"
const command=nodeMode?process.execPath:process.argv[3]
const args=nodeMode?process.argv.slice(3):process.argv.slice(4)
if(!["hstudio-bounded","hstudio-command-bounded"].includes(mode)||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||!command||!args.length)process.exit(2)
const detached=process.platform!=="win32"
const child=spawn(command,args,{stdio:"inherit",detached})
let timer=null,killTimer=null,finalTimer=null,finished=false
const signalChild=signal=>{try{process.kill(detached?-child.pid:child.pid,signal)}catch{}}
const childScopeAlive=()=>{
  try{process.kill(detached?-child.pid:child.pid,0);return true}
  catch(error){return error&&error.code==="EPERM"}
}
let finalCode=null,scopePoll=null
const finish=code=>{
  if(finished)return
  finished=true
  if(timer)clearTimeout(timer)
  if(killTimer)clearTimeout(killTimer)
  if(finalTimer)clearTimeout(finalTimer)
  if(scopePoll)clearInterval(scopePoll)
  process.exit(finalCode===null?(Number.isInteger(code)?code:1):finalCode)
}
const finishCleanedScope=()=>{if(!childScopeAlive())finish(finalCode===null?1:finalCode)}
const cleanupScope=code=>{
  if(finished||finalCode!==null)return
  finalCode=Number.isInteger(code)?code:1
  signalChild("SIGTERM")
  scopePoll=setInterval(finishCleanedScope,50)
  killTimer=setTimeout(()=>{
    signalChild("SIGKILL")
    finishCleanedScope()
    if(!finished)finalTimer=setTimeout(()=>{
      if(finalCode===0)finalCode=1
      finish(finalCode===null?1:finalCode)
    },2000)
  },2000)
  finishCleanedScope()
}
child.once("error",()=>finish(1))
child.once("exit",code=>{
  if(finalCode!==null)return finishCleanedScope()
  if(childScopeAlive())return cleanupScope(Number.isInteger(code)?code:1)
  finish(code)
})
process.once("SIGTERM",()=>cleanupScope(143))
process.once("SIGINT",()=>cleanupScope(130))
timer=setTimeout(()=>cleanupScope(124),timeoutMs)
' "$mode" "$timeout_ms" "$@"
}

run_command_bounded() {
    local node="$1" timeout_ms="$2"
    shift 2
    run_bounded_supervisor "$node" hstudio-command-bounded "$timeout_ms" "$@"
}

run_node_command_bounded() {
    local node="$1" timeout_ms="$2"
    shift 2
    run_bounded_supervisor "$node" hstudio-bounded "$timeout_ms" "$@"
}

verify_sha256() {
    local file="$1" expected="$2" actual
    [ -f "$file" ] || return 1
    [ -z "$expected" ] && return 0
    if command -v sha256sum >/dev/null 2>&1; then
        actual="$(sha256sum "$file" | awk '{print $1}')"
    else
        actual="$(shasum -a 256 "$file" | awk '{print $1}')"
    fi
    [ "$(printf '%s' "$actual" | tr '[:upper:]' '[:lower:]')" = "$(printf '%s' "$expected" | tr '[:upper:]' '[:lower:]')" ]
}

runtime_package_root() {
    local entry="$1" resolved
    resolved="$(readlink -f "$entry" 2>/dev/null || true)"
    [ -n "$resolved" ] || resolved="$entry"
    dirname "$(dirname "$resolved")"
}

runtime_package_version() {
    local root="$1"
    sed -nE 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' \
        "$root/package.json" 2>/dev/null | head -1
}

runtime_relative_link_safe() {
    local name="$1" target="$2" top="$3" part
    local -a parts stack
    stack=()
    case "$target" in
        ""|/*|*\\*|*[[:space:]]*) return 1 ;;
    esac
    IFS='/' read -r -a parts <<< "${name%/*}/$target"
    for part in "${parts[@]}"; do
        case "$part" in
            ""|.) ;;
            ..)
                [ "${#stack[@]}" -gt 1 ] || return 1
                unset "stack[$((${#stack[@]} - 1))]"
                ;;
            *) stack+=("$part") ;;
        esac
    done
    [ "${#stack[@]}" -gt 0 ] && [ "${stack[0]}" = "$top" ]
}

validate_runtime_archive_layout() {
    local archive="$1" listing="$2" verbose="$3" member top="" first line before name target kind expanded
    LC_ALL=C tar -tzf "$archive" > "$listing" 2>/dev/null || return 1
    while IFS= read -r member; do
        while [ "${member#./}" != "$member" ]; do member="${member#./}"; done
        member="${member%/}"
        [ -n "$member" ] || continue
        case "$member" in
            /*|*\\*|*[[:space:]]*|..|../*|*/../*|*/..|*/./*|*/.) return 1 ;;
        esac
        first="${member%%/*}"
        [ -n "$first" ] && [ "$first" != "." ] && [ "$first" != ".." ] || return 1
        if [ -z "$top" ]; then
            top="$first"
        elif [ "$member" != "$top" ]; then
            case "$member" in "$top"/*) ;; *) return 1 ;; esac
        fi
    done < "$listing"
    [ -n "$top" ] || return 1

    # Reject special files and hard links. Relative symlinks are permitted only
    # when lexical resolution stays inside the archive's single package root.
    LC_ALL=C tar -tvzf "$archive" > "$verbose" 2>/dev/null || return 1
    while IFS= read -r line; do
        kind="${line%"${line#?}"}"
        case "$kind" in
            -|d) ;;
            l)
                case "$line" in *" -> "*) ;; *) return 1 ;; esac
                before="${line%% -> *}"
                name="${before##* }"
                target="${line#* -> }"
                while [ "${name#./}" != "$name" ]; do name="${name#./}"; done
                runtime_relative_link_safe "$name" "$target" "$top" || return 1
                ;;
            *) return 1 ;;
        esac
    done < "$verbose"
    expanded="$(awk '$1 ~ /^[-d]/{sum += $3} END {printf "%.0f", sum}' "$verbose" 2>/dev/null || true)"
    case "$expanded" in ""|*[!0-9]*) return 1 ;; esac
    RUNTIME_ARCHIVE_TOP="$top"
    RUNTIME_ARCHIVE_EXPANDED_BYTES="$expanded"
}

runtime_disk_check() {
    local dir="${1:-${DATA_DIR:-/tmp}}" needed="${2:-104857600}" avail
    avail="$(df -Pk "$dir" 2>/dev/null | awk 'NR==2 {print $4*1024}')"
    [ -z "$avail" ] || [ "$avail" -ge "$needed" ]
}

activate_bundled_runtime() {
    local version="$1" parent="${runtime_bundled_root:?}" target current previous
    local current_next previous_next old_current=""
    target="$parent/$version"
    current="$parent/current"
    previous="$parent/previous"
    current_next="$parent/.current.$$.${RANDOM}"
    previous_next="$parent/.previous.$$.${RANDOM}"
    health_check_runtime "$target/bin/hermes-web-ui" || return 1
    if { [ -e "$current" ] || [ -L "$current" ]; } && [ ! -L "$current" ]; then return 1; fi
    if [ -L "$current" ]; then
        old_current="$(readlink "$current" 2>/dev/null || true)"
        case "$old_current" in ""|/*|*\\*|..|../*|*/../*|*/..) return 1 ;; esac
    fi
    [ "$old_current" != "$version" ] || return 0
    if { [ -e "$previous" ] || [ -L "$previous" ]; } && [ ! -L "$previous" ]; then return 1; fi
    ln -s "$version" "$current_next" || return 1
    if [ -n "$old_current" ]; then
        ln -s "$old_current" "$previous_next" || { rm -f -- "$current_next"; return 1; }
    fi
    if ! mv -Tf "$current_next" "$current"; then
        rm -f -- "$current_next" "$previous_next"
        return 1
    fi
    if [ -n "$old_current" ] && ! mv -Tf "$previous_next" "$previous"; then
        if ln -s "$old_current" "$current_next" 2>/dev/null; then
            mv -Tf "$current_next" "$current" 2>/dev/null || true
        fi
        rm -f -- "$previous_next"
        return 1
    fi
    return 0
}

install_runtime_archive() {
    local archive="$1" version="$2" expected="${3:-}" parent target stage root entry
    local listing verbose candidate current previous current_next previous_next
    local old_current="" previous_target="" backup="" package_version replaced=0
    RUNTIME_ARCHIVE_ERROR=""
    [ -f "$archive" ] || { RUNTIME_ARCHIVE_ERROR=missing; return 1; }
    case "$version" in ""|*[!A-Za-z0-9._+-]*|.|..) RUNTIME_ARCHIVE_ERROR=invalid_version; return 1 ;; esac
    verify_sha256 "$archive" "$expected" || { RUNTIME_ARCHIVE_ERROR=checksum; return 1; }
    parent="${runtime_bundled_root:?}"
    target="$parent/$version"
    cleanup_runtime_install_transients
    stage="$parent/.staging.$$.${RANDOM}"
    candidate="$parent/.candidate.$version.$$.${RANDOM}"
    RUNTIME_INSTALL_STAGE_PATH="$stage"
    RUNTIME_INSTALL_CANDIDATE_PATH="$candidate"
    listing="$stage.members"
    verbose="$stage.verbose"
    current="$parent/current"
    previous="$parent/previous"
    current_next="$parent/.current.$$.${RANDOM}"
    previous_next="$parent/.previous.$$.${RANDOM}"
    mkdir -p "$parent" || { RUNTIME_ARCHIVE_ERROR=staging_directory; return 1; }
    if ! validate_runtime_archive_layout "$archive" "$listing" "$verbose"; then
        rm -f -- "$listing" "$verbose"
        RUNTIME_ARCHIVE_ERROR=unsafe_layout
        return 1
    fi
    # Extraction needs the full logical payload, not merely a multiple of the
    # compressed archive. Keep an additional 64 MiB for tar metadata, links,
    # state files and filesystem allocation overhead.
    runtime_disk_check "${DATA_DIR:-/tmp}" "$((RUNTIME_ARCHIVE_EXPANDED_BYTES + 67108864))" || {
        rm -f -- "$listing" "$verbose"
        RUNTIME_ARCHIVE_ERROR=insufficient_space
        return 1
    }
    rm -f -- "$listing" "$verbose"
    mkdir -p "$stage" || { RUNTIME_ARCHIVE_ERROR=staging_directory; return 1; }
    if ! tar -xzf "$archive" -C "$stage" 2>/dev/null; then
        rm -rf "$stage"; RUNTIME_ARCHIVE_ERROR=extract; return 1
    fi
    root="$stage/$RUNTIME_ARCHIVE_TOP"
    [ -d "$root" ] || { rm -rf "$stage"; RUNTIME_ARCHIVE_ERROR=package_root; return 1; }
    entry="$root/bin/hermes-web-ui"
    if [ ! -e "$entry" ] && [ -f "$root/bin/hermes-web-ui.mjs" ]; then
        ln -s hermes-web-ui.mjs "$entry" || { rm -rf "$stage"; RUNTIME_ARCHIVE_ERROR=entry_layout; return 1; }
    fi
    [ -f "$root/bin/hermes-web-ui.mjs" ] || [ -f "$entry" ] || { rm -rf "$stage"; RUNTIME_ARCHIVE_ERROR=entry_layout; return 1; }
    [ -f "$root/package.json" ] || { rm -rf "$stage"; RUNTIME_ARCHIVE_ERROR=package_metadata; return 1; }
    grep -q '"name"[[:space:]]*:[[:space:]]*"hermes-web-ui"' "$root/package.json" 2>/dev/null || { rm -rf "$stage"; RUNTIME_ARCHIVE_ERROR=package_name; return 1; }
    package_version="$(runtime_package_version "$root")"
    [ "$package_version" = "$version" ] || { rm -rf "$stage"; RUNTIME_ARCHIVE_ERROR=version_mismatch; return 1; }
    chmod +x "$entry" "$root/bin/hermes-web-ui.mjs" 2>/dev/null || true
    if ! health_check_runtime "$entry"; then
        rm -rf "$stage"
        RUNTIME_ARCHIVE_ERROR=health
        return 1
    fi
    mv "$root" "$candidate" || { rm -rf "$stage" "$candidate"; RUNTIME_ARCHIVE_ERROR=publish; return 1; }
    rm -rf "$stage"

    # Preflight all switch metadata before touching an installed version.
    if { [ -e "$current" ] || [ -L "$current" ]; } && [ ! -L "$current" ]; then
        rm -rf "$candidate"; RUNTIME_ARCHIVE_ERROR=current_layout; return 1
    fi
    if [ -L "$current" ]; then
        old_current="$(readlink "$current" 2>/dev/null || true)"
        case "$old_current" in ""|/*|*\\*|..|../*|*/../*|*/..) rm -rf "$candidate"; RUNTIME_ARCHIVE_ERROR=current_target; return 1 ;; esac
    fi
    if { [ -e "$target" ] || [ -L "$target" ]; } && [ -L "$target" ]; then
        rm -rf "$candidate"; RUNTIME_ARCHIVE_ERROR=target_layout; return 1
    fi
    backup="$parent/${version}.previous.$(date +%s).$$.${RANDOM}"
    if [ -n "$old_current" ]; then
        if [ "$old_current" = "$version" ] && [ -e "$target" ]; then
            previous_target="$(basename "$backup")"
        else
            previous_target="$old_current"
        fi
        if { [ -e "$previous" ] || [ -L "$previous" ]; } && [ ! -L "$previous" ]; then
            rm -rf "$candidate"; RUNTIME_ARCHIVE_ERROR=previous_layout; return 1
        fi
    fi
    ln -s "$version" "$current_next" || { rm -rf "$candidate"; RUNTIME_ARCHIVE_ERROR=current_prepare; return 1; }
    if [ -n "$previous_target" ]; then
        ln -s "$previous_target" "$previous_next" || { rm -f "$current_next"; rm -rf "$candidate"; RUNTIME_ARCHIVE_ERROR=previous_prepare; return 1; }
    fi

    if [ -e "$target" ]; then
        mv "$target" "$backup" || { rm -f "$current_next" "$previous_next"; rm -rf "$candidate"; RUNTIME_ARCHIVE_ERROR=target_backup; return 1; }
        replaced=1
    fi
    if ! mv "$candidate" "$target"; then
        if [ "$replaced" -ne 0 ]; then
            mv "$backup" "$target" 2>/dev/null || true
        fi
        rm -f "$current_next" "$previous_next"
        rm -rf "$candidate"
        RUNTIME_ARCHIVE_ERROR=publish
        return 1
    fi
    if ! mv -Tf "$current_next" "$current"; then
        rm -rf "$target"
        if [ "$replaced" -ne 0 ]; then
            mv "$backup" "$target" 2>/dev/null || true
        fi
        rm -f "$current_next" "$previous_next"
        RUNTIME_ARCHIVE_ERROR=current_switch
        return 1
    fi
    if [ -n "$previous_target" ] && ! mv -Tf "$previous_next" "$previous"; then
        if [ -n "$old_current" ]; then
            if ln -s "$old_current" "$current_next" 2>/dev/null; then
                mv -Tf "$current_next" "$current" 2>/dev/null || true
            fi
        else
            rm -f "$current"
        fi
        rm -rf "$target"
        if [ "$replaced" -ne 0 ]; then
            mv "$backup" "$target" 2>/dev/null || true
        fi
        rm -f "$previous_next"
        RUNTIME_ARCHIVE_ERROR=previous_switch
        return 1
    fi
    return 0
}

runtime_version() {
    local entry="$1" n="$2" out
    [ -x "$entry" ] || return 1
    [ -x "$n" ] || n="${NODE_BIN:-node}"
    out="$(run_node_command_bounded "$n" 8000 "$entry" --version 2>/dev/null)" || return 1
    printf '%s\n' "$out" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1
}

health_check_runtime() {
    local entry="$1" root package_version v
    [ -f "$entry" ] && [ -r "$entry" ] || return 1
    root="$(runtime_package_root "$entry")"
    [ -f "$root/package.json" ] && [ -r "$root/dist/server/index.js" ] || return 1
    grep -q '"name"[[:space:]]*:[[:space:]]*"hermes-web-ui"' "$root/package.json" 2>/dev/null || return 1
    package_version="$(runtime_package_version "$root")"
    [ -n "$package_version" ] || return 1
    v="$(runtime_version "$entry" "${NODE_BIN:-node}")"
    [ -n "$v" ] || return 1
    [ "$v" = "$package_version" ] || return 1
}

current_bundled_entry() {
    local candidate="${runtime_bundled_root}/current/bin/hermes-web-ui"
    [ -x "$candidate" ] && { printf '%s\n' "$candidate"; return 0; }
    return 1
}

previous_bundled_entry() {
    local candidate="${runtime_bundled_root}/previous/bin/hermes-web-ui"
    [ -x "$candidate" ] && { printf '%s\n' "$candidate"; return 0; }
    return 1
}

legacy_bundled_entry() {
    local candidate
    candidate="${runtime_legacy_root}/bin/hermes-web-ui"
    [ -x "$candidate" ] && { printf '%s\n' "$candidate"; return 0; }
    candidate="${runtime_legacy_root}/lib/node_modules/hermes-web-ui/bin/hermes-web-ui.mjs"
    [ -f "$candidate" ] && { printf '%s\n' "$candidate"; return 0; }
    return 1
}

bundled_entry() {
    local candidate
    candidate="$(current_bundled_entry 2>/dev/null || true)"
    [ -n "$candidate" ] && { printf '%s\n' "$candidate"; return 0; }
    legacy_bundled_entry
}

healthy_bundled_entry() {
    local provider candidate
    for provider in current_bundled_entry previous_bundled_entry legacy_bundled_entry; do
        candidate="$($provider 2>/dev/null || true)"
        [ -n "$candidate" ] || continue
        if health_check_runtime "$candidate"; then
            printf '%s\n' "$candidate"
            return 0
        fi
    done
    return 1
}

preferred_runtime() {
    local p="auto"
    if [ -r "$runtime_state_file" ]; then
        p=$(sed -nE 's/.*"preferredRuntime"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$runtime_state_file" | head -1)
    fi
    case "$p" in auto|user-global|bundled) printf '%s\n' "$p" ;; *) printf 'auto\n' ;; esac
}

select_runtime() {
    local mode="${1:-$(preferred_runtime)}" bundled
    if [ "$mode" != bundled ] && health_check_runtime "$runtime_user_bin"; then
        RUNTIME_SOURCE=user-global; RUNTIME_ENTRY="$runtime_user_bin"; return 0
    fi
    bundled="$(healthy_bundled_entry 2>/dev/null || true)"
    if [ -n "$bundled" ]; then
        RUNTIME_SOURCE=bundled; RUNTIME_ENTRY="$bundled"; return 0
    fi
    return 1
}

set_preferred_runtime() {
    case "$1" in auto|user-global|bundled) ;; *) return 2 ;; esac
    mkdir -p "$(dirname "$runtime_state_file")"
    printf '{"preferredRuntime":"%s"}\n' "$1" > "${runtime_state_file}.tmp"
    mv -f "${runtime_state_file}.tmp" "$runtime_state_file"
    chmod 600 "$runtime_state_file" 2>/dev/null || true
}
