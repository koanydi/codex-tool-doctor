#!/bin/sh
set -eu
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
export PATH
exec sh "$script_dir/doctor.sh" gui "$@"
