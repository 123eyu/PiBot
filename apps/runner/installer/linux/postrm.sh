#!/bin/sh
# deb 的 postrm 与 rpm 的 %postun 共用。卸载不删用户数据目录，这里只说明一句。
case "${1:-}" in
  0 | remove | purge) ;;
  *) exit 0 ;;   # 升级时不提示
esac

cat <<'MESSAGE'
Pi Bot Runner 已卸载，配对数据和日志保留在 ~/.local/share/pibot-runner
（或 $XDG_DATA_HOME/pibot-runner、$PIBOT_DATA_DIR）。不再需要时手动删除该目录。
Pi Bot Runner was removed. Pairing data and logs stay in ~/.local/share/pibot-runner
(or $XDG_DATA_HOME/pibot-runner, $PIBOT_DATA_DIR); delete that directory to remove them.
MESSAGE

exit 0
