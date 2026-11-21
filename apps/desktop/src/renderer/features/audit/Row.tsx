import { auditGroup, auditResult, auditSummary, isSystemAudit } from "@pibot/client-core";
import type { AuditEntry, Bot } from "@pibot/protocol";
import { BotAvatar, useSettings } from "@pibot/renderer-kit";
import { Icon, IconTile } from "@pibot/ui";
import { useId } from "react";
import styles from "./audit.module.css";
import { AuditDetails } from "./Details.tsx";
import { activityMark } from "./marks.ts";

export function AuditRow({
  entry,
  bot,
  source,
  expanded,
  toggle,
}: {
  entry: AuditEntry;
  bot?: Bot;
  source?: AuditEntry;
  expanded: boolean;
  toggle(): void;
}) {
  const { t, language } = useSettings();
  const id = useId();
  const group = auditGroup(entry);
  const result = auditResult(entry, t);
  const system = isSystemAudit(entry);
  const name = system ? t("audit.actor.system") : (bot?.name ?? t("audit.actor.deletedBot"));
  const what = auditSummary(entry, t, { source, botName: name });
  const mark = activityMark(group);
  const kind = t(group === "identity" ? "audit.kind.oauth.changed" : `activity.kind.${group}`);
  return (
    <article className={styles.entry} data-tone={mark.tone}>
      <button
        type="button"
        className={styles.row}
        aria-expanded={expanded}
        aria-controls={id}
        onClick={toggle}
      >
        <IconTile icon={mark.icon} tone={mark.tone} size="sm" title={kind} />
        <time dateTime={entry.at} title={new Date(entry.at).toLocaleString(language)}>
          {new Date(entry.at).toLocaleTimeString(language, {
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          })}
        </time>
        <BotAvatar bot={system ? undefined : bot} label={name} size={22} state="idle" />
        <span className={styles.botName} title={name}>
          {name}
        </span>
        <span className={styles.kindLabel}>{kind}</span>
        <span className={styles.what} title={what}>
          {what}
        </span>
        <span className={styles.result} data-tone={result.tone}>
          {result.text}
        </span>
        <Icon
          name="chevronRight"
          size={14}
          className={styles.chevron}
          style={{ transform: expanded ? "rotate(90deg)" : undefined }}
        />
      </button>
      <div id={id} hidden={!expanded}>
        {expanded && <AuditDetails entry={entry} loadedSource={source} botName={name} />}
      </div>
    </article>
  );
}
