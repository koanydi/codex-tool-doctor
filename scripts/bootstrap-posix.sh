#!/bin/sh
# Keep this entry point usable before Node or npm is installed.
set -u

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1

message() { printf '%s\n' "[tool-doctor] $*" >&2; }

node_usable() {
  "$1" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' >/dev/null 2>&1
}

runtime_usable() (
  runtime=$1
  version=${2#v}
  [ -x "$runtime/bin/node" ] && [ -f "$runtime/bin/npm" ] &&
    [ -f "$runtime/lib/node_modules/npm/bin/npm-cli.js" ] || exit 1
  node_usable "$runtime/bin/node" || exit 1
  actual=$("$runtime/bin/node" -p 'process.versions.node' 2>/dev/null) || exit 1
  [ "$actual" = "$version" ] || exit 1
  PATH="$runtime/bin:$PATH" "$runtime/bin/node" \
    "$runtime/lib/node_modules/npm/bin/npm-cli.js" --version >/dev/null 2>&1
)

launch_runtime() (
  runtime=$1
  shift
  PATH="$runtime/bin:$PATH"
  export PATH
  exec "$runtime/bin/node" "$script_dir/launch.mjs" "$@"
)

# Only 78 means the shared launcher needs a runtime containing npm. Ordinary
# application errors must never cause a second application invocation.
if [ "${TOOL_DOCTOR_IGNORE_SYSTEM_NODE:-0}" != 1 ]; then
  system_node=$(command -v node 2>/dev/null) || system_node=
  if [ -n "$system_node" ] && node_usable "$system_node"; then
    "$system_node" "$script_dir/launch.mjs" "$@"
    status=$?
    [ "$status" -eq 78 ] || exit "$status"
    message '系统Node缺少npm，正在查找便携运行时。'
  fi
fi

os=$(uname -s) || exit 1
machine=$(uname -m) || exit 1
case "$os" in
  Darwin) platform=darwin ;;
  Linux) platform=linux ;;
  *) message "暂不支持自动安装Node的平台：$os"; exit 1 ;;
esac
case "$machine" in
  x86_64|amd64) platform=$platform-x64 ;;
  arm64|aarch64) platform=$platform-arm64 ;;
  *) message "暂不支持自动安装Node的架构：$machine"; exit 1 ;;
esac
if [ "$os" = Linux ]; then
  libc=$(ldd --version 2>&1) || :
  case "$libc" in
    *musl*) musl=1 ;;
    *GLIBC*|*glibc*|*GNU*) musl=0 ;;
    *)
      musl=0
      for loader in /lib/ld-musl-*.so.1; do
        if [ -e "$loader" ]; then musl=1; break; fi
      done
      ;;
  esac
  if [ "$musl" -eq 1 ]; then
    [ "$platform" = linux-x64 ] || {
      message "暂不支持自动安装Node的musl架构：$machine"; exit 1;
    }
    platform=$platform-musl
  fi
fi

manifest=$script_dir/node-runtimes.txt
[ -r "$manifest" ] || { message "缺少运行时清单：$manifest"; exit 1; }
# Parse, validate and order once. Never evaluate manifest contents as shell code.
# CRLF, comments, and versions with or without a leading v are accepted.
candidates=$(awk -v platform="$platform" '
  {
    sub(/\r$/, ""); sub(/#.*/, "")
    if (NF == 0) next
    version = $1; sub(/^v/, "", version)
    if (version !~ /^(24|22)\.[0-9]+\.[0-9]+$/) next
    if ($2 != "node-v" version "-" platform ".tar.gz") next
    if (NF != 3 || length($3) != 64 || $3 ~ /[^0-9a-fA-F]/) { bad = 1; next }
    if (seen[$2]++) { bad = 1; next }
    line = "v" version " " $2 " " tolower($3) "\n"
    if (version ~ /^24\./) preferred = preferred line
    else fallback = fallback line
  }
  END { if (bad) exit 1; printf "%s%s", preferred, fallback }
' "$manifest") || { message '运行时清单格式或SHA256无效。'; exit 1; }
[ -n "$candidates" ] || { message "清单中没有适用于${platform}的Node 24/22。"; exit 1; }

if [ -n "${TOOL_DOCTOR_RUNTIME_DIR:-}" ]; then
  cache=$TOOL_DOCTOR_RUNTIME_DIR
elif [ -n "${XDG_DATA_HOME:-}" ]; then
  cache=$XDG_DATA_HOME/codex-tool-doctor/runtimes
elif [ -n "${HOME:-}" ]; then
  cache=$HOME/.local/share/codex-tool-doctor/runtimes
else
  message '请设置HOME、XDG_DATA_HOME或TOOL_DOCTOR_RUNTIME_DIR。'
  exit 1
fi
# Absolute paths also prevent option-like relative paths from reaching rm/mv.
case "$cache" in /*) ;; *) cache=$PWD/$cache ;; esac

sha256_matches() (
  if command -v sha256sum >/dev/null 2>&1; then
    digest=$(sha256sum "$1") || exit 1
  elif command -v shasum >/dev/null 2>&1; then
    digest=$(shasum -a 256 "$1") || exit 1
  elif command -v openssl >/dev/null 2>&1; then
    digest=$(openssl dgst -sha256 "$1") || exit 1
    digest=${digest##* }
  else
    message 'SHA256校验需要sha256sum、shasum或openssl。'
    exit 1
  fi
  digest=${digest%% *}
  [ "$digest" = "$2" ]
)

download() {
  if command -v curl >/dev/null 2>&1; then
    # Disable curlrc and prohibit HTTP even after a redirect. Each request has
    # a total deadline; retries are controlled by the caller, not by curl.
    curl -q --fail --silent --show-error --location --proto '=https' \
      --proto-redir '=https' --tlsv1.2 --connect-timeout 10 --max-time 60 \
      --retry 0 --output "$2" "$1"
  else
    message '自动下载Node需要curl，请先安装curl或提供可用的缓存运行时。'
    return 1
  fi
}

install_runtime() (
  version=$1
  filename=$2
  checksum=$3
  name=${filename%.tar.gz}
  target=$cache/$name
  lock=$cache/.$name.lock
  owned=0
  owner_path=
  stage=
  umask 077

  cleanup() {
    if [ -n "$stage" ]; then rm -rf -- "$stage"; fi
    if [ "$owned" -eq 1 ]; then
      rmdir "$owner_path" 2>/dev/null && rmdir "$lock" 2>/dev/null
    fi
    :
  }
  trap cleanup 0
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM

  mkdir -p -- "$cache" || exit 1
  waited=0
  while :; do
    if mkdir "$lock" 2>/dev/null; then
      # $$ remains the outer shell PID in a POSIX subshell. Have a direct child
      # record its PPID so killing the outer launcher cannot make a still-live
      # installer look dead to another bootstrap.
      if sh -c 'mkdir "$1/owner.$PPID"' sh "$lock"; then
        owner_path=$(printf '%s' "$lock"/owner.*)
        owned=1
        break
      fi
      rmdir "$lock" 2>/dev/null
      exit 1
    fi
    # Reap only a known dead owner. Removing its empty owner directory is the
    # atomic claim: just one waiter may then remove the parent lock. Never
    # recursively delete a lock, steal a live lock, or reap an ownerless lock.
    for owner in "$lock"/owner.*; do
      [ -d "$owner" ] || continue
      pid=${owner##*.}
      case "$pid" in ''|*[!0-9]*|0) continue ;; esac
      # EPERM is not evidence that the owner died. Only ESRCH may be reaped;
      # unknown/localized errors conservatively leave the lock alone.
      owner_error=$(LC_ALL=C kill -0 "$pid" 2>&1) || case "$owner_error" in
        *'No such process'*)
          if rmdir "$owner" 2>/dev/null; then rmdir "$lock" 2>/dev/null; fi
          ;;
      esac
    done
    waited=$((waited + 1))
    [ "$waited" -le 900 ] || { message "等待运行时安装锁超时：$lock"; exit 1; }
    sleep 1
  done

  # A competing bootstrap may have finished while this process was waiting.
  runtime_usable "$target" "$version" && exit 0
  stage=$(mktemp -d "$cache/.$name.stage.XXXXXXXX") || exit 1
  bases='https://nodejs.org/dist https://nodejs.org/download/release'

  verified=0
  for base in $bases; do
    for attempt in 1 2; do
      message "下载${filename}（${base}，尝试${attempt}/2）"
      if download "$base/$version/$filename" "$stage/archive.tar.gz" &&
        sha256_matches "$stage/archive.tar.gz" "$checksum"; then
        verified=1
        break 2
      fi
      message '下载失败或SHA256不匹配，尝试备用下载。'
    done
  done
  [ "$verified" -eq 1 ] || exit 1

  # Reject unexpected roots/traversal before extracting a verified archive.
  tar -tzf "$stage/archive.tar.gz" > "$stage/members" || exit 1
  awk -v root="$name" '
    { if ($0 != root && index($0, root "/") != 1) exit 1
      n = split($0, parts, "/"); for (i = 1; i <= n; i++) if (parts[i] == "..") exit 1
    }
    END { if (NR == 0) exit 1 }
  ' "$stage/members" || { message '运行时归档包含不安全路径。'; exit 1; }
  mkdir "$stage/extract" || exit 1
  tar -xzf "$stage/archive.tar.gz" -C "$stage/extract" --no-same-owner || exit 1
  prepared=$stage/extract/$name
  runtime_usable "$prepared" "$version" || {
    message "${filename}无法运行或缺少可用npm，保留现有缓存。"; exit 1;
  }

  # A healthy published runtime is immutable. Only after staging succeeds may
  # a broken target be moved aside, with rollback if the final rename fails.
  runtime_usable "$target" "$version" && exit 0
  if [ -e "$target" ] || [ -L "$target" ]; then
    mv -- "$target" "$stage/previous" || exit 1
  fi
  if ! mv -- "$prepared" "$target"; then
    if [ -e "$stage/previous" ] || [ -L "$stage/previous" ]; then
      if ! mv -- "$stage/previous" "$target"; then
        message "恢复失败，旧运行时保留在：$stage/previous"
        stage=
      fi
    fi
    exit 1
  fi
  message "已安装便携Node：$target"
)

# Use fd 3 for the manifest, leaving stdin untouched for the interactive menu.
# Prefer an already usable cache (including 22) to any network operation.
rejected=' '
while read -r version filename checksum <&3; do
  [ -n "$filename" ] || continue
  target=$cache/${filename%.tar.gz}
  if runtime_usable "$target" "$version"; then
    launch_runtime "$target" "$@" 3<&-
    status=$?
    [ "$status" -eq 78 ] || exit "$status"
    rejected="$rejected$filename "
  fi
done 3<<EOF
$candidates
EOF

while read -r version filename checksum <&3; do
  [ -n "$filename" ] || continue
  case "$rejected" in *" $filename "*) continue ;; esac
  if install_runtime "$version" "$filename" "$checksum" 3<&- </dev/null; then
    launch_runtime "$cache/${filename%.tar.gz}" "$@" 3<&-
    status=$?
    [ "$status" -eq 78 ] || exit "$status"
  fi
done 3<<EOF
$candidates
EOF

message '无法准备可用的Node 24/22及npm；现有运行时已保留，请检查网络、清单和目录权限。'
exit 1
