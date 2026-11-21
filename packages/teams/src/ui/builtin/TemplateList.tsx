// Let downloadable templates enter the same preview flow as shipped groups.
import { useNavigation, useT } from "@pibot/renderer-kit";
import { GroupAvatar } from "@pibot/ui";
import { useLayoutEffect, useRef } from "react";
import styles from "./builtin.module.css";
import { CatalogCard, CatalogNotice, CatalogRefresh } from "./CloudCatalog.tsx";
import { catalogCandidates, catalogMatches, withInstalled } from "./catalog-model.ts";
import { RoleAvatar, useBuiltinCatalog } from "./shared.tsx";
import { useRoleCatalog } from "./use-role-catalog.ts";

type RoleImportTarget = { kind: "group"; id: string; version: number };

/** Built-in group templates in "New chat"; each opens its preview. */
export function TemplateList({
  query,
  disabled,
  target,
}: {
  query: string;
  disabled: boolean;
  target?: RoleImportTarget;
}) {
  const t = useT();
  const { openWorkspace } = useNavigation();
  const builtin = useBuiltinCatalog();
  const cloud = useRoleCatalog(target);
  const groupsAvailable = withInstalled(builtin.catalog?.groups ?? [], cloud.catalog?.groups);
  const rolesAvailable = withInstalled(builtin.catalog?.roles ?? [], cloud.catalog?.roles);
  const candidates = catalogCandidates(cloud.state?.entries ?? [], "group");
  const remoteIds = new Set(candidates.map((entry) => entry.id));
  const downloads = candidates.filter((entry) => catalogMatches(entry, cloud.language, query));
  async function download(entry: (typeof candidates)[number]) {
    const next = await cloud.install(entry);
    if (!next) return;
    builtin.reload();
    if (next.groups.some((group) => group.id === entry.id))
      openWorkspace({ name: "template", id: entry.id });
  }
  const needle = query.trim().toLocaleLowerCase();
  const groups = groupsAvailable.filter(
    (group) =>
      !remoteIds.has(group.id) &&
      (!needle ||
        group.name.toLocaleLowerCase().includes(needle) ||
        group.summary.toLocaleLowerCase().includes(needle)),
  );
  const roles = new Map(rolesAvailable.map((role) => [role.id, role]));
  const targetGroup = target && groupsAvailable.find((group) => group.id === target.id);
  const targetReady = !!targetGroup && targetGroup.version >= target.version;
  const targetRef = useRef<HTMLButtonElement>(null);
  // The link's template preview opens once when it becomes available, not on every render.
  const targetDone = useRef(false);
  useLayoutEffect(() => {
    if (!targetReady || targetDone.current) return;
    targetDone.current = true;
    targetRef.current?.focus();
    targetRef.current?.scrollIntoView({ block: "center" });
    openWorkspace({ name: "template", id: targetGroup.id });
  }, [targetReady, targetGroup, openWorkspace]);
  return (
    <section className={styles.stack} aria-label={t("builtin.templates")}>
      <div className={styles.catalogSearch}>
        <h2 className={styles.subheading}>{t("builtin.templates")}</h2>
        <CatalogRefresh cloud={cloud} />
      </div>
      <CatalogNotice cloud={cloud} />
      {target && cloud.targetMissing && (
        <p role="status" className={styles.note}>
          {t("builtin.cloud.targetMissing")}
        </p>
      )}
      <div className={styles.grid}>
        {groups.map((group) => (
          <button
            key={group.id}
            ref={group.id === target?.id ? targetRef : undefined}
            type="button"
            className={styles.choice}
            disabled={disabled || !!cloud.busy}
            onClick={() => openWorkspace({ name: "template", id: group.id })}
          >
            <GroupAvatar size={36}>
              {group.members.map((id) => (
                <RoleAvatar key={id} role={roles.get(id)} size={20} />
              ))}
            </GroupAvatar>
            <span className={styles.choiceText}>
              <span className={styles.choiceName}>{group.name}</span>
              {/* What the team is for: similar teams were hard to tell apart (maintainers 2026-11-18). */}
              {group.summary && <span className={styles.choiceBlurb}>{group.summary}</span>}
              <span className={`${styles.choiceBlurb} ${styles.choiceMeta}`}>
                {t("builtin.template.members", {
                  count: group.members.length,
                  name: roles.get(group.coordinator)?.name ?? group.coordinator,
                })}
              </span>
            </span>
          </button>
        ))}
        {downloads.map((entry) => (
          <CatalogCard
            key={entry.id}
            entry={entry}
            cloud={cloud}
            disabled={disabled}
            memberEntries={entry.members?.flatMap((id) => {
              const member = cloud.state?.entries.find(
                (item) => item.kind === "role" && item.id === id,
              );
              return member ? [member] : [];
            })}
            onInstalled={() => void download(entry)}
          />
        ))}
      </div>
    </section>
  );
}
