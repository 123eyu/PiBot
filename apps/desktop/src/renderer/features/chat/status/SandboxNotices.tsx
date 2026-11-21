import type { Approval, ChatNotice } from "@pibot/protocol";
import { useT } from "@pibot/renderer-kit";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import styles from "../chat.module.css";
import { BlockedWebsite } from "./BlockedWebsite.tsx";

type Warning = Extract<ChatNotice, { kind: "agent_warning" }>;
export type BlockWarning = Warning & { sandbox: NonNullable<Warning["sandbox"]> };
const SandboxNoticesContext = createContext<ReadonlyMap<string, BlockWarning[]>>(new Map());
const SandboxApprovalsContext = createContext<ReadonlyMap<string, Approval>>(new Map());
const key = (runId: string, toolCallId: string) => JSON.stringify([runId, toolCallId]);

export function SandboxNoticesProvider({
  notices,
  approvals,
  children,
}: {
  notices: readonly ChatNotice[];
  approvals: readonly Approval[];
  children: ReactNode;
}) {
  const value = useMemo(() => {
    const result = new Map<string, BlockWarning[]>();
    for (const notice of notices) {
      if (notice.kind !== "agent_warning" || !notice.sandbox?.toolCallId) continue;
      const id = key(notice.runId, notice.sandbox.toolCallId);
      const row = result.get(id) ?? [];
      row.push(notice as BlockWarning);
      result.set(id, row);
    }
    return result;
  }, [notices]);
  const pending = useMemo(
    () => new Map(approvals.filter((a) => a.status === "pending").map((a) => [a.id, a])),
    [approvals],
  );
  return (
    <SandboxNoticesContext.Provider value={value}>
      <SandboxApprovalsContext.Provider value={pending}>
        {children}
      </SandboxApprovalsContext.Provider>
    </SandboxNoticesContext.Provider>
  );
}

export function useSandboxNotices() {
  const notices = useContext(SandboxNoticesContext);
  return (runId: string, toolCallId: string) => notices.get(key(runId, toolCallId));
}

export function SandboxBlockLine({ notices }: { notices: readonly BlockWarning[] }) {
  const t = useT();
  const approvals = useContext(SandboxApprovalsContext);
  return notices.map((notice) => {
    const block = notice.sandbox;
    // Only a live, exact same-run card may be navigated to. This never calls resolve or creates
    // a request; missing cards and resolved historical links simply have no button.
    const pending = block.approvalId ? approvals.get(block.approvalId) : undefined;
    const approval =
      pending?.toolCallId === block.approvalToolCallId &&
      pending?.runId === notice.runId &&
      pending?.botId === notice.botId &&
      pending?.conversationId === notice.conversationId
        ? pending
        : undefined;
    return (
      <div key={notice.id} className={`${styles.systemLine} ${styles.sandboxLine}`} role="note">
        {t(
          block.rule === "domain_not_allowed"
            ? "tool.networkSettingsBlocked"
            : "tool.sandboxBlocked",
          {
            kind: t(`tool.sandboxKind.${block.kind}`),
            target: block.target,
            program: block.program ? ` (${block.program})` : "",
            rule: block.rule,
          },
        )}
        {block.website && (
          <>
            {" "}
            · <BlockedWebsite notice={notice} />
          </>
        )}
        {approval && (
          <>
            {" · "}
            <button
              type="button"
              className={styles.sandboxLink}
              onClick={(event) => {
                const scope = event.currentTarget.closest("[data-sandbox-scope]");
                const card = scope?.querySelector<HTMLElement>(
                  `[data-tool-call-id="${CSS.escape(approval.toolCallId)}"]`,
                );
                card?.scrollIntoView({ block: "center", behavior: "smooth" });
                card?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
              }}
            >
              {t("tool.sandboxSeeApproval")}
            </button>
          </>
        )}
      </div>
    );
  });
}
