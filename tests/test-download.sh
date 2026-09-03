#!/bin/bash
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

mkdir -p "$T/bin" "$T/out"
printf '%s' 'verified-runtime-payload' > "$T/source"
expected="$(sha256sum "$T/source" | awk '{print $1}')"
expected_size="$(stat -c '%s' "$T/source")"
export DOWNLOAD_TEST_ROOT="$T"

cat > "$T/bin/curl" <<'EOF'
#!/bin/bash
set -eu
destination=""
url=""
resume=0
max_time=""
speed_time=""
speed_limit=""
while [ "$#" -gt 0 ]; do
    case "$1" in
        --continue-at)
            [ "${2:-}" = '-' ] || exit 80
            resume=1
            shift 2
            ;;
        -o)
            destination="$2"
            shift 2
            ;;
        --max-time)
            max_time="$2"
            shift 2
            ;;
        --speed-time)
            speed_time="$2"
            shift 2
            ;;
        --speed-limit)
            speed_limit="$2"
            shift 2
            ;;
        http*)
            url="$1"
            shift
            ;;
        *) shift ;;
    esac
done
printf '%s\n' "$url" >> "$DOWNLOAD_TEST_ROOT/curl.log"
[ "$resume" -eq 1 ] || exit 81
[ -n "$max_time" ] && [ -n "$speed_time" ] && [ -n "$speed_limit" ] || exit 82
printf '%s %s %s\n' "$max_time" "$speed_time" "$speed_limit" >> "$DOWNLOAD_TEST_ROOT/limits.log"
[ "$url" != 'https://first.invalid/runtime.tar.gz' ] || exit 22
[ "$url" != 'https://hang.invalid/runtime.tar.gz' ] || { [ "$max_time" = 1 ] && exit 28; exit 83; }
if [ "$url" = 'https://corrupt.invalid/runtime.tar.gz' ]; then
    printf '%s' 'corrupt-runtime' > "$destination"
    exit 0
fi
[ "$url" = 'https://mirror.invalid/runtime.tar.gz' ] || exit 23
offset=0
[ ! -f "$destination" ] || offset="$(wc -c < "$destination" | tr -d ' ')"
tail -c "+$((offset + 1))" "$DOWNLOAD_TEST_ROOT/source" >> "$destination"
EOF
chmod +x "$T/bin/curl"

# The partial file proves the successful mirror resumes rather than replacing
# bytes. The failed primary URL proves ordered source fallback.
printf '%s' 'verified-' > "$T/out/runtime.tar.gz.part"
PATH="$T/bin:$PATH"
export PATH
. "$ROOT/cmd/lib/download.sh"

# A previously published archive may have survived a later extraction failure.
# Exact size and digest make it reusable without contacting any source.
printf '%s' 'verified-runtime-payload' > "$T/out/published.tar.gz"
rm -f "$T/curl.log"
download_with_resume "$T/out/published.tar.gz" "$expected" "$expected_size" \
    'https://first.invalid/runtime.tar.gz'
cmp "$T/source" "$T/out/published.tar.gz"
test ! -e "$T/curl.log"

# Invalid published files are never resumed as partials. Delete only the exact
# destination and let the sole source repair it from byte zero.
printf '%s' keep > "$T/out/published-wrong.tar.gz.keep"
printf '%*s' "$expected_size" '' | tr ' ' x > "$T/out/published-wrong.tar.gz"
download_with_resume "$T/out/published-wrong.tar.gz" "$expected" "$expected_size" \
    'https://mirror.invalid/runtime.tar.gz'
cmp "$T/source" "$T/out/published-wrong.tar.gz"
test -f "$T/out/published-wrong.tar.gz.keep"
test "$(wc -l < "$T/curl.log" | tr -d ' ')" = 1

rm -f "$T/curl.log"
printf '%s' 'verified-runtime-payload-extra' > "$T/out/published-overlong.tar.gz"
download_with_resume "$T/out/published-overlong.tar.gz" "$expected" "$expected_size" \
    'https://mirror.invalid/runtime.tar.gz'
cmp "$T/source" "$T/out/published-overlong.tar.gz"
test -f "$T/out/published-wrong.tar.gz.keep"
test "$(wc -l < "$T/curl.log" | tr -d ' ')" = 1

# A fully written partial from an interrupted callback is already complete.
# Its locked checksum permits an atomic publish without any network request.
printf '%s' 'verified-runtime-payload' > "$T/out/preverified.tar.gz.part"
rm -f "$T/curl.log"
download_with_resume "$T/out/preverified.tar.gz" "$expected" "$expected_size" \
    'https://first.invalid/runtime.tar.gz'
cmp "$T/source" "$T/out/preverified.tar.gz"
test ! -e "$T/out/preverified.tar.gz.part"
test ! -e "$T/curl.log"

download_with_resume "$T/out/runtime.tar.gz" "$expected" "$expected_size" \
    'https://first.invalid/runtime.tar.gz' \
    'https://mirror.invalid/runtime.tar.gz'
cmp "$T/source" "$T/out/runtime.tar.gz"
test "$(sed -n '1p' "$T/curl.log")" = 'https://first.invalid/runtime.tar.gz'
test "$(sed -n '2p' "$T/curl.log")" = 'https://mirror.invalid/runtime.tar.gz'
test "$(sed -n '1p' "$T/limits.log")" = '1800 60 1024'

# An already complete but incorrect partial cannot be repaired by appending a
# Range response. It is discarded before the only source is contacted, which
# allows a clean byte-zero download to self-heal in one call.
rm -f "$T/curl.log" "$T/limits.log" "$T/out/runtime.tar.gz" "$T/out/runtime.tar.gz.part"
printf '%*s' "$expected_size" '' | tr ' ' x > "$T/out/runtime.tar.gz.part"
download_with_resume "$T/out/runtime.tar.gz" "$expected" "$expected_size" \
    'https://mirror.invalid/runtime.tar.gz'
cmp "$T/source" "$T/out/runtime.tar.gz"
test "$(wc -l < "$T/curl.log" | tr -d ' ')" = 1

# An overlong partial is equally non-resumable and must also restart cleanly.
rm -f "$T/curl.log" "$T/limits.log" "$T/out/runtime.tar.gz" "$T/out/runtime.tar.gz.part"
printf '%s' 'verified-runtime-payload-extra' > "$T/out/runtime.tar.gz.part"
download_with_resume "$T/out/runtime.tar.gz" "$expected" "$expected_size" \
    'https://mirror.invalid/runtime.tar.gz'
cmp "$T/source" "$T/out/runtime.tar.gz"
test "$(wc -l < "$T/curl.log" | tr -d ' ')" = 1

# A transport that succeeds with corrupt bytes is rejected per source, then a
# clean mirror is tried from byte zero and may still publish successfully.
rm -f "$T/curl.log" "$T/limits.log" "$T/out/runtime.tar.gz" "$T/out/runtime.tar.gz.part"
download_with_resume "$T/out/runtime.tar.gz" "$expected" "$expected_size" \
    'https://corrupt.invalid/runtime.tar.gz' \
    'https://mirror.invalid/runtime.tar.gz'
cmp "$T/source" "$T/out/runtime.tar.gz"
test "$(sed -n '1p' "$T/curl.log")" = 'https://corrupt.invalid/runtime.tar.gz'
test "$(sed -n '2p' "$T/curl.log")" = 'https://mirror.invalid/runtime.tar.gz'

# The configured total transfer deadline reaches curl; a timed-out source is
# treated as transport failure and the next source still succeeds.
rm -f "$T/curl.log" "$T/limits.log" "$T/out/runtime.tar.gz" "$T/out/runtime.tar.gz.part"
HSTUDIO_DOWNLOAD_MAX_TIME=1 download_with_resume "$T/out/runtime.tar.gz" "$expected" "$expected_size" \
    'https://hang.invalid/runtime.tar.gz' \
    'https://mirror.invalid/runtime.tar.gz'
cmp "$T/source" "$T/out/runtime.tar.gz"
test "$(sed -n '1p' "$T/limits.log")" = '1 60 1024'

# A checksum failure must return a distinct status and delete the untrusted
# partial download instead of publishing it.
rm -f "$T/curl.log" "$T/limits.log" "$T/out/runtime.tar.gz"
if download_with_resume "$T/out/bad.tar.gz" \
    '0000000000000000000000000000000000000000000000000000000000000000' \
    "$expected_size" \
    'https://mirror.invalid/runtime.tar.gz'; then
    echo 'checksum mismatch unexpectedly succeeded' >&2
    exit 1
else
    result=$?
fi
test "$result" -eq 2
test ! -e "$T/out/bad.tar.gz"
test ! -e "$T/out/bad.tar.gz.part"

echo 'PASS Runtime resume, source fallback and SHA256 rejection'
