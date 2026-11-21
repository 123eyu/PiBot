import { approvalFactText, approvalText } from "@pibot/client-core";
import type { Approval } from "@pibot/protocol";
import type { useLanguage, useSharedText } from "../../runtime/context.tsx";
import type { IconName } from "../../ui/icons.tsx";

/** The desktop approval card's header mark: danger, web, file, connector or command. */
export function approvalIcon(approval: Approval): IconName {
  if (approval.risk === "danger") return "warning";
  if (approval.category === "web") return "globe";
  if (["write_file", "read_file", "list_dir"].includes(approval.category)) return "file";
  return approval.category === "connector" ? "link" : "terminal";
}
/** What the request acts on, for the monospace block: the command or URL, else the first fact. */
export function approvalTarget(
  approval: Approval,
  language: ReturnType<typeof useLanguage>,
  shared: ReturnType<typeof useSharedText>,
) {
  if (approval.command) return approval.command;
  if (approval.url) return approval.url;
  const fact = approvalText(approval, language).facts[0];
  return fact ? approvalFactText(fact, shared) : undefined;
}
