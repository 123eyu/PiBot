import type { PreparedTool } from "../../core/local-types.ts";
import type { BinaryToolRun } from "../media/office-port.ts";
import { approveDerived } from "./derived-approval.ts";
import { authorizationSnapshot, toolFingerprint } from "./local-prepare.ts";
import { ToolAuthorizationError } from "./local-run/local-run-shared.ts";
import type { LocalRun } from "./local-run.ts";

/** Derived reads retain their own receipt without replacing the original write credential. */
export function officeDerivedReads(
  run: LocalRun,
  parent: PreparedTool,
): Pick<BinaryToolRun, "approve" | "assertDerivedRead"> {
  const issued = new WeakMap<PreparedTool, { fingerprint: string; preauthId?: string }>();
  const refuse = () => {
    throw new ToolAuthorizationError("Derived read authorization changed");
  };
  return {
    async approve(call, signal) {
      signal.throwIfAborted();
      run.assertDispatch(parent);
      if (call.id !== parent.call.id || call.tool !== "read_file") return refuse();
      const read = await approveDerived(run, call, signal, {
        onApproved: (approved, preauthId) =>
          issued.set(approved, { fingerprint: toolFingerprint(approved), preauthId }),
      });
      signal.throwIfAborted();
      run.assertDispatch(parent);
      return read;
    },
    async assertDerivedRead(read, signal) {
      signal.throwIfAborted();
      run.assertDispatch(parent);
      const receipt = issued.get(read);
      if (
        !receipt ||
        read.call.id !== parent.call.id ||
        read.call.tool !== "read_file" ||
        !read.result.path ||
        read.result.category === "read_ai_config" ||
        receipt.fingerprint !== toolFingerprint(read) ||
        !run.local.execution.allows(run.context, read.call.tool) ||
        authorizationSnapshot(run.local, run.context.botId, run.context) !== read.authorization
      )
        return refuse();
      // Re-resolve canonical paths and root identities: a snapshot alone cannot detect swaps.
      const current = await run.prepare(read.call, signal);
      signal.throwIfAborted();
      run.assertDispatch(parent);
      if (
        current.result.decision === "deny" ||
        receipt.fingerprint !== toolFingerprint(read) ||
        receipt.fingerprint !== toolFingerprint(current) ||
        (receipt.preauthId &&
          run.local.unattendedAuthorization.match(run.context, current, true)?.id !==
            receipt.preauthId)
      )
        return refuse();
      run.local.userSecrets.assertUses(read.secretUses ?? [], run.context.botId);
    },
  };
}
