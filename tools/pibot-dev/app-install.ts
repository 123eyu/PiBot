import { randomUUID } from "node:crypto";
import type { MacArtifact } from "./app-artifact.ts";

export interface InstallPorts {
  activity(): string[];
  inspect(path: string, signal: AbortSignal): MacArtifact | Promise<MacArtifact>;
  exists(path: string): boolean;
  copy(source: string, target: string, signal: AbortSignal): void | Promise<void>;
  rename(source: string, target: string): void;
  remove(path: string): void;
  processes(): number[];
  stop(): void;
  open(signal: AbortSignal): void | Promise<void>;
  ready(artifact: MacArtifact, since: string, signal: AbortSignal): Promise<boolean>;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  now(): number;
  receipt(value: object): void;
}

export function unfinishedInstallReceipt(text: string) {
  const line = text.trim().split("\n").at(-1);
  if (!line) return false;
  try {
    const value = JSON.parse(line) as { status?: unknown };
    return value.status !== "ready" && value.status !== "failed";
  } catch {
    return true;
  }
}

async function waitExited(ports: InstallPorts, signal: AbortSignal) {
  const deadline = ports.now() + 60_000;
  while (ports.processes().length) {
    signal.throwIfAborted();
    if (ports.now() >= deadline) throw new Error("installed_app_exit_unconfirmed");
    await ports.sleep(250, signal);
  }
}

/** Same-parent two-rename transaction. A failed new launch never erases the only old bundle. */
export async function installMacArtifact(
  source: string,
  installed: string,
  waitMs: number,
  ports: InstallPorts,
  callerSignal?: AbortSignal,
) {
  const timeout = AbortSignal.timeout(Math.max(180_000, waitMs + 180_000));
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
  const stage = `${installed}.stage-${randomUUID()}`,
    backup = `${installed}.backup-${randomUUID()}`;
  let oldMoved = false,
    newMoved = false,
    openRequested = false,
    staged = false,
    confirmed = false;
  const deadline = ports.now() + waitMs;
  const receipt = (value: object) => {
    try {
      ports.receipt(value);
    } catch {
      throw new Error("install_receipt_unavailable");
    }
  };
  const expected = await ports.inspect(source, signal);
  if (expected.path === installed || expected.path.startsWith(`${installed}/`))
    throw new Error("install_source_is_installed_app");
  try {
    for (;;) {
      signal.throwIfAborted();
      const active = ports.activity();
      if (active.some((id) => id.startsWith("unknown:")))
        throw new Error("install_activity_unknown");
      if (!active.length) break;
      if (ports.now() >= deadline) throw new Error("install_owner_busy");
      await ports.sleep(Math.min(1000, Math.max(1, deadline - ports.now())), signal);
    }
    // Copy/signature verification cannot take the installed bundle away on failure.
    staged = true;
    await ports.copy(source, stage, signal);
    if ((await ports.inspect(stage, signal)).digest !== expected.digest)
      throw new Error("install_stage_identity_mismatch");
    signal.throwIfAborted();
    if (ports.activity().length) throw new Error("install_activity_changed");
    receipt({ status: "prepared", artifact: expected, installed, stage, backup });
    if (ports.processes().length) ports.stop();
    await waitExited(ports, signal);
    signal.throwIfAborted();
    if (ports.activity().length) throw new Error("install_activity_changed");
    if (ports.exists(installed)) {
      ports.rename(installed, backup);
      oldMoved = true;
    }
    ports.rename(stage, installed);
    newMoved = true;
    staged = false;
    if ((await ports.inspect(installed, signal)).digest !== expected.digest)
      throw new Error("install_identity_mismatch");
    signal.throwIfAborted();
    const since = new Date(ports.now()).toISOString();
    openRequested = true;
    await ports.open(signal);
    if (!(await ports.ready(expected, since, signal))) throw new Error("install_ready_unconfirmed");
    confirmed = true;
    receipt({
      status: "ready",
      artifact: { ...expected, path: installed },
      backup: oldMoved ? backup : null,
      since,
    });
  } catch (error) {
    // A receipt failure after observed readiness cannot invite replay or stop a healthy owner.
    if (confirmed) throw new Error("install_ready_receipt_failed_do_not_retry");
    // After launch, restore bytes only once the failed new owner really exited. Never downgrade
    // user data or automatically reopen an old executable against possibly migrated data.
    let restored = false;
    if (newMoved) {
      try {
        if (ports.processes().length) ports.stop();
        await waitExited(ports, AbortSignal.timeout(65_000));
        ports.rename(installed, stage);
        staged = true;
        newMoved = false;
        if (oldMoved) {
          ports.rename(backup, installed);
          oldMoved = false;
          restored = true;
        }
      } catch {
        receipt({
          status: "recovery_required",
          oldBundlePreserved: oldMoved,
          backup,
          installed,
          openRequested,
        });
        throw new Error("install_failed_recovery_required_old_bundle_preserved");
      }
    } else if (oldMoved) {
      try {
        ports.rename(backup, installed);
        oldMoved = false;
        restored = true;
      } catch {
        throw new Error("install_failed_restore_required_old_bundle_preserved");
      }
    }
    receipt({
      status: "failed",
      restored,
      openRequested,
      oldAppReopened: false,
      stage: staged ? stage : null,
    });
    if (signal.aborted) throw signal.reason;
    throw new Error(
      restored
        ? "install_failed_old_bundle_restored_not_reopened"
        : error instanceof Error && /^install_[a-z_]+$/.test(error.message)
          ? error.message
          : "install_failed",
    );
  } finally {
    if (staged) {
      try {
        ports.remove(stage);
      } catch {
        // Every staged exit already failed. Preserve that error and block retries until the
        // leftover staging directory is inspected, rather than hiding a rollback failure.
        receipt({ status: "recovery_required", reason: "stage_cleanup_required", stage, backup });
      }
    }
  }
}
