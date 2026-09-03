#!/bin/bash
migrate_legacy_runtime() {
    local legacy="${DATA_DIR}/node"
    [ -d "$legacy" ] || return 0
    # Older releases may contain hundreds of MiB below data/node. Runtime
    # selection already recognises this directory as a read-only legacy
    # fallback, so copying it only doubles persistent storage and can leave a
    # partial tree after power loss. Keep it in place until the user installs a
    # verified current Runtime.
    if declare -F log_msg >/dev/null 2>&1; then
        log_msg "legacy Runtime retained in place at ${legacy}"
    fi
    return 0
}
