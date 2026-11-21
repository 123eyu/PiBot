import { useSettings } from "@pibot/renderer-kit";
import { type Skill, skillLabels, type WorkflowSummary } from "@pibot/skills-contract/full";
import { Button, IconTile, Switch } from "@pibot/ui";
import { useSkillsPorts } from "../shell/ports.tsx";
import { skillMeta } from "./presentation.ts";
import styles from "./skills.module.css";

/** The clickable name area every skills-tab row shares: the name and one muted meta line. */
export function SkillMain({
  skill,
  workflow,
  roleName,
  open,
}: {
  skill: Skill;
  workflow?: WorkflowSummary;
  roleName?: string;
  open(): void;
}) {
  const { t, language } = useSettings();
  const meta = skillMeta(t, skill, workflow, language, roleName);
  const label = skillLabels(skill, language);
  // One tile colour per kind — methods and role skills violet, saved plans teal, own blue.
  const tone =
    skill.builtinKey || skill.source === "team" ? "violet" : skill.savedFromPlan ? "teal" : "blue";
  return (
    <button type="button" className={styles.main} onClick={open}>
      <IconTile icon={skill.savedFromPlan ? "check" : "puzzle"} tone={tone} size="lg" />
      <span className={styles.text}>
        <span className={styles.name}>{label.name}</span>
        {/* The full line stays readable on hover when the narrow panel cuts it off. */}
        <span className={styles.meta} title={meta}>
          {meta}
        </span>
      </span>
    </button>
  );
}

/**
 * One row of 「我的技能」: open by clicking the row, the panels' ⋯ menu and the enable switch.
 * A contract skill is shown as a plain skill: users neither run nor edit workflows.
 */
export function SkillRow({
  skill,
  workflow,
  roleName,
  disabled,
  open,
  remove,
  setEnabled,
}: {
  skill: Skill;
  workflow?: WorkflowSummary;
  roleName?: string;
  disabled: boolean;
  open(): void;
  /** Asks for confirmation first; the caller deletes only after that. */
  remove(): void;
  setEnabled(enabled: boolean): void;
}) {
  const { t, language } = useSettings();
  const { PanelMenu } = useSkillsPorts();
  const label = skillLabels(skill, language);
  return (
    <div className={styles.row} data-enabled={skill.enabled}>
      <SkillMain skill={skill} workflow={workflow} roleName={roleName} open={open} />
      <PanelMenu
        label={t("skills.rowActions", { name: label.name })}
        width={160}
        items={[
          { id: "view", label: t("skills.view"), run: open },
          // Built-in methods are only viewed and assigned.
          ...(skill.builtinKey || disabled
            ? []
            : [{ id: "delete", label: t("skills.deleteMenu"), danger: true, run: remove }]),
        ]}
      />
      <Switch
        label={t("skills.enable", { name: label.name })}
        checked={skill.enabled}
        disabled={disabled}
        onCheckedChange={setEnabled}
      />
      <WorkflowWarnings workflow={workflow} />
    </div>
  );
}

export function WorkflowWarnings({ workflow }: { workflow?: WorkflowSummary }) {
  const { t } = useSettings();
  if (!workflow?.warnings.length) return null;
  return (
    <div className={styles.workflowWarnings}>
      {workflow.warnings.map((warning) => (
        <span key={warning}>{t(`workflows.warning.${warning}`)}</span>
      ))}
    </div>
  );
}

/** Loading, error and "load more" under one skills-tab list. */
export function ListFooter({
  loading,
  error,
  more,
  retry,
  next,
}: {
  loading: boolean;
  error?: string;
  more: boolean;
  retry(): void;
  next(): void;
}) {
  const { t } = useSettings();
  return (
    <>
      {loading && (
        <p role="status" className={styles.note}>
          {t("common.loading")}
        </p>
      )}
      {error && (
        <p role="alert" className={styles.error}>
          {error}{" "}
          <Button variant="pill" onClick={retry}>
            {t("common.retry")}
          </Button>
        </p>
      )}
      {more && (
        <Button variant="ghost" className={styles.mini} disabled={loading} onClick={next}>
          {t("skills.more")}
        </Button>
      )}
    </>
  );
}
