import { readFile } from "node:fs/promises";

const settings = {
  clone: "/proc/sys/kernel/unprivileged_userns_clone",
  max: "/proc/sys/user/max_user_namespaces",
  apparmor: "/proc/sys/kernel/apparmor_restrict_unprivileged_userns",
} as const;

export type LinuxUserNamespaceSettings = Record<keyof typeof settings, number | undefined>;

/** A missing optional sysctl is normal on other kernels; unreadable values remain unknown. */
export async function linuxUserNamespaceSettings(
  signal?: AbortSignal,
): Promise<LinuxUserNamespaceSettings> {
  const values = await Promise.all(
    Object.values(settings).map(async (file) => {
      try {
        const raw = (await readFile(file, { encoding: "utf8", signal })).trim();
        return /^\d+$/.test(raw) ? Number(raw) : undefined;
      } catch {
        signal?.throwIfAborted();
        // The real sandbox probe, rather than an absent sysctl, decides availability.
        return undefined;
      }
    }),
  );
  return { clone: values[0], max: values[1], apparmor: values[2] };
}

/** AppArmor=1 alone is not a denial: an application profile may explicitly allow userns. */
export function linuxUserNamespaceRestriction(settings: LinuxUserNamespaceSettings) {
  if (settings.clone === 0) return "kernel.unprivileged_userns_clone";
  if (settings.max === 0) return "user.max_user_namespaces";
  return undefined;
}
