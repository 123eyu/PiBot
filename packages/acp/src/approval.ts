/*
 * The ACP approval bridge: Pi Bot's approval request becomes the editor's permission card, and the
 * editor's answer (only the options this card offered) becomes the approval decision. Kept apart
 * from the turn bookkeeping because it is the one place a person's choice enters the run.
 */
import { methods } from "@agentclientprotocol/sdk";
import type { createApprovalRequests } from "./approval-requests.ts";
import { approvalText } from "./messages.ts";
import { permissionOutcome } from "./schemas.ts";
import type { AcpApproval, AcpClientPort, AcpRuntimePort } from "./types.ts";

export interface ApprovalBridge {
  clientPort: AcpClientPort | undefined;
  permissions: ReturnType<typeof createApprovalRequests>;
  runtime: AcpRuntimePort;
  sessionId: string;
  locale: "zh" | "en";
  turnSignal: AbortSignal;
}

export async function bridgeApproval(bridge: ApprovalBridge, approval: AcpApproval) {
  if (!bridge.clientPort) throw new Error("ACP client is not initialized");
  const client = bridge.clientPort;
  const { permissions, locale, turnSignal } = bridge;
  await permissions.request(
    approval.id,
    (permissionSignal) =>
      client.request(
        methods.client.session.requestPermission,
        {
          sessionId: bridge.sessionId,
          toolCall: {
            toolCallId: approval.toolCallId,
            kind: approval.category === "command" ? "execute" : "other",
            status: "pending",
            title: approvalText(approval, locale),
            name: approval.category,
          },
          options: [
            {
              optionId: "allow_once",
              name: locale === "zh" ? "允许一次" : "Allow once",
              kind: "allow_once",
            },
            ...(approval.editorSession
              ? [
                  {
                    optionId: "allow_always",
                    name: locale === "zh" ? "本次会话都允许" : "Allow for this session",
                    kind: "allow_always" as const,
                  },
                ]
              : []),
            {
              optionId: "reject_once",
              name: locale === "zh" ? "拒绝" : "Reject",
              kind: "reject_once",
            },
          ],
        },
        permissionSignal,
      ),
    async (raw) => {
      const outcome = permissionOutcome.parse(raw);
      const selected =
        outcome.outcome.outcome === "selected" ? outcome.outcome.optionId : undefined;
      // Only an option this card offered counts; anything else from the editor is a denial.
      const session = selected === "allow_always" && approval.editorSession === true;
      await bridge.runtime.resolveApproval(
        {
          id: approval.id,
          decision: selected === "allow_once" || session ? "allow" : "deny",
          ...(session ? { allowSession: true as const } : {}),
        },
        turnSignal,
      );
    },
  );
}
