#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' '请先安装 Node.js 22 或更新版本。' >&2
  exit 1
fi
if [ ! -f "$script_dir/node_modules/smol-toml/package.json" ]; then
  printf '%s\n' '缺少依赖，请在工具目录运行 npm ci --ignore-scripts。' >&2
  exit 1
fi
if [ "$#" -eq 0 ]; then
  set -- menu
fi
exec node "$script_dir/src/cli.mjs" "$@"
