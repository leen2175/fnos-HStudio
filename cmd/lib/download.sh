#!/bin/bash
download_with_resume() {
    local dest="$1" expected="$2" expected_size="$3" url index=0 checksum_failed=0 part_size
    local max_time="${HSTUDIO_DOWNLOAD_MAX_TIME:-1800}"
    local speed_time="${HSTUDIO_DOWNLOAD_SPEED_TIME:-60}"
    local speed_limit="${HSTUDIO_DOWNLOAD_SPEED_LIMIT:-1024}"
    shift 3
    case "$max_time:$speed_time:$speed_limit:$expected_size" in
        *[!0-9:]*) return 1 ;;
    esac
    [ "$max_time" -gt 0 ] && [ "$speed_time" -gt 0 ] && [ "$speed_limit" -gt 0 ] \
        && [ "$expected_size" -gt 0 ] || return 1
    mkdir -p "$(dirname "$dest")"
    # Extraction can fail after a verified archive was already published.
    # Reuse that exact immutable payload before considering any network source.
    if [ -e "$dest" ] || [ -L "$dest" ]; then
        part_size=""
        if [ -f "$dest" ] && [ ! -L "$dest" ]; then
            part_size="$(stat -c '%s' "$dest" 2>/dev/null || true)"
        fi
        if [ "$part_size" = "$expected_size" ] && [ -n "$expected" ] \
            && printf '%s  %s\n' "$expected" "$dest" | sha256sum -c - >/dev/null 2>&1; then
            return 0
        fi
        rm -f -- "$dest" || return 1
        if declare -F log_msg >/dev/null 2>&1; then
            log_msg "discarded published Runtime archive with invalid size or checksum"
        fi
    fi
    # A previous interrupted callback may have finished writing all bytes just
    # before it was stopped. Trust it only after the locked digest matches,
    # then publish atomically without touching the network.
    if [ -f "$dest.part" ]; then
        part_size="$(stat -c '%s' "$dest.part" 2>/dev/null || true)"
        case "$part_size" in ""|*[!0-9]*) return 1 ;; esac
        if [ "$part_size" -eq "$expected_size" ] && [ -n "$expected" ] \
            && printf '%s  %s\n' "$expected" "$dest.part" | sha256sum -c - >/dev/null 2>&1; then
            mv -f "$dest.part" "$dest"
            return 0
        fi
        # Range requests cannot repair an already complete or overlong file.
        # Remove only the exact destination partial after its locked digest
        # failed, then let the first source start again at byte zero.
        if [ "$part_size" -ge "$expected_size" ]; then
            rm -f -- "$dest.part"
            if declare -F log_msg >/dev/null 2>&1; then
                log_msg "discarded complete Runtime partial with invalid checksum"
            fi
        fi
    fi
    for url in "$@"; do
        [ -n "$url" ] || continue
        index=$((index + 1))
        if declare -F log_msg >/dev/null 2>&1; then
            log_msg "Runtime download source ${index} started"
        fi
        if ! curl -fL --retry 3 --retry-delay 2 --connect-timeout 20 \
            --max-time "$max_time" --speed-time "$speed_time" --speed-limit "$speed_limit" \
            --continue-at - -o "$dest.part" "$url"; then
            continue
        fi
        if [ -n "$expected" ] \
            && ! printf '%s  %s\n' "$expected" "$dest.part" | sha256sum -c -; then
            checksum_failed=1
            rm -f -- "$dest.part"
            if declare -F log_msg >/dev/null 2>&1; then
                log_msg "Runtime download source ${index} checksum mismatch"
            fi
            continue
        fi
        mv -f "$dest.part" "$dest"
        return 0
    done
    [ "$checksum_failed" -eq 0 ] || return 2
    return 1
}
