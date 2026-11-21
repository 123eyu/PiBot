import type { ReceiptChip, ReceiptRow, ReceiptSection } from "@pibot/client-core";
import { formatReceiptDuration, formatUsd } from "@pibot/client-core";
import type { AgentTurnFacts } from "@pibot/external-agents-contract";
import type { createTranslator } from "@pibot/i18n";

type T = ReturnType<typeof createTranslator>;
type Money = { amount: number; currency: string };

const grouped = (value: number) => String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const money = (value: Money) =>
  value.currency === "USD"
    ? formatUsd(value.amount)
    : `${value.amount.toFixed(2)} ${value.currency}`;

/**
 * Maintainers 2026-11-14: an agent turn's receipt says what the agent really reported. Pi Bot made
 * no model call of its own in that turn, so its cost line ("cost unknown") is replaced by the
 * agent's own figures, and whatever the agent did not report reads "Not reported by <agent>",
 * never zero.
 */
export function agentReceiptChips(facts: AgentTurnFacts, t: T): ReceiptChip[] {
  const missing = new Set(facts.notReported);
  const chips: ReceiptChip[] = [];
  if (facts.steps)
    chips.push({
      id: "steps",
      text: t("externalAgents.receipt.steps", { count: facts.steps }),
      tone: "muted",
    });
  if (facts.approvals?.asked)
    chips.push({
      id: "approvals",
      text: t("receipt.chip.approvals", { count: facts.approvals.asked }),
      tone: "muted",
    });
  const total = facts.tokens?.totalTokens;
  if (total !== undefined)
    chips.push({
      id: "tokens",
      text: t("externalAgents.receipt.tokens", { count: grouped(total) }),
      tone: "muted",
    });
  else if (missing.has("tokens"))
    chips.push({
      id: "tokens",
      text: t("externalAgents.receipt.tokensMissing", { name: facts.name }),
      tone: "muted",
    });
  if (facts.cost || facts.sessionCost || missing.has("cost"))
    chips.push({
      // A missing cost is not a money figure: keep it out of the cost chip's green.
      id: facts.cost || facts.sessionCost ? "cost" : "costMissing",
      text: facts.cost
        ? money(facts.cost)
        : facts.sessionCost
          ? t("externalAgents.receipt.sessionCost", { cost: money(facts.sessionCost) })
          : t("externalAgents.receipt.costMissing", { name: facts.name }),
      tone: "muted",
    });
  return chips;
}

/** The details section that replaces Pi Bot's own cost section for an agent turn. */
export function agentReceiptSection(facts: AgentTurnFacts, t: T): ReceiptSection {
  const missing = new Set(facts.notReported);
  const notReported = t("externalAgents.receipt.notReported", { name: facts.name });
  const rows: ReceiptRow[] = [];
  const row = (key: string, label: string, value: string) => rows.push({ key, label, value });
  if (facts.durationMs !== undefined)
    row("time", t("externalAgents.receipt.time"), formatReceiptDuration(facts.durationMs, t));
  row("steps", t("externalAgents.receipt.stepsLabel"), grouped(facts.steps ?? 0));
  if (facts.commands !== undefined)
    row("commands", t("externalAgents.receipt.commands"), grouped(facts.commands));
  if (facts.edits !== undefined)
    row("edits", t("externalAgents.receipt.edits"), grouped(facts.edits));
  if (facts.approvals)
    row(
      "approvals",
      t("externalAgents.receipt.approvals"),
      t("externalAgents.receipt.approvalsValue", {
        asked: facts.approvals.asked,
        allowed: facts.approvals.allowed,
        denied: facts.approvals.denied,
      }),
    );
  const tokens = facts.tokens;
  if (tokens) {
    const parts = (
      [
        ["inputTokens", "externalAgents.receipt.tokenInput"],
        ["outputTokens", "externalAgents.receipt.tokenOutput"],
        ["cachedReadTokens", "externalAgents.receipt.tokenCachedRead"],
        ["cachedWriteTokens", "externalAgents.receipt.tokenCachedWrite"],
        ["thoughtTokens", "externalAgents.receipt.tokenThought"],
        ["totalTokens", "externalAgents.receipt.tokenTotal"],
      ] as const
    ).flatMap(([field, key]) => {
      const value = tokens[field];
      return value === undefined ? [] : [`${t(key)} ${grouped(value)}`];
    });
    row("tokens", t("externalAgents.receipt.tokensLabel"), parts.join(" · "));
  } else if (missing.has("tokens"))
    row("tokens", t("externalAgents.receipt.tokensLabel"), notReported);
  if (facts.cost) row("cost", t("externalAgents.receipt.turnCost"), money(facts.cost));
  if (facts.sessionCost)
    row("sessionCost", t("externalAgents.receipt.sessionCostLabel"), money(facts.sessionCost));
  if (!facts.cost && !facts.sessionCost && missing.has("cost"))
    row("cost", t("externalAgents.receipt.turnCost"), notReported);
  if (facts.context?.used !== undefined)
    row(
      "context",
      t("externalAgents.receipt.context"),
      facts.context.size
        ? `${grouped(facts.context.used)} / ${grouped(facts.context.size)}`
        : grouped(facts.context.used),
    );
  else if (missing.has("context")) row("context", t("externalAgents.receipt.context"), notReported);
  if (missing.has("plan")) row("plan", t("externalAgents.receipt.plan2"), notReported);
  if (missing.has("thoughts")) row("thoughts", t("externalAgents.receipt.thoughts"), notReported);
  if (missing.has("toolOutput"))
    row("toolOutput", t("externalAgents.receipt.toolOutput"), notReported);
  if (missing.has("locations"))
    row("locations", t("externalAgents.receipt.locations"), notReported);
  return {
    id: "cost",
    title: t("externalAgents.receipt.title", { name: facts.name }),
    rows,
    empty: notReported,
  };
}
