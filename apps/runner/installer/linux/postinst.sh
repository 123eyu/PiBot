#!/bin/sh
# deb 与 rpm 的 %post 共用；只用 POSIX sh。安装时不替任何人启用用户单元，只打印该怎么用。

cat <<'MESSAGE'
Pi Bot Runner 已安装到 /opt/pibot-runner （/usr/bin/pibot）。
Pi Bot Runner installed to /opt/pibot-runner (/usr/bin/pibot).

启用执行端（systemd 用户单元，没有替你启用）/ enable the per-user service:
  systemctl --user daemon-reload
  systemctl --user enable --now pibot-runner.service
状态 / status:
  systemctl --user status pibot-runner.service
  pibot runner status
配对（先停单元，配对完再起）/ pair (stop the unit first, then start it again):
  systemctl --user stop pibot-runner.service
  pibot runner pair
  systemctl --user start pibot-runner.service

没有 Secret Service 的机器（无桌面会话 / 无 keyring）需要口令。写进
~/.config/pibot-runner/env （权限 0600），单元通过 EnvironmentFile 读它：
  mkdir -p ~/.config/pibot-runner && chmod 700 ~/.config/pibot-runner
  echo 'PIBOT_RUNNER_PASSPHRASE=<口令>' > ~/.config/pibot-runner/env
  chmod 600 ~/.config/pibot-runner/env
不要写进单元文件的 Environment=：那是明文，本机任何用户都能读到。

Headless machines without a Secret Service need the passphrase in
~/.config/pibot-runner/env (mode 0600), never in the unit file's Environment=.
MESSAGE

# Ubuntu 24.04 起默认限制非特权 user namespace，bubblewrap 会启动失败，
# 执行端的每条命令都会因隔离不可用而拒绝执行。安装时先说清楚怎么修。
restrict=/proc/sys/kernel/apparmor_restrict_unprivileged_userns
if [ -r "$restrict" ] && [ "$(cat "$restrict")" = "1" ]; then
  cat <<'MESSAGE'

注意 / warning: 本机限制了非特权 user namespace
(kernel.apparmor_restrict_unprivileged_userns=1)，bubblewrap 沙箱可能无法启动，
执行端的命令在修好之前不会运行。两种修法 / two fixes:
  1) 给 bwrap 加 AppArmor 配置（Ubuntu 推荐）：
     把下面内容写进 /etc/apparmor.d/bwrap，然后 sudo apparmor_parser -r /etc/apparmor.d/bwrap
       abi <abi/4.0>,
       include <tunables/global>
       profile bwrap /usr/bin/bwrap flags=(unconfined) {
         userns,
         include if exists <local/bwrap>
       }
  2) 调 sysctl（隔离变弱，重启后失效）：
     sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0

This kernel restricts unprivileged user namespaces, so the bubblewrap sandbox
may fail to start; commands will not run if isolation is unavailable. Install an AppArmor
profile for /usr/bin/bwrap (recommended) or set the sysctl to 0 (weaker isolation).
MESSAGE
fi

exit 0
