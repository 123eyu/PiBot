import { type Bot, type BuiltinRoleView, RpcError, RpcErrorCodes } from "@pibot/protocol";
import { useAction, useRpc, useSettings, useT } from "@pibot/renderer-kit";
import { Button, Chip, Icon } from "@pibot/ui";
import { useEffect, useId, useState } from "react";
import styles from "./builtin.module.css";
import {
  builtinError,
  permissionItems,
  RoleAvatar,
  roleTone,
  useBuiltinCatalog,
} from "./shared.tsx";

/**
 * The second step of "New Bot": name and an optional extra description for the picked role, with what
 * the Bot comes with (norms, skills, tightened permissions, starters) shown before creating.
 */
export function RoleCreate({
  role: picked,
  onBack,
  onCreated,
}: {
  role: BuiltinRoleView;
  onBack(): void;
  onCreated(bot: Bot): void;
}) {
  const t = useT();
  const id = useId();
  const { peer } = useRpc();
  // The picked role is a snapshot taken when it was clicked; the catalog reloads on a language
  // change, so the page reads the current wording and keeps the snapshot only until it arrives.
  const { catalog } = useBuiltinCatalog();
  const role = catalog?.roles.find((item) => item.id === picked.id) ?? picked;
  const defaults = useSettings().settings?.defaultModel;
  const [modelName, setModelName] = useState<string>();
  useEffect(() => {
    setModelName(undefined);
    if (!peer || !defaults) return;
    const abort = new AbortController();
    void peer
      .call("models.list", { availableOnly: true }, { signal: abort.signal, timeoutMs: 10000 })
      .then(
        (models) => {
          if (!abort.signal.aborted)
            setModelName(
              models.find(
                (model) => model.provider === defaults.provider && model.id === defaults.id,
              )?.name,
            );
        },
        () => {
          /* The role remains creatable; no raw provider model id is used as a display name. */
        },
      );
    return () => abort.abort();
  }, [peer, defaults]);
  const task = useAction();
  const [name, setName] = useState(picked.defaultBotName);
  const [extra, setExtra] = useState("");
  /** A typed name another Bot already has; shown under the field, the form stays. */
  const [nameError, setNameError] = useState<string>();
  const permissions = permissionItems(role, t);
  const create = () => {
    if (!peer || role.unavailable) return;
    const typed = name.trim();
    setNameError(undefined);
    void task
      .run(async () => {
        try {
          return await peer.call(
            "builtin.createBot",
            {
              roleId: role.id,
              // The role's own name is numbered by the brain when taken; a typed one is refused.
              ...(typed && typed !== role.defaultBotName ? { name: typed } : {}),
              ...(extra.trim() ? { description: extra.trim() } : {}),
            },
            { timeoutMs: 120_000 },
          );
        } catch (error) {
          if (error instanceof RpcError && error.code === RpcErrorCodes.botNameTaken) {
            setNameError(t("workspace.nameTaken", { name: typed }));
            return undefined;
          }
          throw error;
        }
      }, builtinError)
      .then((result) => {
        // The Bot is committed even if a skill copy failed (rare; the brain log names it), so
        // the window moves on to it; a missing skill can be added from the profile later.
        if (result) onCreated(result.bot);
      });
  };
  return (
    <form
      className={`${styles.stack} ${styles.roleForm}`}
      style={roleTone(role)}
      aria-labelledby={`${id}-title`}
      onSubmit={(event) => {
        event.preventDefault();
        create();
      }}
    >
      <div>
        <Button variant="pill" className={styles.back} disabled={task.busy} onClick={onBack}>
          <Icon name="chevronRight" size={14} className={styles.backIcon} />
          {t("builtin.role.back")}
        </Button>
      </div>
      <div className={`${styles.summary} ${styles.hero}`}>
        <div className={styles.row}>
          <RoleAvatar role={role} size={56} />
          <div className={styles.rowText}>
            <h1 id={`${id}-title`} className={styles.heading}>
              {role.name}
            </h1>
            <p className={styles.note}>{role.summary}</p>
          </div>
        </div>
      </div>
      <label className={styles.field}>
        {t("builtin.role.name")}
        <input
          className={styles.input}
          required
          maxLength={200}
          value={name}
          disabled={task.busy}
          aria-invalid={!!nameError || undefined}
          aria-describedby={nameError ? `${id}-name-error` : undefined}
          onChange={(event) => {
            setName(event.currentTarget.value);
            setNameError(undefined);
          }}
        />
      </label>
      {nameError && (
        <p id={`${id}-name-error`} role="alert" className={styles.error}>
          {nameError}
        </p>
      )}
      <label className={styles.field}>
        {t("builtin.role.extra")}
        <textarea
          className={styles.textarea}
          rows={2}
          maxLength={4000}
          value={extra}
          disabled={task.busy}
          placeholder={t("builtin.role.extraHint")}
          onChange={(event) => setExtra(event.currentTarget.value)}
        />
      </label>
      <section className={styles.card}>
        <p className={styles.note}>
          {role.botCategory === "image"
            ? t("builtin.role.imageModel")
            : defaults
              ? t("builtin.role.model", { model: modelName ?? t("builtin.role.defaultLabel") })
              : t("builtin.role.noModel")}
        </p>
        {role.visionWarning && <p className={styles.warn}>{t("builtin.role.visionWarning")}</p>}
        <h2 className={styles.subheading}>{t("builtin.role.permissions")}</h2>
        {permissions.length ? (
          <div className={styles.chips}>
            {permissions.map((item) => (
              <Chip key={item.line} tone={item.tone}>
                {item.line}
              </Chip>
            ))}
          </div>
        ) : (
          <p className={styles.note}>{t("builtin.role.noPermissions")}</p>
        )}
        <p className={styles.note}>{t("builtin.role.permissionsNote")}</p>
        <h2 className={styles.subheading}>
          {role.skills.length
            ? t("builtin.role.skills", { count: role.skills.length })
            : t("builtin.role.noSkills")}
        </h2>
        {!!role.skills.length && (
          <div className={styles.chips}>
            {role.skills.map((skill) => (
              <Chip key={skill.id} tone="neutral">
                {skill.name}
                {skill.scripts > 0 && ` · ${t("builtin.role.scripts", { count: skill.scripts })}`}
              </Chip>
            ))}
          </div>
        )}
        <h2 className={styles.subheading}>{t("builtin.role.norms")}</h2>
        <div className={styles.pre}>{role.norms}</div>
        {!!role.quickPrompts.length && (
          <>
            <h2 className={styles.subheading}>{t("builtin.role.quickPrompts")}</h2>
            <div className={styles.chips}>
              {role.quickPrompts.map((prompt) => (
                <span key={prompt} className={styles.prompt}>
                  {prompt}
                </span>
              ))}
            </div>
          </>
        )}
      </section>
      {role.unavailable && <p className={styles.warn}>{t("builtin.role.unavailable")}</p>}
      {task.error && (
        <p role="alert" className={styles.error}>
          {t(task.error)}
        </p>
      )}
      <div className={`${styles.actions} ${styles.foot}`}>
        <Button variant="ghost" disabled={task.busy} onClick={onBack}>
          {t("builtin.role.back")}
        </Button>
        <Button
          type="submit"
          loading={task.busy}
          disabled={!peer || !name.trim() || !!role.unavailable}
        >
          {t("builtin.role.create")}
        </Button>
      </div>
    </form>
  );
}
