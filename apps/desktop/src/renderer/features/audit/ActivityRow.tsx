import type { AuditEntry, Bot } from "@pibot/protocol";
import type { ActivityEntry } from "./activity.ts";
import { commandKey } from "./pager.ts";
import { RoutineRunRow } from "./RoutineRunRow.tsx";
import { AuditRow } from "./Row.tsx";

export function ActivityRow({
  entry,
  bot,
  sources,
  expanded,
  toggle,
}: {
  entry: ActivityEntry;
  bot?: Bot;
  sources: Map<string, AuditEntry>;
  expanded: boolean;
  toggle(): void;
}) {
  return entry.type === "routine-run" ? (
    <RoutineRunRow run={entry.run} expanded={expanded} toggle={toggle} />
  ) : (
    <AuditRow
      entry={entry.entry}
      bot={bot}
      source={sources.get(commandKey(entry.entry))}
      expanded={expanded}
      toggle={toggle}
    />
  );
}
