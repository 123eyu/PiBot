import { useT } from "@pibot/renderer-kit";
import { Button, Icon } from "@pibot/ui";
import type { SourceState } from "@pibot/workspaces/ui";
import { formatCount } from "@pibot/workspaces/ui";
import { useExecution } from "../execution/workspace.tsx";
import styles from "./side-pane.module.css";
import type { SidePaneControl } from "./use-side-pane.ts";

/**
 * Only 「任务」 is always present (maintainers 2026-10-30). Changes, browser and preview appear when there
 * is something to show, and stay while their pane is open.
 */
export function SidePaneActions({
  pane,
  changes,
  browserActive,
  disabled,
  openTasks,
  openChanges,
  taskFailures = 0,
  previewCount = 0,
  hasDirectory,
}: {
  pane: SidePaneControl;
  changes: SourceState;
  browserActive: boolean;
  disabled: boolean;
  openTasks(): void;
  openChanges(): void;
  taskFailures?: number;
  previewCount?: number;
  hasDirectory?: boolean;
}) {
  const t = useT(),
    execution = useExecution();
  const running =
    execution?.topics.reduce(
      (sum, topic) =>
        sum +
        topic.tasks.filter((task) => ["queued", "running", "stopping"].includes(task.status))
          .length,
      0,
    ) ?? 0;
  const status = changes.status;
  const failures =
    taskFailures +
    (execution?.topics.reduce(
      (sum, topic) =>
        sum + topic.tasks.filter((task) => ["error", "interrupted"].includes(task.status)).length,
      0,
    ) ?? 0);
  const total = status?.root.role === "primary" ? status.total : 0;
  return (
    <nav className={styles.navigation} aria-label={t("agentWork.sidePane")}>
      <Button
        variant="ghost"
        className={styles.entry}
        data-tone="amber"
        title={
          failures
            ? `${t("agentWork.tasks")} · ${t("group.failedCount", { count: failures })}`
            : t("agentWork.tasks")
        }
        aria-label={
          failures
            ? `${t("agentWork.tasks")} · ${t("group.failedCount", { count: failures })}`
            : t("agentWork.tasks")
        }
        aria-pressed={pane.open && pane.tab === "tasks"}
        disabled={disabled}
        onClick={() => (pane.open && pane.tab === "tasks" ? pane.close() : openTasks())}
      >
        <Icon name="audit" size={15} />
        <span className={styles.entryLabel}>{t("agentWork.tasks")}</span>
        {running > 0 && <span className={styles.badge}>{formatCount(running)}</span>}
        {failures > 0 && (
          <span className={styles.attentionBadge}>
            <Icon name="warning" size={12} />
            {formatCount(failures)}
          </span>
        )}
      </Button>
      {(hasDirectory ?? !!status) &&
        ((status?.total ?? 0) > 0 || (pane.open && pane.tab === "changes")) && (
          <Button
            variant="ghost"
            className={styles.entry}
            data-tone="green"
            title={t("sidePane.changes")}
            aria-label={t("sidePane.changes")}
            aria-pressed={pane.open && pane.tab === "changes"}
            disabled={disabled}
            onClick={openChanges}
          >
            <Icon name="chart" size={15} />
            <span className={styles.entryLabel}>{t("sidePane.changes")}</span>
            {!!total && <span className={styles.badge}>{formatCount(total)}</span>}
          </Button>
        )}
      {browserActive && (
        <Button
          variant="ghost"
          className={styles.entry}
          data-tone="blue"
          title={t("sidePane.browser")}
          aria-label={t("sidePane.browser")}
          aria-pressed={pane.open && pane.tab === "browser"}
          disabled={disabled}
          onClick={() => pane.toggle("browser")}
        >
          <Icon name="globe" size={15} />
          <span className={styles.entryLabel}>{t("sidePane.browserEntry")}</span>
          {browserActive && <i className={styles.liveDot} aria-hidden="true" />}
        </Button>
      )}
      {previewCount > 0 && (
        <Button
          variant="ghost"
          className={styles.entry}
          data-tone="violet"
          title={t("preview.title")}
          aria-label={t("preview.title")}
          aria-pressed={pane.open && pane.tab === "preview"}
          onClick={() => pane.toggle("preview")}
        >
          <Icon name="file" size={15} />
          <span className={styles.entryLabel}>{t("preview.title")}</span>
          <span className={styles.badge}>{previewCount}</span>
        </Button>
      )}
    </nav>
  );
}
