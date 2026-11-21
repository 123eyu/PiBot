import { useRpc, useT } from "@pibot/renderer-kit";
import type { WorkflowBinding, WorkflowSummary, Workplaces } from "@pibot/skills-contract/full";
import { Button } from "@pibot/ui";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { pathInFolders } from "./state.ts";
import styles from "./workflow.module.css";

export function WorkflowFields({
  botId,
  groupId,
  workflow,
  value,
  disabled,
  change,
}: {
  botId: string;
  groupId?: string;
  workflow: WorkflowSummary;
  value: WorkflowBinding;
  disabled?: boolean;
  change(value: WorkflowBinding): void;
}) {
  const t = useT();
  const { peer } = useRpc();
  const [places, setPlaces] = useState<Workplaces>();
  const [pickError, setPickError] = useState(false);
  const [fileFolders, setFileFolders] = useState<Record<string, string>>({});
  const picking = useRef<AbortController | undefined>(undefined);
  const fieldId = useId();
  useEffect(() => () => picking.current?.abort(), []);
  useEffect(() => {
    if (!peer) return;
    const abort = new AbortController();
    setPlaces(undefined);
    void peer
      .call("workplaces.list", { botId }, { signal: abort.signal })
      .then((result) => {
        if (!abort.signal.aborted) setPlaces(result);
      })
      .catch(() => undefined);
    return () => abort.abort();
  }, [peer, botId]);

  const folders = useMemo(
    () =>
      places
        ? [
            { path: places.home, name: t("folders.home") },
            ...places.folders.map(({ path, name }) => ({ path, name })),
          ].filter(
            (folder, index, all) => all.findIndex((item) => item.path === folder.path) === index,
          )
        : [],
    [places, t],
  );
  const roots = folders.map((folder) => folder.path);
  const setParam = (name: string, next: string) =>
    change({ ...value, params: { ...value.params, [name]: next } });
  const setInput = (name: string, next: string) =>
    change({ ...value, inputs: { ...value.inputs, [name]: next } });
  const pick = async (name: string, kind: "folder" | "file") => {
    if (!peer || picking.current) return;
    const abort = new AbortController();
    picking.current = abort;
    setPickError(false);
    const defaultPath = fileFolders[name] ?? folders[0]?.path;
    try {
      const path = await peer.call(
        "skills.pickWorkflowInput",
        { botId, groupId, kind, ...(defaultPath ? { defaultPath } : {}) },
        { signal: abort.signal, timeoutMs: 630_000 },
      );
      if (path && !abort.signal.aborted) setInput(name, path);
    } catch {
      if (!abort.signal.aborted) setPickError(true);
    } finally {
      if (picking.current === abort) picking.current = undefined;
    }
  };
  const contract = workflow.contract;
  if (!contract) return null;
  return (
    <div className={styles.fields}>
      {!!workflow.params.length && (
        <section className={styles.group} aria-label={t("workflows.params")}>
          <h3>{t("workflows.params")}</h3>
          {workflow.params.map((param) => (
            <label className={styles.field} key={param.name}>
              <span>{param.name}</span>
              {param.description && <small>{param.description}</small>}
              <input
                maxLength={1000}
                value={value.params[param.name] ?? ""}
                disabled={disabled}
                onChange={(event) => setParam(param.name, event.currentTarget.value)}
              />
            </label>
          ))}
        </section>
      )}
      {!!contract.inputs.length && (
        <section className={styles.group} aria-label={t("workflows.inputs")}>
          <h3>{t("workflows.inputs")}</h3>
          {contract.inputs.map((input, index) => {
            const current = value.inputs[input.name] ?? "";
            const id = `${fieldId}-${index}`;
            const outside =
              (input.kind === "folder" || input.kind === "file") &&
              !!current &&
              !!roots.length &&
              !pathInFolders(current, roots);
            if (input.kind === "previous")
              return (
                <div className={styles.previous} key={input.name}>
                  <strong>{input.name}</strong>
                  <span>{t("workflows.previous")}</span>
                </div>
              );
            return (
              <div className={styles.field} key={input.name}>
                <label htmlFor={id}>
                  {input.name}
                  {input.required && <em>{t("workflows.input.required")}</em>}
                </label>
                {input.description && <small>{input.description}</small>}
                {input.kind === "text" ? (
                  <textarea
                    id={id}
                    rows={4}
                    maxLength={4000}
                    value={current}
                    disabled={disabled}
                    onChange={(event) => setInput(input.name, event.currentTarget.value)}
                  />
                ) : input.kind === "folder" ? (
                  <select
                    id={id}
                    value={
                      folders.some((folder) => folder.path === current)
                        ? current
                        : current
                          ? "__custom"
                          : ""
                    }
                    disabled={disabled}
                    onChange={(event) => {
                      if (event.currentTarget.value === "__other") void pick(input.name, "folder");
                      else if (event.currentTarget.value !== "__custom")
                        setInput(input.name, event.currentTarget.value);
                    }}
                  >
                    <option value="">{t("workflows.input.folder")}</option>
                    {folders.map((folder) => (
                      <option value={folder.path} key={folder.path}>
                        {folder.name}
                      </option>
                    ))}
                    {current && !folders.some((folder) => folder.path === current) && (
                      <option value="__custom">{current}</option>
                    )}
                    <option value="__other">{t("workflows.other")}</option>
                  </select>
                ) : (
                  <div className={styles.fileField}>
                    {!!folders.length && (
                      <select
                        aria-label={t("workflows.startFolder")}
                        value={fileFolders[input.name] ?? folders[0]?.path ?? ""}
                        disabled={disabled}
                        onChange={(event) =>
                          setFileFolders((old) => ({
                            ...old,
                            [input.name]: event.currentTarget.value,
                          }))
                        }
                      >
                        {folders.map((folder) => (
                          <option value={folder.path} key={folder.path}>
                            {folder.name}
                          </option>
                        ))}
                      </select>
                    )}
                    <div className={styles.pathRow}>
                      <input id={id} readOnly value={current} disabled={disabled} />
                      <Button
                        type="button"
                        variant="secondary"
                        disabled={disabled}
                        onClick={() => void pick(input.name, "file")}
                      >
                        {t("workflows.chooseFile")}
                      </Button>
                    </div>
                  </div>
                )}
                {/* A picked folder is readable for this run (read-only); a file still asks. */}
                {outside && (
                  <small className={input.kind === "folder" ? styles.note : styles.warn}>
                    {t(input.kind === "folder" ? "workflows.outsideFolder" : "workflows.outside")}
                  </small>
                )}
              </div>
            );
          })}
        </section>
      )}
      {pickError && (
        <p role="alert" className={styles.error}>
          {t("workflows.pickError")}
        </p>
      )}
    </div>
  );
}
