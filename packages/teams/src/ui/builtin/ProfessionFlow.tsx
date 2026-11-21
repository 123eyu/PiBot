import type { BuiltinPlan, MethodResults } from "@pibot/protocol";
import { useAction, useRpc, useT } from "@pibot/renderer-kit";
import { Button, GroupAvatar, Icon } from "@pibot/ui";
import { type CSSProperties, useEffect, useId, useState } from "react";
import styles from "./builtin.module.css";
import {
  builtinError,
  ProfessionIcon,
  permissionLines,
  RoleAvatar,
  useBuiltinCatalog,
} from "./shared.tsx";

const MAX_PROFESSIONS = 3;
const unique = (values: string[]) => [...new Set(values)];

/**
 * "What do you mainly do?" (up to three professions, or skip) and then "We'll create"
 * with every group and Bot untickable. Professions only recommend; brain plans the merge (one
 * Bot per role, existing role Bots reused) and creates through the same path as an import.
 */
export function ProfessionFlow({
  onFinish,
  skipLabel,
}: {
  onFinish(result: MethodResults["builtin.create"] | null): void;
  skipLabel: string;
}) {
  const t = useT();
  const id = useId();
  const { peer } = useRpc();
  const { catalog, error } = useBuiltinCatalog();
  const task = useAction();
  const [stage, setStage] = useState<"pick" | "preview">("pick");
  const [selected, setSelected] = useState<string[]>([]);
  const [offGroups, setOffGroups] = useState<string[]>([]);
  const [offRoles, setOffRoles] = useState<string[]>([]);
  const [duplicate, setDuplicate] = useState<string[]>([]);
  const [plan, setPlan] = useState<BuiltinPlan>();
  const [planFailed, setPlanFailed] = useState(false);
  const professions = (catalog?.professions ?? []).filter((p) => selected.includes(p.id));
  const groupIds = unique(professions.flatMap((p) => p.groups));
  const roleIds = unique(professions.flatMap((p) => p.roles));
  const selection = {
    groups: groupIds.filter((g) => !offGroups.includes(g)),
    roles: roleIds.filter((r) => !offRoles.includes(r)),
    professions: selected,
    reuseExisting: true,
    duplicate,
  };
  const roles = new Map(catalog?.roles.map((role) => [role.id, role]));
  const groups = new Map(catalog?.groups.map((group) => [group.id, group]));
  const key = JSON.stringify(selection);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for the selection.
  useEffect(() => {
    if (!peer || stage !== "preview") return;
    let active = true;
    setPlanFailed(false);
    peer
      .call("builtin.plan", selection)
      .then((value) => {
        if (active) setPlan(value);
      })
      .catch(() => {
        if (active) setPlanFailed(true);
      });
    return () => {
      active = false;
    };
  }, [peer, stage, key]);
  const toggle = (list: string[], value: string) =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
  const counts = plan?.counts;
  const overLimit =
    !!counts && (counts.groups > counts.maxGroups || counts.newBots > counts.maxBots);
  const nothing = !!counts && counts.groups === 0 && counts.newBots === 0;
  const create = () => {
    if (!peer || !plan || overLimit || nothing) return;
    void task
      .run(
        () =>
          peer.call(
            "builtin.create",
            { ...selection, source: "profession" },
            { timeoutMs: 180_000 },
          ),
        builtinError,
      )
      .then((result) => {
        if (result) onFinish(result);
      });
  };
  if (stage === "pick")
    return (
      <section className={styles.stack} aria-labelledby={`${id}-title`}>
        <div>
          <h1 id={`${id}-title`} className={styles.heading}>
            {t("builtin.profession.title")}
          </h1>
          <p className={styles.note}>{t("builtin.profession.subtitle")}</p>
        </div>
        {error && (
          <p role="alert" className={styles.error}>
            {t("builtin.role.loadFailed")}
          </p>
        )}
        {!catalog && !error && <p role="status">{t("common.loading")}</p>}
        <div className={styles.grid}>
          {catalog?.professions.map((profession) => {
            const on = selected.includes(profession.id);
            // The Bots a pick brings: its own roles plus every member of its groups.
            const team = unique([
              ...profession.roles,
              ...profession.groups.flatMap((g) => groups.get(g)?.members ?? []),
            ]).flatMap((roleId) => roles.get(roleId) ?? []);
            const tone = team.find(
              (role) => role.avatar.color !== "gray" && role.avatar.color !== "ink",
            )?.avatar.color;
            const toneStyle = tone
              ? ({
                  "--tone": `var(--avatar-${tone})`,
                  "--tone-deep": `var(--userBubble-${tone})`,
                  "--tone-on": `var(--onUser-${tone})`,
                } as CSSProperties)
              : undefined;
            return (
              <button
                key={profession.id}
                type="button"
                className={`${styles.choice} ${styles.profession}`}
                style={toneStyle}
                aria-pressed={on}
                disabled={!on && selected.length >= MAX_PROFESSIONS}
                onClick={() => setSelected((list) => toggle(list, profession.id))}
              >
                <span className={styles.professionHead}>
                  <ProfessionIcon name={profession.icon} />
                  <span className={styles.choiceText}>
                    <span className={styles.choiceName}>{profession.name}</span>
                    <span className={styles.choiceBlurb}>{profession.blurb}</span>
                  </span>
                  <span className={styles.tick} aria-hidden="true">
                    {on && <Icon name="check" size={12} />}
                  </span>
                </span>
                {!!team.length && (
                  <span className={styles.team}>
                    <span className={styles.teamAvatars} aria-hidden="true">
                      {team.slice(0, 6).map((role) => (
                        <RoleAvatar key={role.id} role={role} size={22} />
                      ))}
                    </span>
                    <span className={styles.teamLine}>
                      {profession.groups.length
                        ? t("builtin.profession.includes", {
                            bots: team.length,
                            groups: profession.groups.length,
                          })
                        : t("builtin.profession.includesBots", { bots: team.length })}
                    </span>
                  </span>
                )}
              </button>
            );
          })}
        </div>
        {selected.length >= MAX_PROFESSIONS && (
          <p className={styles.note}>{t("builtin.profession.limit")}</p>
        )}
        <div className={styles.actions}>
          <Button
            disabled={!selected.length}
            onClick={() => {
              setOffGroups([]);
              setOffRoles([]);
              setDuplicate([]);
              setPlan(undefined);
              setStage("preview");
            }}
          >
            {t("common.continue")}
          </Button>
          <Button variant="ghost" onClick={() => onFinish(null)}>
            {skipLabel}
          </Button>
        </div>
      </section>
    );
  const planned = new Map(plan?.groups.map((g) => [g.templateId, g]));
  return (
    <section className={styles.stack} aria-labelledby={`${id}-preview`}>
      <div>
        <h1 id={`${id}-preview`} className={styles.heading}>
          {t("builtin.preview.title")}
        </h1>
        <p className={styles.note}>{t("builtin.preview.subtitle")}</p>
      </div>
      {planFailed && (
        <p role="alert" className={styles.error}>
          {t("builtin.role.loadFailed")}
        </p>
      )}
      {!!groupIds.length && <h2 className={styles.subheading}>{t("builtin.preview.groups")}</h2>}
      {groupIds.map((groupId) => {
        const group = groups.get(groupId);
        const entry = planned.get(groupId);
        const on = !offGroups.includes(groupId);
        const coordinator = roles.get(group?.coordinator ?? "");
        return (
          <label key={groupId} className={styles.card}>
            <span className={styles.row}>
              <input
                type="checkbox"
                className={styles.check}
                checked={on}
                disabled={task.busy}
                onChange={() => setOffGroups((list) => toggle(list, groupId))}
              />
              <GroupAvatar size={36}>
                {(entry?.members ?? group?.members ?? []).map((roleId) => (
                  <RoleAvatar key={roleId} role={roles.get(roleId)} size={22} />
                ))}
              </GroupAvatar>
              <span className={styles.rowText}>
                <strong>{group?.name ?? groupId}</strong>
                <span className={styles.note}>
                  {" · "}
                  {t("builtin.preview.groupLine", {
                    name: coordinator?.name ?? "",
                    count: (entry?.members ?? group?.members ?? []).length,
                  })}
                </span>
              </span>
            </span>
            {on && group && (
              <span className={styles.note}>{group.announcement.split("\n")[0]}</span>
            )}
            {on && !!entry?.skipped.length && (
              <span className={styles.warn}>
                {t("builtin.template.skipped", {
                  names: entry.skipped
                    .map((s) => roles.get(s.roleId)?.name ?? s.roleId)
                    .join(t("skills.message.paramSeparator")),
                })}
              </span>
            )}
            {on && entry && !entry.available && (
              <span className={styles.warn}>{t("builtin.template.unavailable")}</span>
            )}
          </label>
        );
      })}
      {!!roleIds.length && <h2 className={styles.subheading}>{t("builtin.preview.bots")}</h2>}
      {roleIds.map((roleId) => {
        const role = roles.get(roleId);
        const on = !offRoles.includes(roleId);
        const permissions = role ? permissionLines(role, t) : [];
        return (
          <div key={roleId} className={styles.card}>
            <label className={styles.row}>
              <input
                type="checkbox"
                className={styles.check}
                checked={on}
                disabled={task.busy || !!role?.unavailable}
                onChange={() => setOffRoles((list) => toggle(list, roleId))}
              />
              <RoleAvatar role={role} size={28} />
              <span className={styles.rowText}>
                <strong>{role?.defaultBotName ?? roleId}</strong>
                <span className={styles.note}>
                  {" · "}
                  {role?.name}
                </span>
              </span>
            </label>
            {role?.unavailable && (
              <span className={styles.warn}>{t("builtin.role.unavailable")}</span>
            )}
            {on && !role?.unavailable && (
              <span className={styles.note}>
                {permissions.length
                  ? permissions.join(t("skills.message.paramSeparator"))
                  : t("builtin.role.noPermissions")}
              </span>
            )}
          </div>
        );
      })}
      {plan?.bots
        .filter((bot) => bot.existingBotId || duplicate.includes(bot.roleId))
        .map((bot) => (
          <label key={`reuse-${bot.roleId}`} className={styles.row}>
            <input
              type="checkbox"
              className={styles.check}
              checked={duplicate.includes(bot.roleId)}
              disabled={task.busy}
              onChange={() => setDuplicate((list) => toggle(list, bot.roleId))}
            />
            <span className={styles.note}>
              {bot.existingBotName
                ? `${t("builtin.preview.reuse", { name: bot.existingBotName })} · `
                : ""}
              {t("builtin.preview.again", { role: roles.get(bot.roleId)?.name ?? bot.roleId })}
            </span>
          </label>
        ))}
      {counts && !overLimit && !nothing && (
        <p className={styles.note}>
          {t("builtin.preview.counts", { groups: counts.groups, bots: counts.newBots })}
        </p>
      )}
      {overLimit && counts && (
        <p className={styles.warn}>
          {t("builtin.preview.overLimit", {
            maxGroups: counts.maxGroups,
            maxBots: counts.maxBots,
            groups: counts.groups,
            bots: counts.newBots,
          })}
        </p>
      )}
      {nothing && <p className={styles.note}>{t("builtin.preview.nothing")}</p>}
      {task.error && (
        <p role="alert" className={styles.error}>
          {t(task.error)}
        </p>
      )}
      <div className={styles.actions}>
        <Button
          loading={task.busy}
          disabled={
            !peer || !plan || overLimit || nothing || task.error === "workspace.createUncertain"
          }
          onClick={create}
        >
          {t("builtin.preview.create")}
        </Button>
        <Button variant="ghost" disabled={task.busy} onClick={() => setStage("pick")}>
          {t("common.back")}
        </Button>
        <Button variant="ghost" disabled={task.busy} onClick={() => onFinish(null)}>
          {skipLabel}
        </Button>
      </div>
    </section>
  );
}
