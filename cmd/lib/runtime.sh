#!/bin/bash
# One official npm installation; no local version selection or archive fallback.
runtime_user_bin="${NPM_GLOBAL:-${HOME:-/tmp}/.npm-global}/bin/hermes-web-ui"

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

select_runtime() {
    health_check_runtime "$runtime_user_bin" || return 1
    RUNTIME_SOURCE=user-global
    RUNTIME_ENTRY="$runtime_user_bin"
}
