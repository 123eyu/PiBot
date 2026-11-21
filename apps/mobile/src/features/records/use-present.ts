import { auditGroup, auditResult } from "@pibot/client-core";
import { createTranslator } from "@pibot/i18n";
import type { AuditEntry } from "@pibot/protocol";
import { useMemo } from "react";
import { useLanguage, useStatusText, useText } from "../../runtime/context.tsx";
import { useConversations } from "../conversations/conversations-context.tsx";
import type { PresentContext } from "./present.ts";

/** Everything the records views need to phrase a row, in the phone's language. */
export function useRecordPresent() {
  const t = useText(),
    status = useStatusText(),
    language = useLanguage(),
    conversations = useConversations();
  const shared = useMemo(() => createTranslator(language), [language]);
  const context: PresentContext = {
    t,
    shared,
    status,
    bots: conversations.bots,
    groupName: (id) => conversations.find("group", id)?.name,
  };
  const filters = useMemo(
    () => ({
      group: (entry: AuditEntry) => auditGroup(entry),
      danger: (entry: AuditEntry) => auditResult(entry, shared).tone === "danger",
    }),
    [shared],
  );
  return { context, filters };
}
