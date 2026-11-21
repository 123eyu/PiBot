#!/bin/sh
# deb 的 prerm 与 rpm 的 %preun 共用，只用 POSIX sh。
# 安装 / 卸载脚本以 root 跑。单元是 systemd 用户单元，跑在各用户自己的用户管理器里；
# 卸载时替每个正在运行的用户管理器停用一次（包括 root 自己的：以 root 登录直接 apt-get remove
# 时 SUDO_USER 为空，旧版本因此什么都不做，执行端继续从已删除的文件运行，F4 2026-11-11）。
# 停不了也不阻塞卸载（「能做到的话」）。
case "${1:-}" in
  0 | remove | purge) ;;
  *) exit 0 ;;   # 升级时不动正在运行的服务
esac

command -v systemctl >/dev/null 2>&1 || exit 0
self=$(id -u)

stop_for() {
  uid=$1
  runtime=/run/user/$uid
  # 只有运行中的用户管理器才有这个套接字；没有就没有可停的单元。
  [ -S "$runtime/systemd/private" ] || return 0
  if [ "$uid" = "$self" ]; then
    XDG_RUNTIME_DIR="$runtime" systemctl --user disable --now pibot-runner.service >/dev/null 2>&1
    return 0
  fi
  name=$(getent passwd "$uid" | cut -d: -f1)
  [ -n "$name" ] || return 0
  # 用户管理器从 XDG_RUNTIME_DIR 找总线，runuser / sudo 都不带它；失败不算卸载失败。
  if command -v runuser >/dev/null 2>&1; then
    runuser -u "$name" -- env XDG_RUNTIME_DIR="$runtime" \
      systemctl --user disable --now pibot-runner.service >/dev/null 2>&1
  elif command -v sudo >/dev/null 2>&1; then
    sudo -u "$name" env XDG_RUNTIME_DIR="$runtime" \
      systemctl --user disable --now pibot-runner.service >/dev/null 2>&1
  fi
  return 0
}

for dir in /run/user/*; do
  [ -d "$dir" ] || continue
  uid=${dir##*/}
  case $uid in
    '' | *[!0-9]*) continue ;;
  esac
  stop_for "$uid"
done

exit 0
