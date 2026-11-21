// Present downloads inside the existing card grid without inventing pre-install role details.
import type { BuiltinRoleView, RoleCatalogEntry } from "@pibot/protocol";
import { avatarColors, avatarEyes, avatarShapes, useT } from "@pibot/renderer-kit";
import { Avatar, GroupAvatar, Icon } from "@pibot/ui";
import styles from "./builtin.module.css";
import { RoleAvatar, roleTone } from "./shared.tsx";
import type { RoleCatalogBrowser } from "./use-role-catalog.ts";

export function CatalogRefresh({ cloud }: { cloud: RoleCatalogBrowser }) {
  const t = useT();
  if (cloud.state?.status === "untrusted") return null;
  const date = cloud.state?.checkedAt;
  const time = date
    ? new Date(date).toLocaleString(cloud.language, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : undefined;
  return (
    <button
      type="button"
      className={styles.catalogRefresh}
      disabled={!cloud.connected || !!cloud.busy}
      onClick={() => void cloud.check()}
    >
      {t(
        cloud.busy === "check"
          ? "builtin.cloud.checking"
          : !date
            ? "builtin.cloud.check"
            : "builtin.cloud.refresh",
      )}
      {time && ` · ${time}`}
    </button>
  );
}

export function CatalogNotice({ cloud }: { cloud: RoleCatalogBrowser }) {
  const t = useT();
  const code = cloud.state?.error;
  const message =
    cloud.error ??
    (code === "offline"
      ? "builtin.cloud.offline"
      : code === "server"
        ? "builtin.cloud.server"
        : code === "app_too_old"
          ? "builtin.cloud.appTooOld"
          : code
            ? "builtin.cloud.integrity"
            : undefined);
  return message ? (
    <p role="alert" className={styles.error}>
      {t(message)}
    </p>
  ) : null;
}

export function CatalogCard({
  entry,
  cloud,
  role,
  disabled,
  pressed,
  onInstalled,
  memberEntries,
}: {
  entry: RoleCatalogEntry;
  cloud: RoleCatalogBrowser;
  role?: BuiltinRoleView;
  disabled?: boolean;
  pressed?: boolean;
  onInstalled(): void;
  memberEntries?: RoleCatalogEntry[];
}) {
  const t = useT();
  const pending = cloud.busy === `${entry.kind}:${entry.id}`;
  const update = entry.bundled !== null || entry.installed !== null;
  const title = entry.title?.[cloud.language] ?? entry.name[cloud.language];
  const summary = entry.summary?.[cloud.language] ?? entry.description[cloud.language];
  const avatar = entry.avatar;
  const blurb = pending
    ? "builtin.cloud.downloading"
    : entry.needsUpdate
      ? "builtin.cloud.appTooOld"
      : cloud.offline
        ? "builtin.cloud.offlineCard"
        : update
          ? "builtin.cloud.newVersion"
          : "builtin.cloud.notInstalled";
  return (
    <button
      type="button"
      className={`${styles.choice} ${styles.catalogCard}`}
      style={roleTone(role ?? (avatar ? { avatar } : undefined))}
      aria-pressed={pressed}
      aria-busy={pending}
      data-offline={cloud.offline || undefined}
      disabled={disabled || !!cloud.busy || !cloud.connected || cloud.offline || entry.needsUpdate}
      title={summary}
      onClick={onInstalled}
    >
      {entry.kind === "group" && memberEntries?.length ? (
        <GroupAvatar size={36}>
          {memberEntries.map((member) => (
            <Avatar
              key={member.id}
              size={20}
              label={member.defaultBotName?.[cloud.language] ?? ""}
              shape={
                avatarShapes.includes(member.avatar?.shape as (typeof avatarShapes)[number])
                  ? (member.avatar?.shape as (typeof avatarShapes)[number])
                  : "blob"
              }
              color={
                avatarColors.includes(member.avatar?.color as (typeof avatarColors)[number])
                  ? (member.avatar?.color as (typeof avatarColors)[number])
                  : "gray"
              }
              eyes={
                avatarEyes.includes(member.avatar?.eyes as (typeof avatarEyes)[number])
                  ? (member.avatar?.eyes as (typeof avatarEyes)[number])
                  : "marks"
              }
            />
          ))}
        </GroupAvatar>
      ) : role ? (
        <RoleAvatar role={role} size={32} />
      ) : avatar ? (
        <Avatar
          size={32}
          label={entry.defaultBotName?.[cloud.language] ?? ""}
          shape={
            avatarShapes.includes(avatar.shape as (typeof avatarShapes)[number])
              ? (avatar.shape as (typeof avatarShapes)[number])
              : "blob"
          }
          color={
            avatarColors.includes(avatar.color as (typeof avatarColors)[number])
              ? (avatar.color as (typeof avatarColors)[number])
              : "gray"
          }
          eyes={
            avatarEyes.includes(avatar.eyes as (typeof avatarEyes)[number])
              ? (avatar.eyes as (typeof avatarEyes)[number])
              : "marks"
          }
        />
      ) : (
        <span className={styles.icon} aria-hidden="true">
          <Icon name={entry.kind === "group" ? "users" : "user"} size={24} />
        </span>
      )}
      {!update && (
        <span className={styles.catalogDownload} aria-hidden="true">
          <Icon name="cloud-download" size={16} />
        </span>
      )}
      <span className={styles.choiceText}>
        <span className={styles.choiceName}>{title}</span>
        <span className={styles.choiceBlurb}>{summary}</span>
        <span className={styles.catalogUpdateNote}>{t(blurb)}</span>
        {update && (
          <span className={styles.catalogUpdateNote}>{t("builtin.cloud.updateNote")}</span>
        )}
      </span>
    </button>
  );
}
