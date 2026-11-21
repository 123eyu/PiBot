import { createHash } from "node:crypto";
import { memoryWritePolicy } from "@pibot/policy";
import type { ToolRunContext } from "../../core/local-types.ts";
import { runPermissionScope } from "../../core/run-permissions.ts";
import type { LocalService } from "../../local-service.ts";
import { memoryProjectPath } from "../memory/project.ts";
import type { ToolInput } from "./tools.ts";

export function memoryWriteFacts(local: LocalService, context: ToolRunContext, input: ToolInput) {
  if (
    input.tool !== "memory_add" &&
    input.tool !== "memory_update" &&
    input.tool !== "memory_remove"
  )
    return undefined;
  const groupId = runPermissionScope(local, context);
  const target =
    input.tool === "memory_add"
      ? undefined
      : local.memory.writeTarget(
          context.botId,
          input.args.id,
          input.args.scope,
          groupId,
          memoryProjectPath(context),
        );
  const scope =
    input.args.scope ??
    target?.scope ??
    (input.tool === "memory_add" && input.args.category === "about_you"
      ? "user"
      : groupId
        ? "group"
        : "bot");
  const text =
    input.tool === "memory_add"
      ? input.args.text
      : input.tool === "memory_update" && input.args.text !== undefined
        ? input.args.text
        : target?.text;
  return { text, scope, afterUntrusted: context.untrustedContent?.seen === true };
}

export function memorySafetySnapshot(facts: NonNullable<ReturnType<typeof memoryWriteFacts>>) {
  return {
    digest: createHash("sha256")
      .update(facts.text ?? "")
      .digest("hex"),
    reason: memoryWritePolicy(facts).reason,
    scope: facts.scope,
  };
}
