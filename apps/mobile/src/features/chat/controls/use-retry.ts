import { useState } from "react";
import { useLinkState, useRuntime, useText } from "../../../runtime/context.tsx";
import { confirmLocally } from "../../../runtime/local-auth.ts";
import { useAction } from "../../../runtime/use-action.ts";
import { previewRetry, retryFrom } from "./calls.ts";
import { type ChatScope, isDm, scopeKey } from "./scope.ts";

export interface RetryPlan {
  messageId: string;
  hash: string;
  fileCount: number;
  restoreFiles: boolean;
}
/**
 * "从这里重试" on a DM message: preview what is discarded/restored, then confirm. Restoring files is
 * an undo of file changes, so it asks for the same phone unlock as restoring from Changes.
 */
export function useRetry(scope: ChatScope | undefined) {
  const runtime = useRuntime(),
    mobile = useLinkState(),
    t = useText();
  const action = useAction(`${mobile.selectedId}:retry:${scopeKey(scope)}`, mobile.peer);
  const [plan, setPlan] = useState<RetryPlan>();
  return {
    action,
    plan,
    enabled: !!scope && isDm(scope),
    dismiss: () => setPlan(undefined),
    prepare: (messageId: string) =>
      action.run(async (signal) => {
        if (!scope || !isDm(scope)) return;
        const preview = await previewRetry(runtime, scope, messageId, signal);
        signal.throwIfAborted();
        setPlan({ messageId, ...preview });
        return true;
      }),
    confirm: () =>
      action.run(async (signal) => {
        if (!scope || !plan) return;
        if (plan.restoreFiles && plan.fileCount > 0)
          await confirmLocally(t("unlockRetry"), t("cancel"), signal);
        await retryFrom(runtime, scope, plan.messageId, plan.hash, signal);
        signal.throwIfAborted();
        setPlan(undefined);
        return true;
      }),
  };
}
