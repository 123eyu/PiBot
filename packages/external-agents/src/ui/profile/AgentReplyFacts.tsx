import { useT } from "@pibot/renderer-kit";
import { Chip } from "@pibot/ui";
import { z } from "zod";
import styles from "../agents/agents.module.css";

const FactsSchema = z.object({
  externalAgent: z.object({
    name: z.string().max(200),
    plan: z
      .array(
        z.object({
          content: z.string().max(400),
          status: z.enum(["pending", "in_progress", "completed"]),
        }),
      )
      .max(50)
      .optional(),
  }),
});
const MARK = { completed: "✓", in_progress: "•", pending: "·" } as const;

/**
 * The end of an agent Bot's reply (external-agents.html `chat`): the agent's own plan and a note
 * that its account pays for the turn. Steps, changes and the receipt are Pi Bot's ordinary card.
 */
export function AgentReplyFacts({ usage }: { usage: unknown }) {
  const t = useT();
  const parsed = FactsSchema.safeParse(usage);
  if (!parsed.success) return null;
  const { name, plan } = parsed.data.externalAgent;
  return (
    <div className={styles.replyFacts}>
      {plan?.length ? (
        <div className={styles.plan}>
          <small>{t("externalAgents.receipt.plan", { name })}</small>
          <ul>
            {plan.map((entry, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a plan snapshot never reorders.
              <li key={index} data-status={entry.status}>
                <i aria-hidden="true">{MARK[entry.status]}</i>
                {entry.content}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <Chip>{t("externalAgents.receipt.billing", { name })}</Chip>
    </div>
  );
}
