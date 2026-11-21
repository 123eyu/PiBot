/**
 * A Linux host can fail to isolate commands for distinct reasons, and the person
 * who has to fix a headless runner is usually reading one of: the runner's own log, the output of
 * `pibot runner status`, the refusal a tool call returns, or the Linux package's postinst.
 * The pure-data subpath is also consumed by i18n; never import Node/SRT or the execution root here.
 */
export interface IsolationRemedy {
  zh: string;
  en: string;
}

/** Shared wording contains no host values; the same sysctl advice is shown on every surface. */
export const linuxUserNamespaceRemedies = {
  linux_userns_disabled: {
    zh: "kernel.unprivileged_userns_clone=0 禁止非特权用户命名空间。请让管理员确认本机安全策略后运行 sudo sysctl -w kernel.unprivileged_userns_clone=1，然后重新启动 Pi Bot 或执行端；这会允许本机其他程序创建用户命名空间。",
    en: "kernel.unprivileged_userns_clone=0 disables unprivileged user namespaces. Ask an administrator to review the security policy, then run sudo sysctl -w kernel.unprivileged_userns_clone=1 and restart Pi Bot or the runner. This also enables user namespaces for other programs.",
  },
  linux_userns_limit_zero: {
    zh: "user.max_user_namespaces=0 禁止创建用户命名空间。请让管理员按本机安全策略设置非零额度，例如 sudo sysctl -w user.max_user_namespaces=15000，然后重新启动 Pi Bot 或执行端；这会允许本机其他程序创建用户命名空间。",
    en: "user.max_user_namespaces=0 prevents user namespace creation. Ask an administrator to set a nonzero limit under the local security policy, for example sudo sysctl -w user.max_user_namespaces=15000, then restart Pi Bot or the runner. This also permits user namespaces for other programs.",
  },
} as const;

export const linuxUserNamespacePersistence = {
  zh: "sysctl -w 只对当前系统运行有效；如需持久化，由管理员将相应设置写入 /etc/sysctl.d/ 下的文件。启用 user namespace 会允许非特权程序使用该内核能力。",
  en: "sysctl -w lasts for the current boot only. For persistence, an administrator can write the setting under /etc/sysctl.d/. Enabling user namespaces lets unprivileged programs use this kernel capability.",
} as const;

/**
 * Only the desktop ships as an AppImage. The runner reuses the same AppArmor profile
 * advice but has no AppImage entry, so its wording must not tell the operator to launch one.
 */
function appArmorRemedy(
  profile: string,
  configuration: string,
  restart: { zh: string; en: string },
): IsolationRemedy {
  const command = `sudo apparmor_parser -r ${configuration}`;
  return {
    zh: `实际沙箱探测失败，系统同时启用了 AppArmor 的非特权 user namespace 限制（linux_userns_restricted）。管理员可把下方 profile 保存到 ${configuration}，再运行 ${command}，${restart.zh}。\n\n${profile}\n\n另一种办法：sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0。这会放宽本机所有程序的限制，削弱这条路径上的 AppArmor 保护。${linuxUserNamespacePersistence.zh}`,
    en: `The actual sandbox probe failed while AppArmor restricts unprivileged user namespaces (linux_userns_restricted). An administrator can save the profile below to ${configuration}, run ${command}, and ${restart.en}.\n\n${profile}\n\nAlternatively: sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0. This relaxes the restriction for every application and weakens AppArmor protection along this path. ${linuxUserNamespacePersistence.en}`,
  };
}

const appImageRestart = {
  zh: "然后从原入口重新启动（AppImage 请从原 AppImage 启动，不要直接运行临时挂载目录的二进制）",
  en: "then restart from the original entry (for AppImage, launch the original AppImage rather than a binary in its temporary mount)",
} as const;

const runnerRestart = {
  zh: "然后重新启动执行端（pibot runner）",
  en: "then restart the execution device's pibot runner",
} as const;

/** A template only: the host escapes the local AppImage path before substitution in the dialog. */
export const linuxAppImageRemedy = appArmorRemedy(
  'abi <abi/4.0>,\ninclude <tunables/global>\nprofile pibot "{appImagePath}" flags=(unconfined) {\n  userns,\n}',
  "/etc/apparmor.d/pibot",
  appImageRestart,
);

/** AppArmor quoted path syntax still treats glob characters specially. Never generate a wildcard. */
export function appArmorExecutable(path: string | undefined): string {
  if (!path?.startsWith("/") || path.length > 4096 || /[\p{Cc}\p{Cf}]/u.test(path))
    return "/absolute/path/PiBot.AppImage";
  return path.replace(/[\\"*?[\]{}^]/g, (character) => `\\${character}`);
}

const bwrapAppArmorRemedy = (restart: { zh: string; en: string }) =>
  appArmorRemedy(
    "abi <abi/4.0>,\ninclude <tunables/global>\nprofile bwrap /usr/bin/bwrap flags=(unconfined) {\n  userns,\n  include if exists <local/bwrap>\n}",
    "/etc/apparmor.d/bwrap",
    restart,
  );

export const linuxIsolationRemedies = {
  ...linuxUserNamespaceRemedies,
  linux_userns_restricted: bwrapAppArmorRemedy(appImageRestart),
  linux_bubblewrap_missing: {
    zh: "没有找到 bubblewrap（bwrap），命令隔离需要它。请安装（Debian/Ubuntu：sudo apt install bubblewrap；Fedora：sudo dnf install bubblewrap），然后重启执行端的 pibot runner。",
    en: "bubblewrap (bwrap) is missing and command isolation needs it. Install it (Debian/Ubuntu: sudo apt install bubblewrap; Fedora: sudo dnf install bubblewrap), then restart pibot runner on the execution device.",
  },
  linux_socat_missing: {
    zh: "没有找到 socat，命令隔离用它转发沙箱内的网络访问。请安装（Debian/Ubuntu：sudo apt install socat；Fedora：sudo dnf install socat），然后重启执行端的 pibot runner。",
    en: "socat is missing; command isolation uses it to forward network access inside the sandbox. Install it (Debian/Ubuntu: sudo apt install socat; Fedora: sudo dnf install socat), then restart pibot runner on the execution device.",
  },
  linux_seccomp_helper_unavailable: {
    zh: "无法执行命令隔离的 apply-seccomp 辅助程序。请确认安装包完整、辅助程序可执行，且其目录在沙箱内只读可见；可重新安装执行端后重启。不要开放整个临时目录，也不要关闭沙箱。",
    en: "The apply-seccomp isolation helper could not run. Check package integrity, executable permissions, and readonly visibility of its directory inside the sandbox; reinstall the execution device package and restart if needed. Keep the rest of the temporary directory hidden and the sandbox enabled.",
  },
  sandbox_dependencies_or_runtime_unavailable: {
    zh: "隔离组件缺失或无法启动。请确认已安装 bubblewrap 和 socat，并查看执行端日志里的隔离信息（pibot runner status 也会显示）。",
    en: "The isolation components are missing or failed to start. Check that bubblewrap and socat are installed and read the isolation entry in the execution device's log (pibot runner status shows it too).",
  },
} satisfies Record<string, IsolationRemedy>;

/** The runner has no AppImage, so its remedy text must not mention one. */
export const linuxRunnerIsolationRemedies = {
  ...linuxIsolationRemedies,
  linux_userns_restricted: bwrapAppArmorRemedy(runnerRestart),
} satisfies Record<string, IsolationRemedy>;

function remedyFrom(
  remedies: Record<string, IsolationRemedy>,
  reason: string | undefined,
): IsolationRemedy | undefined {
  return reason && Object.hasOwn(remedies, reason) ? remedies[reason] : undefined;
}

/** Only Linux codes carry a concrete fix; other platforms report their state without one. */
export function linuxIsolationRemedy(reason: string | undefined): IsolationRemedy | undefined {
  return remedyFrom(linuxIsolationRemedies, reason);
}

/** Same codes for the headless runner, with fixes that apply to a service, not an AppImage. */
export function linuxRunnerIsolationRemedy(
  reason: string | undefined,
): IsolationRemedy | undefined {
  return remedyFrom(linuxRunnerIsolationRemedies, reason);
}
