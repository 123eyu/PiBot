import { readFile } from "node:fs/promises";

export type LinuxIsolationFailure =
  | "linux_bubblewrap_missing"
  | "linux_socat_missing"
  | "linux_userns_disabled"
  | "linux_userns_limit_zero"
  | "linux_seccomp_helper_unavailable"
  | "linux_userns_restricted"
  | "sandbox_dependencies_or_runtime_unavailable";

/**
 * Why the Linux probe failed, as a stable code the UI can explain. Called only after the real
 * initialization or `true` probe failed, so these are attributions, not a second gate.
 */
export async function linuxIsolationFailure(
  rg: string,
  diagnostic?: string,
): Promise<LinuxIsolationFailure> {
  // Synchronous `which` lookups only; this runs once per failed initialization.
  const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
  const { errors } = SandboxManager.checkDependencies(rg ? { command: rg } : undefined);
  if (errors.some((error) => error.includes("bwrap"))) return "linux_bubblewrap_missing";
  if (errors.some((error) => error.includes("socat"))) return "linux_socat_missing";
  if (diagnostic?.includes("apply-seccomp")) return "linux_seccomp_helper_unavailable";
  // Anything else missing (e.g. the bundled ripgrep) is not explained by the namespace policy.
  if (errors.length) return "sandbox_dependencies_or_runtime_unavailable";
  for (const [path, reason] of [
    ["/proc/sys/kernel/unprivileged_userns_clone", "linux_userns_disabled"],
    ["/proc/sys/user/max_user_namespaces", "linux_userns_limit_zero"],
  ] as const) {
    // Kernels may omit these switches; unreadable settings provide no evidence of a zero limit.
    const value = await readFile(path, "utf8").catch(() => undefined);
    if (value?.trim() === "0") return reason;
  }
  // Ubuntu 24.04+ default: bubblewrap itself is allowed by its AppArmor profile, but processes
  // inside it run under unpriv_bwrap with every capability denied, so SRT's seccomp helper
  // cannot set up its nested user namespace (measured on Ubuntu 26.04). The sysctl is the switch Ubuntu documents for it.
  const restricted = await readFile("/proc/sys/kernel/apparmor_restrict_unprivileged_userns", {
    encoding: "utf8",
  }).then(
    (value) => value.trim() === "1",
    // Missing on kernels without the Ubuntu AppArmor patch: the restriction cannot be the cause.
    () => false,
  );
  return restricted ? "linux_userns_restricted" : "sandbox_dependencies_or_runtime_unavailable";
}

/** Only fixed, recognized failure text survives; probe output may contain host paths or secrets. */
export function linuxProbeDiagnostic(output: string): string | undefined {
  if (
    /bwrap: [^\r\n]*(?:No space left on device|\(ENOSPC\)|max_\*_namespaces exceeded)/.test(output)
  )
    return "bwrap: No space left on device";
  if (/bwrap: [^\r\n]*(?:Operation not permitted|\(EPERM\))/.test(output))
    return "bwrap: Operation not permitted";
  if (
    /apply-seccomp[^\r\n]*(?:not found|No such file or directory|Permission denied)/i.test(output)
  )
    return "apply-seccomp: unavailable (not found or not executable)";
  return undefined;
}
