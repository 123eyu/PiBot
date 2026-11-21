import {
  type RoutinePreauth,
  type RoutinePreauthInput,
  RoutinePreauthInputSchema,
} from "@pibot/protocol";
import { type Peer, useRpcEvent, useSettings } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useCallback, useState } from "react";
import { useRemote } from "../shell/remote.ts";
import styles from "../shell/routines.module.css";
import { ComputerPreauth } from "./ComputerPreauth.tsx";
import { LoginPreauth } from "./LoginPreauth.tsx";
import { PaidImagePreauth } from "./PaidImagePreauth.tsx";
import { PreauthRow } from "./PreauthRow.tsx";
import { operationText, preauthIssue, primaryPath, siteInput } from "./preauth.ts";

export const operationKey = (op: RoutinePreauthInput) => JSON.stringify(op);
export function useRoutinePermissions(botId: string) {
  const load = useCallback(
    async (peer: Peer) => {
      if (!botId) throw new Error("No Bot selected");
      const [permissions, places] = await Promise.all([
        peer.call("permissions.get", { botId }),
        peer.call("workplaces.list", { botId }),
      ]);
      if (permissions.botId !== botId) throw new Error("Permission owner mismatch");
      return { permissions, places };
    },
    [botId],
  );
  const remote = useRemote(load);
  useRpcEvent("permissions.changed", () => remote.refresh());
  useRpcEvent("sidebar.changed", () => remote.refresh());
  return remote;
}

export function PreauthEditor({
  selected,
  change,
  context,
  saved = [],
  imageModel,
}: {
  selected: RoutinePreauthInput[];
  change(ops: RoutinePreauthInput[]): void;
  context: ReturnType<typeof useRoutinePermissions>;
  saved?: RoutinePreauth[];
  /** The image Bot's current model; offers the paid generation pre-approval. */
  imageModel?: { provider: string; id: string };
}) {
  const { t } = useSettings();
  const [options, setOptions] = useState<RoutinePreauthInput[]>([]);
  // "web_submit" is a scope of the web category, offered as its own choice here.
  const [category, setCategory] = useState<
    "read_file" | "list_dir" | "write_file" | "run_command" | "web" | "web_submit"
  >("read_file");
  const [scope, setScope] = useState("");
  const [programs, setPrograms] = useState("");
  const [invalid, setInvalid] = useState(false);
  const { permissions, places } = context.value ?? {};
  const root = places && primaryPath(places);
  const selectedKeys = new Set(selected.map(operationKey));
  const snapshots = new Map(saved.map((p) => [operationKey(p.operation), p]));
  const issue = (op: RoutinePreauthInput) =>
    preauthIssue(op, permissions, places, snapshots.get(operationKey(op)));
  const candidates = new Map<string, RoutinePreauthInput>();
  const defaults: RoutinePreauthInput[] = root
    ? [
        { category: "read_file", scope: { kind: "folder", path: root } },
        { category: "list_dir", scope: { kind: "folder", path: root } },
        { category: "write_file", scope: { kind: "workplace", root } },
      ]
    : [];
  for (const op of [...defaults.filter((op) => !issue(op)), ...options, ...selected])
    candidates.set(operationKey(op), op);
  const add = () => {
    const parsed = RoutinePreauthInputSchema.safeParse({
      category: category === "web_submit" ? "web" : category,
      scope:
        category === "web_submit"
          ? { kind: "submit", domain: siteInput(scope) }
          : category === "web"
            ? { kind: "domain", domain: scope.trim() }
            : category === "run_command"
              ? {
                  kind: "programs",
                  root: root ?? "",
                  programs: programs
                    .split(",")
                    .map((p) => p.trim())
                    .filter(Boolean),
                }
              : category === "write_file"
                ? { kind: "workplace", root: scope.trim() || root || "" }
                : { kind: "folder", path: scope.trim() },
    });
    if (!parsed.success || issue(parsed.data)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setOptions((old) => [...old, parsed.data]);
    change([...selected, parsed.data]);
  };
  return (
    <section className={styles.formCard} data-mark="amber">
      <h2>{t("routines.preauth")}</h2>
      <p className={styles.note}>{t("routines.preauthNote")}</p>
      {context.loading && <p role="status">{t("common.loading")}</p>}
      {context.error && (
        <p role="alert" className={styles.error}>
          {t("routines.preauthUnknown")}{" "}
          <Button variant="secondary" onClick={context.refresh}>
            {t("common.retry")}
          </Button>
        </p>
      )}
      {(["read_file", "list_dir", "write_file", "run_command", "web"] as const).map((group) => {
        // Login and paid image pre-authorizations have their own sections.
        const entries = [...candidates].filter(
          ([, op]) =>
            op.category === group && op.scope.kind !== "login" && op.scope.kind !== "paid_image",
        );
        return (
          entries.length > 0 && (
            <fieldset key={group} className={styles.stack}>
              <legend>{t(`permissions.category.${group}`)}</legend>
              <div className={styles.optRows}>
                {entries.map(([key, op]) => {
                  const checked = selectedKeys.has(key);
                  const problem = issue(op);
                  return (
                    <PreauthRow
                      key={key}
                      kind={op.category}
                      label={`${t(`permissions.category.${op.category}`)} · ${operationText(op, t)}`}
                      problem={problem ? t(problem) : undefined}
                      checked={checked}
                      disabled={!checked && (!!problem || selected.length >= 200)}
                      change={(on) =>
                        change(
                          on ? [...selected, op] : selected.filter((s) => operationKey(s) !== key),
                        )
                      }
                    />
                  );
                })}
              </div>
            </fieldset>
          )
        );
      })}
      <ComputerPreauth selected={selected} change={change} permissions={permissions} />
      <LoginPreauth selected={selected} change={change} permissions={permissions} />
      <PaidImagePreauth
        selected={selected}
        change={change}
        permissions={permissions}
        model={imageModel}
      />
      <div className={styles.grid}>
        <div className={styles.field}>
          <span className={styles.label}>{t("routines.scope")}</span>
          <div className={styles.chips}>
            {(["read_file", "list_dir", "write_file", "run_command", "web"] as const)
              .filter((c) => permissions?.effective && permissions.effective.levels[c] !== "never")
              .map((c) => (
                <button
                  key={c}
                  type="button"
                  className={styles.chip}
                  aria-pressed={category === c}
                  onClick={() => {
                    setCategory(c);
                    setInvalid(false);
                  }}
                >
                  {t(`permissions.category.${c}`)}
                </button>
              ))}
            {permissions?.effective && permissions.effective.levels.web !== "never" && (
              <button
                type="button"
                className={styles.chip}
                aria-pressed={category === "web_submit"}
                onClick={() => {
                  setCategory("web_submit");
                  setInvalid(false);
                }}
              >
                {t("routines.scopeSubmit")}
              </button>
            )}
          </div>
        </div>
        {category === "run_command" ? (
          <label className={styles.field}>
            {t("routines.programs")}
            <input
              value={programs}
              maxLength={2000}
              onChange={(e) => setPrograms(e.currentTarget.value)}
            />
            <span className={styles.note}>{root}</span>
          </label>
        ) : (
          <label className={styles.field}>
            {t("routines.scope")}
            <input
              value={scope}
              placeholder={category === "write_file" ? root : undefined}
              maxLength={32768}
              onChange={(e) => setScope(e.currentTarget.value)}
            />
          </label>
        )}
      </div>
      <div>
        <Button
          variant="secondary"
          disabled={
            !context.value ||
            !permissions?.effective ||
            permissions.effective.levels[category === "web_submit" ? "web" : category] ===
              "never" ||
            options.length >= 200
          }
          onClick={add}
        >
          {t("routines.addScope")}
        </Button>
      </div>
      {invalid && (
        <p role="alert" className={styles.error}>
          {t("routines.invalidScope")}
        </p>
      )}
    </section>
  );
}
