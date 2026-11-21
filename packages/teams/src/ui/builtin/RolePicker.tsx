// Keep local and downloadable roles in the same approved selection flow.
import { BuiltinRoleCategorySchema, type BuiltinRoleView } from "@pibot/protocol";
import { useNavigation, useT } from "@pibot/renderer-kit";
import { Button, Icon } from "@pibot/ui";
import { forwardRef, type ReactNode, useId, useLayoutEffect, useRef, useState } from "react";
import styles from "./builtin.module.css";
import { CatalogCard, CatalogNotice, CatalogRefresh } from "./CloudCatalog.tsx";
import { catalogCandidates, catalogMatches, withInstalled } from "./catalog-model.ts";
import { useRoleCategoryExtensions } from "./role-extensions.tsx";
import { RoleAvatar, roleTone, useBuiltinCatalog } from "./shared.tsx";
import { useRoleCatalog } from "./use-role-catalog.ts";

type RoleImportTarget = { kind: "role"; id: string; version: number };

type Category = (typeof BuiltinRoleCategorySchema.options)[number];

/** Name, Bot name or summary contains the query (case-insensitive); blank keeps every role. */
export function filterRoles(roles: readonly BuiltinRoleView[], query: string): BuiltinRoleView[] {
  const needle = query.trim().toLocaleLowerCase();
  return roles.filter(
    (role) =>
      !needle ||
      [role.name, role.defaultBotName, role.summary].some((text) =>
        text.toLocaleLowerCase().includes(needle),
      ),
  );
}

export function RoleSearch({
  query,
  change,
  trailing,
  disabled,
}: {
  query: string;
  change(value: string): void;
  disabled?: boolean;
  trailing?: ReactNode;
}) {
  const t = useT();
  return (
    <div className={styles.catalogSearch}>
      <label className={styles.searchField}>
        <Icon name="search" size={15} />
        <input
          className={styles.search}
          disabled={disabled}
          type="search"
          aria-label={t("builtin.role.search")}
          placeholder={t("builtin.role.search")}
          value={query}
          maxLength={100}
          onChange={(event) => change(event.currentTarget.value)}
        />
      </label>
      {trailing}
    </div>
  );
}

/** One soft role card in the role's colour: avatar, bold name, one-line description. */
export const RoleCard = forwardRef<
  HTMLButtonElement,
  {
    role: BuiltinRoleView;
    pressed?: boolean;
    disabled?: boolean;
    onPick(role: BuiltinRoleView): void;
  }
>(({ role, pressed, disabled, onPick }, ref) => {
  const t = useT();
  const blurb = role.unavailable ? t("builtin.role.unavailable") : role.summary;
  return (
    <button
      type="button"
      className={styles.choice}
      style={roleTone(role)}
      aria-pressed={pressed}
      disabled={disabled || !!role.unavailable}
      title={role.unavailable ? t("builtin.role.unavailable") : role.summary}
      ref={ref}
      onClick={() => onPick(role)}
    >
      <RoleAvatar role={role} size={32} />
      <span className={styles.choiceText}>
        <span className={styles.choiceName}>{role.name}</span>
        <span className={styles.choiceBlurb}>{blurb}</span>
      </span>
    </button>
  );
});
RoleCard.displayName = "RoleCard";

/**
 * The approved role browser (batch1 `roles`): search, category chips (全部 + each category that
 * has roles), then a three-column grid. Typing searches every category, so it resets the chip.
 */
export function RoleBrowser({
  roles,
  loaded,
  onPick,
  selected,
  disabled,
  trailing,
  onInstalled,
  target,
}: {
  roles: readonly BuiltinRoleView[];
  loaded: boolean;
  onPick(role: BuiltinRoleView): void;
  selected?: string;
  disabled?: boolean;
  /** The last tile of the grid (通用 · 自己描述 in "New Bot"). */
  trailing?: ReactNode;
  onInstalled?(): void;
  target?: RoleImportTarget;
}) {
  const t = useT();
  const cloud = useRoleCatalog(target);
  const availableRoles = withInstalled(roles, cloud.catalog?.roles);
  const candidates = catalogCandidates(cloud.state?.entries ?? [], "role");
  const local = new Map(availableRoles.map((role) => [role.id, role]));
  const remote = new Map(candidates.map((entry) => [entry.id, entry]));
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<Category | "all">("all");
  // A capability's own category (external agents) replaces the grid while it is chosen.
  const extensions = useRoleCategoryExtensions();
  const [extension, setExtension] = useState<string>();
  const shown = extensions.find((item) => item.id === extension);
  const categories = BuiltinRoleCategorySchema.options.filter(
    (value) =>
      availableRoles.some((role) => role.category === value) ||
      candidates.some((entry) => entry.category === value),
  );
  const matches = filterRoles(availableRoles, query);
  const matchedIds = new Set(matches.map((role) => role.id));
  const found = matches.filter(
    (role) => !remote.has(role.id) && (category === "all" || role.category === category),
  );
  const downloads = candidates.filter(
    (entry) =>
      (category === "all" || entry.category === category) &&
      (catalogMatches(entry, cloud.language, query) || matchedIds.has(entry.id)),
  );
  const targetRole = target && availableRoles.find((role) => role.id === target.id);
  const targetReady = !!targetRole && targetRole.version >= target.version;
  const targetRef = useRef<HTMLButtonElement>(null);
  // The link's role is picked once when it becomes available, not again on every render.
  const targetDone = useRef(false);
  useLayoutEffect(() => {
    if (!targetReady || targetDone.current) return;
    targetDone.current = true;
    targetRef.current?.focus();
    targetRef.current?.scrollIntoView({ block: "center" });
    onPick(targetRole);
  }, [targetReady, targetRole, onPick]);
  async function download(entry: (typeof candidates)[number]) {
    const catalog = await cloud.install(entry);
    if (!catalog) return;
    onInstalled?.();
    const role = catalog.roles.find((value) => value.id === entry.id);
    if (role) onPick(role);
  }
  return (
    <>
      <RoleSearch
        query={query}
        disabled={!!cloud.busy}
        trailing={<CatalogRefresh cloud={cloud} />}
        change={(value) => {
          setQuery(value);
          setCategory("all");
          setExtension(undefined);
        }}
      />
      <CatalogNotice cloud={cloud} />
      {target && cloud.targetMissing && (
        <p role="status" className={styles.note}>
          {t("builtin.cloud.targetMissing")}
        </p>
      )}
      {(categories.length > 1 || extensions.length > 0) && (
        <fieldset className={styles.cats} aria-label={t("builtin.category.label")}>
          {(["all", ...categories] as const).map((value) => (
            <button
              key={value}
              type="button"
              disabled={!!cloud.busy}
              aria-pressed={!shown && category === value}
              onClick={() => {
                setCategory(value);
                setExtension(undefined);
              }}
            >
              {t(`builtin.category.${value}`)}
            </button>
          ))}
          {extensions.map((item) => (
            <button
              key={item.id}
              type="button"
              disabled={!!cloud.busy}
              aria-pressed={shown?.id === item.id}
              onClick={() => setExtension(item.id)}
            >
              {item.label}
            </button>
          ))}
        </fieldset>
      )}
      {shown?.render()}
      {!shown && loaded && !found.length && !downloads.length && query.trim() && (
        <p role="status" className={styles.note}>
          {t("builtin.role.none", { name: query.trim() })}
        </p>
      )}
      {/* Not `hidden`: the grid's own display rule would override it and keep the roles visible. */}
      {!shown && (
        <div className={styles.roles}>
          {found.map((role) => (
            <RoleCard
              key={role.id}
              role={role}
              pressed={selected === undefined ? undefined : selected === role.id}
              disabled={disabled || !!cloud.busy}
              onPick={onPick}
              ref={role.id === target?.id ? targetRef : undefined}
            />
          ))}
          {downloads.map((entry) => (
            <CatalogCard
              key={entry.id}
              entry={entry}
              cloud={cloud}
              role={local.get(entry.id)}
              pressed={selected === undefined ? undefined : selected === entry.id}
              disabled={disabled}
              onInstalled={() => void download(entry)}
            />
          ))}
          {trailing}
        </div>
      )}
    </>
  );
}

/**
 * The first step of "New Bot" — roles by category chip and searchable; the last tile
 * keeps today's behaviour (describe the job and let a model write the persona).
 */
export function RolePicker({
  onCustom,
  onPick,
  hideTitle = false,
  target,
}: {
  onCustom(): void;
  onPick(role: BuiltinRoleView): void;
  /** Inside a dialog whose frame already says 「选一个角色」 (the ＋ menu's 新建 Bot). */
  hideTitle?: boolean;
  target?: RoleImportTarget;
}) {
  const t = useT();
  const { openWorkspace } = useNavigation();
  const id = useId();
  const { catalog, error, reload } = useBuiltinCatalog();
  return (
    <section
      className={styles.stack}
      {...(hideTitle
        ? { "aria-label": t("builtin.role.title") }
        : { "aria-labelledby": `${id}-title` })}
    >
      <div>
        {!hideTitle && (
          <h1 id={`${id}-title`} className={styles.heading}>
            {t("builtin.role.title")}
          </h1>
        )}
        <p className={styles.note}>{t("builtin.role.hint")}</p>
      </div>
      {error && (
        <p role="alert" className={styles.error}>
          {t("builtin.role.loadFailed")}
        </p>
      )}
      {!catalog && !error && (
        <p role="status" className={styles.note}>
          {t("common.loading")}
        </p>
      )}
      <RoleBrowser
        roles={catalog?.roles ?? []}
        loaded={!!catalog}
        onInstalled={reload}
        onPick={onPick}
        target={target}
        trailing={
          <button type="button" className={styles.choice} onClick={onCustom}>
            <span className={styles.icon} aria-hidden="true">
              <Icon name="edit" size={16} />
            </span>
            <span className={styles.choiceText}>
              <span className={styles.choiceName}>{t("builtin.role.custom")}</span>
              <span className={styles.choiceBlurb} title={t("builtin.role.customHint")}>
                {t("builtin.role.customHint")}
              </span>
            </span>
          </button>
        }
      />
      <div className={styles.importRow}>
        <Button variant="pill" onClick={() => openWorkspace({ name: "team" })}>
          {t("builtin.custom.import")}
        </Button>
        <p className={styles.note}>{t("builtin.custom.importHint")}</p>
      </div>
    </section>
  );
}
