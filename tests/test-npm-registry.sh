#!/bin/bash
set -eu
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
mkdir -p "$tmp_dir/data/manager"
printf '%s\n' '{"id":"npmmirror","url":"https://registry.npmmirror.com/"}' > "$tmp_dir/data/manager/npm-registry.json"
printf '%s\n' '{"id":"ustc","url":"https://mirrors.ustc.edu.cn/pypi/simple/"}' > "$tmp_dir/data/manager/python-registry.json"
export DATA_DIR="$tmp_dir/data" HOME="$tmp_dir/data" NODE_ROOT=""
. "$(dirname "$0")/../cmd/lib/environment.sh"
init_environment
[ "$NPM_REGISTRY" = "https://registry.npmmirror.com/" ]
[ "$npm_config_registry" = "$NPM_REGISTRY" ]
[ "$NPM_CONFIG_REGISTRY" = "$NPM_REGISTRY" ]
[ "$PYTHON_REGISTRY" = "https://mirrors.ustc.edu.cn/pypi/simple/" ]
[ "$PIP_INDEX_URL" = "$PYTHON_REGISTRY" ]
[ "$UV_DEFAULT_INDEX" = "$PYTHON_REGISTRY" ]
[ "$UV_INDEX_URL" = "$PYTHON_REGISTRY" ]
echo 'PASS npm and Python registry selection'
