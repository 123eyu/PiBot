import { routineRunName, routineRunStatus, safeAuditText } from "@pibot/client-core";
import type { RoutineHistoryView } from "@pibot/protocol";
import { avatarColors, avatarEyes, avatarShapes, useSettings } from "@pibot/renderer-kit";
import { Avatar, Icon, IconTile } from "@pibot/ui";
import { useId } from "react";
import styles from "./audit.module.css";
import { activityMark } from "./marks.ts";
import { RoutineRunDetails } from "./RoutineRunDetails.tsx";

export function RoutineRunRow({
  run,
  expanded,
  toggle,
}: {
  run: RoutineHistoryView;
  expanded: boolean;
  toggle(): void;
}) {
  const { t, language } = useSettings();
  const id = useId();
  const result = routineRunStatus(run, t);
  const what = routineRunName(run, t);
  const name = safeAuditText(run.bot?.name ?? "", 200) || t("activity.routineBotMissing");
  const mark = activityMark("scheduling");
  return (
    <article className={styles.entry} data-tone={mark.tone}>
      <button
        type="button"
        className={styles.row}
        aria-expanded={expanded}
        aria-controls={id}
        onClick={toggle}
      >
        <IconTile
          icon={mark.icon}
          tone={mark.tone}
          size="sm"
          title={t("activity.kind.scheduling")}
        />
        <time dateTime={run.createdAt} title={new Date(run.createdAt).toLocaleString(language)}>
          {new Date(run.createdAt).toLocaleTimeString(language, {
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          })}
        </time>
        <Avatar
          image={run.bot?.avatarImage}
          label={name}
          size={22}
          state="idle"
          shape={avatarShapes.find((value) => value === run.bot?.avatarShape) ?? "circle"}
          color={avatarColors.find((value) => value === run.bot?.avatarColor) ?? "gray"}
          eyes={avatarEyes.find((value) => value === run.bot?.avatarEyes) ?? "sleepy"}
        />
        <span className={styles.botName} title={name}>
          {name}
        </span>
        <span className={styles.kindLabel}>{t("activity.kind.scheduling")}</span>
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
        {expanded && <RoutineRunDetails run={run} />}
      </div>
    </article>
  );
}
