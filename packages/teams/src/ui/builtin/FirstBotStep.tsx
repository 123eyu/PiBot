// Keep the welcome choice usable after a role is installed from the full browser.
import type { BuiltinPlan, MethodResults } from "@pibot/protocol";
import { useAction, useRpc, useT } from "@pibot/renderer-kit";
import { Button, Chip } from "@pibot/ui";
import { type Ref, useEffect, useId, useImperativeHandle, useLayoutEffect, useState } from "react";
import styles from "./builtin.module.css";
import { RoleBrowser, RoleCard } from "./RolePicker.tsx";
import {
  builtinError,
  permissionItems,
  RoleAvatar,
  roleTone,
  useBuiltinCatalog,
} from "./shared.tsx";

// A first run starts with one Bot; these four cover the most common first jobs.
const RECOMMENDED = ["general-assistant", "researcher", "data-analyst", "copywriter"];

export interface FirstBotHandle {
  /** False when the step has nothing to go back to and the wizard should leave it. */
  back(): boolean;
  next(): void;
}
export interface FirstBotStatus {
  stage: "pick" | "more";
  busy: boolean;
  ready: boolean;
}

/**
 * The welcome wizard's Bot step. Its actions live in the wizard footer (through `ref`), so
 * the step stays one screen. Creation is the profession flow's path with a single role:
 * `builtin.plan` for the summary and `builtin.create` reusing a Bot that already has the role.
 */
export function FirstBotStep({
  ref,
  initialRole,
  onRole,
  onStatus,
  onFinish,
}: {
  ref: Ref<FirstBotHandle>;
  /** The role picked on an earlier visit, so 上一步 from a later step keeps it selected. */
  initialRole?: string;
  onRole?(roleId: string | undefined): void;
  onStatus(status: FirstBotStatus): void;
  onFinish(result: MethodResults["builtin.create"] | null): void;
}) {
  const t = useT();
  const id = useId();
  const { peer } = useRpc();
  const { catalog, error, reload } = useBuiltinCatalog();
  const task = useAction();
  const [stage, setStage] = useState<"pick" | "more">("pick");
  const [selected, setSelected] = useState<string | undefined>(initialRole);
  useEffect(() => onRole?.(selected), [onRole, selected]);
  const [details, setDetails] = useState(false);
  // Tagged with its role so a reply for an earlier pick never stands for the current one.
  const [plan, setPlan] = useState<{ roleId: string; value: BuiltinPlan }>();
  const [planFailed, setPlanFailed] = useState(false);
  const roles = new Map(catalog?.roles.map((role) => [role.id, role]));
  const role = selected ? roles.get(selected) : undefined;
  // A role picked from the full list joins the cards so the choice stays in view.
  const cards = [
    ...RECOMMENDED,
    ...(selected && !RECOMMENDED.includes(selected) ? [selected] : []),
  ].flatMap((roleId) => roles.get(roleId) ?? []);
  useEffect(() => {
    if (!peer || !selected) return;
    let active = true;
    setPlanFailed(false);
    peer
      .call("builtin.plan", { roles: [selected], reuseExisting: true })
      .then((value) => {
        if (active) setPlan({ roleId: selected, value });
      })
      .catch(() => {
        if (active) setPlanFailed(true);
      });
    return () => {
      active = false;
    };
  }, [peer, selected]);
  const current = plan && plan.roleId === selected ? plan.value : undefined;
  const planned = current?.bots.find((bot) => bot.roleId === selected);
  const counts = current?.counts;
  const overLimit = !!counts && counts.newBots > counts.maxBots;
  const ready =
    stage === "pick" &&
    !!peer &&
    !!role &&
    !role.unavailable &&
    !!current &&
    !overLimit &&
    !task.busy &&
    task.error !== "workspace.createUncertain";
  useLayoutEffect(
    () => onStatus({ stage, busy: task.busy, ready }),
    [onStatus, stage, task.busy, ready],
  );
  const next = () => {
    if (!ready || !peer || !selected) return;
    // Going back and forward again must not make a second Bot of the same role.
    if (counts?.newBots === 0) {
      onFinish(null);
      return;
    }
    void task
      .run(
        () =>
          peer.call(
            "builtin.create",
            { roles: [selected], reuseExisting: true, source: "profession" },
            { timeoutMs: 180_000 },
          ),
        builtinError,
      )
      .then((result) => {
        if (result) onFinish(result);
      });
  };
  useImperativeHandle(ref, () => ({
    back: () => {
      if (stage === "pick") return false;
      setStage("pick");
      return true;
    },
    next,
  }));
  const pick = (roleId: string) => {
    setSelected(roleId);
    setDetails(false);
  };
  const status = (
    <>
      {error && (
        <p role="alert" className={styles.error}>
          {t("builtin.role.loadFailed")}
        </p>
      )}
      {!catalog && !error && <p role="status">{t("common.loading")}</p>}
    </>
  );
  if (stage === "more") {
    return (
      <section className={styles.stack} aria-labelledby={`${id}-more`}>
        <h1 id={`${id}-more`} className={styles.heading}>
          {t("builtin.role.title")}
        </h1>
        {status}
        <RoleBrowser
          roles={catalog?.roles ?? []}
          loaded={!!catalog}
          onInstalled={reload}
          selected={selected}
          onPick={(value) => {
            pick(value.id);
            setStage("pick");
          }}
        />
      </section>
    );
  }
  const permissions = role ? permissionItems(role, t) : [];
  return (
    <section className={styles.stack} aria-labelledby={`${id}-title`}>
      <div>
        <h1 id={`${id}-title`} className={styles.heading}>
          {t("builtin.firstBot.title")}
        </h1>
        <p className={styles.note}>{t("builtin.firstBot.subtitle")}</p>
      </div>
      {status}
      <div className={styles.grid}>
        {cards.map((card) => (
          <RoleCard
            key={card.id}
            role={card}
            pressed={selected === card.id}
            disabled={task.busy}
            onPick={(value) => pick(value.id)}
          />
        ))}
      </div>
      {catalog && (
        <div>
          <Button variant="pill" disabled={task.busy} onClick={() => setStage("more")}>
            {t("builtin.firstBot.more")}
          </Button>
        </div>
      )}
      {role && (
        <section className={styles.summary} style={roleTone(role)} aria-live="polite">
          <span className={styles.row}>
            <RoleAvatar role={role} size={30} />
            <span className={styles.rowText}>
              {planned?.existingBotName
                ? t("builtin.preview.reuse", { name: planned.existingBotName })
                : t("builtin.firstBot.summary", {
                    name: planned?.name ?? role.defaultBotName,
                    role: role.name,
                  })}
            </span>
            <Button variant="pill" aria-expanded={details} onClick={() => setDetails((v) => !v)}>
              {t(details ? "builtin.firstBot.hideDetails" : "builtin.firstBot.showDetails")}
            </Button>
          </span>
          {details && (
            <>
              <span className={styles.note}>{role.summary}</span>
              {permissions.length ? (
                <span className={styles.chips}>
                  {permissions.map((item) => (
                    <Chip key={item.line} tone={item.tone}>
                      {item.line}
                    </Chip>
                  ))}
                </span>
              ) : (
                <span className={styles.note}>{t("builtin.role.noPermissions")}</span>
              )}
            </>
          )}
          {planFailed && (
            <span role="alert" className={styles.error}>
              {t("builtin.role.loadFailed")}
            </span>
          )}
          {overLimit && counts && (
            <span className={styles.warn}>
              {t("builtin.preview.overLimit", {
                maxGroups: counts.maxGroups,
                maxBots: counts.maxBots,
                groups: counts.groups,
                bots: counts.newBots,
              })}
            </span>
          )}
        </section>
      )}
      {task.error && (
        <p role="alert" className={styles.error}>
          {t(task.error)}
        </p>
      )}
    </section>
  );
}
