import type { Approval } from "@pibot/protocol";

/**
 * The card's title and facts in the current UI language. brain writes both languages;
 * approvals created before that only have the text of the language they were made in.
 */
export function approvalText(approval: Approval, language: "zh" | "en") {
  return approval.localized?.[language] ?? { title: approval.title, facts: approval.facts };
}
