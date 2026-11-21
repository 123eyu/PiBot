import type { LocalService, ToolRunContext } from "@pibot/brain/kit";
import {
  ApprovalChangedError,
  allowedByYolo,
  auditText,
  auditYolo,
  prepareTool,
  toolFingerprint,
  workspaceBoundary,
} from "@pibot/brain/kit";
import { canonicalPath, ExecError } from "@pibot/execution";
import { RpcError, RpcErrorCodes } from "@pibot/images-contract/full";
import { containsPath, explainPolicyResult, recordPolicyStep } from "@pibot/policy";
import { imageArtifactFingerprint } from "@pibot/storage";
import { generatedImageSource } from "./image-workspace-source.ts";
import type { ImageWorkspaceTarget, imageSaveCall } from "./image-workspace-target.ts";

export async function authorizeImageWorkspace(
  local: LocalService,
  context: ToolRunContext,
  target: ImageWorkspaceTarget,
  attachmentId: string,
  call: ReturnType<typeof imageSaveCall>,
) {
  const prepare = async (signal: AbortSignal) => {
    signal = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
    generatedImageSource(local, { ...context, signal }, target, attachmentId);
    // Current operator policy applies; old routine fields are provenance, never fresh authority.
    const prepared = await prepareTool(local, { ...context, signal }, call, signal);
    const frozen = await workspaceBoundary(
      target.boundary.roots,
      target.boundary.revision,
      local.deps.platform,
      signal,
    );
    if (
      (await canonicalPath(target.cwd, target.cwd)) !== target.cwd ||
      prepared.result.path?.path !== call.input.path ||
      !prepared.boundary ||
      imageArtifactFingerprint(frozen) !== imageArtifactFingerprint(target.boundary)
    )
      throw new ExecError("outside_workplace");
    const path = String(call.input.path);
    if (
      !target.boundary.writeRoots.some((root) => containsPath(root, path, local.deps.platform)) ||
      target.boundary.denyWriteRoots.some((root) => containsPath(root, path, local.deps.platform))
    ) {
      prepared.result.decision = "deny";
      prepared.result.reason = "workspace_readonly";
      recordPolicyStep(prepared.result, "boundary", "workspace_readonly");
    }
    generatedImageSource(local, { ...context, signal }, target, attachmentId);
    return prepared;
  };
  const prepared = await prepare(context.signal),
    fingerprint = toolFingerprint(prepared);
  // Preserve policy scope for routine preauthorization/trial learning; human consent is one file.
  const consent = (result: typeof prepared.result) => {
    const singleFile = explainPolicyResult(
      { ...result, canRemember: false },
      "boundary",
      "consent_scope_narrowed",
      "narrow",
    );
    delete singleFile.grantScope;
    recordPolicyStep(singleFile, "grant", "image_single_file_consent", "narrow");
    return singleFile;
  };
  let preauthId: string | undefined;
  let preauthRoot: string | undefined;
  const revalidate = async (signal: AbortSignal) => {
    const current = await prepare(signal);
    if (
      toolFingerprint(current) !== fingerprint ||
      (preauthId &&
        local.unattendedAuthorization.match({ ...context, signal }, current, true)?.id !==
          preauthId)
    )
      throw new ExecError("outside_workplace");
  };
  const allowed = await local.approvals.serial(
    context.botId,
    context.signal,
    async () => {
      if (prepared.result.decision === "deny") {
        local.approvals.audit.append({
          botId: context.botId,
          runId: context.runId,
          kind: "policy.denied",
          summary: "Image save denied / 图片保存被拒绝",
          detail: {
            toolName: "write_file",
            category: "write_file",
            decision: "deny",
            target: auditText(String(call.input.path), local.deps.redactor),
            reasonCode: prepared.result.reason,
            policySteps: prepared.result.explanation.map((step) => step.code),
          },
        });
        return false;
      }
      const preauth = context.routineRunId
        ? local.unattendedAuthorization.match(context, prepared, true)
        : undefined;
      if (preauth) {
        preauthId = preauth.id;
        preauthRoot =
          preauth.operation.scope.kind === "workplace" ? preauth.operation.scope.root : undefined;
        local.unattendedAuthorization.audit(context, "routine.preauth.allowed", {
          preauthId,
          reasonCode: "routine_preauth",
          policySteps: [...prepared.result.explanation.map((step) => step.code), "routine_preauth"],
        });
      }
      if (allowedByYolo(prepared.result)) auditYolo(local, context, call, prepared.result);
      if (prepared.result.decision === "ask" && !preauthId) {
        const status = await local.approvals.request(
          context,
          call,
          consent(prepared.result),
          { available: true },
          async () => {
            try {
              const next = await prepare(context.signal);
              return consent(
                toolFingerprint(next) === fingerprint
                  ? next.result
                  : explainPolicyResult(
                      { ...next.result, decision: "deny", reason: "changed" },
                      "boundary",
                      "changed",
                    ),
              );
            } catch (error) {
              context.signal.throwIfAborted();
              // A vanished/replaced root or owner invalidates consent; don't strand a pending card.
              if (
                (error instanceof ExecError &&
                  ["outside_workplace", "invalid_input"].includes(error.code)) ||
                (error instanceof RpcError && error.code === RpcErrorCodes.invalidParams) ||
                (error instanceof Error && "code" in error && error.code === "ENOENT")
              )
                return consent(
                  explainPolicyResult(
                    {
                      ...prepared.result,
                      decision: "deny",
                      reason: "changed",
                    },
                    "boundary",
                    "changed",
                  ),
                );
              throw error;
            }
          },
          () => {
            generatedImageSource(local, context, target, attachmentId);
            if (context.signal.aborted) throw new ApprovalChangedError();
          },
        );
        if (status !== "allowed") return false;
      }
      await revalidate(context.signal);
      if (context.routineRunId) local.unattendedAuthorization.allowed(context, prepared, true);
      return true;
    },
    context.toolTiming?.(call.id),
  );
  return allowed
    ? { prepared, revalidate, writeRoots: preauthRoot ? [preauthRoot] : target.boundary.writeRoots }
    : undefined;
}
