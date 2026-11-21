import type { LocalToolCall } from "@pibot/agent";
import { parsePatch } from "@pibot/execution";
import { explainPolicyResult, secretWriteOutDenied } from "@pibot/policy";
import type { PreparedTool } from "../../core/local-types.ts";
import type { LocalService } from "../../local-service.ts";

/** Every target takes the ordinary writer gate; consent is for the exact batch, never its first path. */
export async function preparePatch(
  local: LocalService,
  call: LocalToolCall,
  patch: string,
  prepare: (call: LocalToolCall) => Promise<PreparedTool>,
  fingerprint: (file: PreparedTool) => string,
): Promise<PreparedTool> {
  const entries = parsePatch(patch);
  const files: PreparedTool[] = [];
  for (const file of entries)
    files.push(
      await prepare({ ...call, tool: "write_file", input: { path: file.path, content: "" } }),
    );
  const base = files[0] as PreparedTool;
  // One outside target makes the whole batch that per-call card, whatever the others say.
  const selected =
    files.find((file) => file.result.decision === "deny") ??
    files.find((file) => file.result.outsideWrites?.length) ??
    files.find((file) => file.result.decision === "ask") ??
    files.find((file) => file.result.reason === "yolo") ??
    base;
  const result = explainPolicyResult(
    {
      ...selected.result,
      facts: files.flatMap((file) => file.result.facts),
      risk: files.some((file) => file.result.risk === "danger")
        ? ("danger" as const)
        : ("normal" as const),
      canRemember: false,
    },
    "boundary",
    "consent_scope_narrowed",
    "narrow",
  );
  delete result.grantScope;
  const outsideWrites = [...new Set(files.flatMap((file) => file.result.outsideWrites ?? []))];
  const outsideWriteRoots = [
    ...new Set(files.flatMap((file) => file.result.outsideWriteRoots ?? [])),
  ];
  if (result.decision !== "deny" && outsideWrites.length) {
    result.outsideWrites = outsideWrites;
    result.outsideWriteRoots = outsideWriteRoots;
  } else {
    delete result.outsideWrites;
    delete result.outsideWriteRoots;
  }
  const writeOut = secretWriteOutDenied(call.tool, local.deps.redactor.contains(patch));
  return {
    ...base,
    call,
    result: explainPolicyResult(writeOut ?? result, "boundary", "patch_batch_consent", "narrow"),
    patchPaths: files.map((file) => file.result.path?.path ?? ""),
    patchFingerprints: files.map(fingerprint),
  };
}
