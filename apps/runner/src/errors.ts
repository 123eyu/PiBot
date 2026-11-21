import { UnsafeSandboxEnvironmentError } from "@pibot/execution/host-environment";

const BUSINESS_CODES = new Set([
  "invalid_arguments",
  "runner_already_running",
  "runner_lock_invalid",
  "runner_lock_recovery_busy",
  "passphrase_required",
  "passphrase_invalid",
  "identity_corrupt",
  "system_credentials_failed",
  "drain_incomplete",
  "cancelled",
  "runner_already_paired",
  "runner_pair_failed",
  "invalid_relay",
  "pairing_relay_mismatch",
  "invalid_pairing",
]);

type RunnerFailure =
  | { code: string; messageZh?: string; messageEn?: string }
  | {
      code: "unsafe_sandbox_environment";
      variables: UnsafeSandboxEnvironmentError["variables"];
      messageZh: string;
      messageEn: string;
    };

export function runnerFailure(error: unknown): RunnerFailure {
  if (error instanceof UnsafeSandboxEnvironmentError) {
    const reasons = error.variables.map((name) =>
      name === "SRT_DEBUG"
        ? { zh: `${name} 可能输出命令原文`, en: `${name} can log raw commands` }
        : {
            zh: `${name} 会覆盖受保护的临时目录`,
            en: `${name} overrides the protected temporary directory`,
          },
    );
    const names = error.variables.join(", ");
    return {
      code: "unsafe_sandbox_environment",
      variables: error.variables,
      messageZh: `执行端拒绝启动：${reasons.map(({ zh }) => zh).join("；")}。请从启动终端或服务的环境配置中移除 ${names}，再启动执行端。`,
      messageEn: `Runner refused to start: ${reasons.map(({ en }) => en).join("; ")}. Remove ${names} from the launching shell or service environment, then start the runner again.`,
    };
  }
  if (error instanceof Error && error.message === "pairing_relay_mismatch")
    return {
      code: "pairing_relay_mismatch",
      messageZh: "配对码中的中继与 --relay 不一致，请移除 --relay 或在电脑上重新生成配对码。",
      messageEn:
        "The code relay differs from --relay. Remove --relay or generate a new code on the computer.",
    };
  if (error instanceof Error && BUSINESS_CODES.has(error.message)) return { code: error.message };
  // The runtime puts the startup failure first and still reports cleanup failures separately.
  if (error instanceof AggregateError) {
    const primary = runnerFailure(error.errors[0]);
    return primary.code === "internal" ? { code: "lifecycle_failed" } : primary;
  }
  return { code: "internal" };
}

export function runnerErrorCode(error: unknown): string {
  return runnerFailure(error).code;
}

/** Permanent service configuration errors must not restart forever; failed drain still wins. */
export function runnerExitCode(error: unknown): number {
  return runnerFailure(error).code === "unsafe_sandbox_environment" ? 78 : 1;
}
