import {
  CONNECTOR_IMPORT_MAX_BYTES,
  type ConnectorAccess,
  type MethodResults,
  newConnectionDefaults,
} from "@pibot/plugins-contract/full";
import { hostPlatform, useRpc, useRpcEvent, useSettings } from "@pibot/renderer-kit";
import { Button, Chip, Switch } from "@pibot/ui";
import { useEffect, useId, useRef, useState } from "react";
import { ConnectorAccessEditor } from "../page/ConnectorAccessEditor.tsx";
import { ConnectorPanel } from "../page/ConnectorPanel.tsx";
import styles from "../page/connectors.module.css";
import { connectorError } from "../shell/remote.ts";

type Preview = MethodResults["plugins.previewImport"];
// Previewing and importing a large package (13k files, minutes on a loaded
// machine) is a long operation, not a hung request. A short fixed timeout aborted it mid-way
// and left the user with a failure they could not retry; the bound only guards a real hang.
const LONG_OPERATION_TIMEOUT_MS = 30 * 60_000;
// Keep only reviewable, sanitized metadata, never a second copy of raw JSON or headers/env values.
function summary(value: Preview) {
  return {
    previewId: value.previewId,
    digest: value.digest,
    expiresAt: value.expiresAt,
    declaredVersion: value.declaredVersion,
    name: value.manifest.name,
    description: value.manifest.description,
    plugin: value.plugin,
    commandWarnings: value.commandWarnings,
    servers: value.manifest.servers.map((server) => ({
      id: server.id,
      transport: server.transport,
      auth: server.auth.kind,
      secrets: server.auth.secretNames,
      domains: server.networkDomains,
      cwd: server.transport === "stdio" ? server.cwd : undefined,
      startupTimeoutSec: server.startupTimeoutSec,
      target:
        server.transport === "http"
          ? server.url
          : server.transport === "stdio"
            ? JSON.stringify([server.command, ...server.args])
            : server.builtinId,
      bundledNode:
        value.plugin &&
        server.transport === "stdio" &&
        (server.command === "node" || server.command === "node.exe"),
    })),
  };
}
type Summary = ReturnType<typeof summary>;

export function ImportPlugin({
  close,
  changed,
  initialText = "",
  initialSelectionId,
  presetTarget,
}: {
  close(): void;
  changed(): void;
  initialText?: string;
  initialSelectionId?: string;
  presetTarget?: { kind: "bot" | "group"; id: string };
}) {
  const { peer } = useRpc();
  const { t, language } = useSettings();
  const inputId = useId();
  const [targets, setTargets] = useState<ConnectorAccess>(() => ({
    mode: "selected",
    bots: presetTarget?.kind === "bot" ? [presetTarget.id] : [],
    groups: presetTarget?.kind === "group" ? [presetTarget.id] : [],
  }));
  const [text, setText] = useState(initialText);
  const [preview, setPreview] = useState<Summary>();
  const [config, setConfig] = useState<Record<string, string | number | boolean>>({});
  const [networkDomains, setNetworkDomains] = useState<Record<string, string[]>>({});
  const [configurationReviewed, setConfigurationReviewed] = useState(true);
  const [busy, setBusy] = useState<"preview" | "import">();
  // A large import copies thousands of files; show real progress instead of a
  // spinner that looks hung for minutes.
  const [progress, setProgress] = useState<{ files: number; total: number }>();
  useRpcEvent("skills.importProgress", (value) => {
    if (value.phase === "copying") setProgress({ files: value.files, total: value.totalFiles });
    else setProgress(undefined);
  });
  const [error, setError] = useState<
    ReturnType<typeof connectorError> | "connectors.tooLarge" | "connectors.skillsPartial"
  >();
  const [partialInstallation, setPartialInstallation] = useState<string>();
  const [uncertain, setUncertain] = useState(false);
  const [now, setNow] = useState(Date.now());
  const active = useRef(true);
  const locked = useRef(false);
  const previewRef = useRef<{ peer: NonNullable<typeof peer>; id: string } | undefined>(undefined);
  const imported = useRef(false);
  const [cancelError, setCancelError] = useState(false);
  const cancelFailure = useRef(false);
  const retireRef = useRef<() => Promise<void>>(async () => {});
  const retire = async () => {
    const held = previewRef.current;
    previewRef.current = undefined;
    if (!held || imported.current) return;
    try {
      await held.peer.call("plugins.cancelPreview", { previewId: held.id }, { timeoutMs: 5_000 });
    } catch {
      // Expiry still bounds backend retention. Surface cleanup failure while the panel is alive.
      cancelFailure.current = true;
      if (active.current) setCancelError(true);
    }
  };
  retireRef.current = retire;
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      void retireRef.current();
    };
  }, []);
  // A backend restart invalidates its in-memory preview, even if the panel stays open.
  const originalPeer = useRef(peer);
  useEffect(() => {
    if (originalPeer.current === peer) return;
    originalPeer.current = peer;
    setText("");
    setPreview(undefined);
    setPartialInstallation(undefined);
    setNetworkDomains({});
    setConfigurationReviewed(true);
    setError("connectors.offline");
    setBusy(undefined);
    locked.current = false;
  }, [peer]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  const expired = !!preview && now >= Date.parse(preview.expiresAt);
  const noSkillTarget = !targets.bots.length && !targets.groups.length;
  const targetRequired = !!preview?.plugin?.skillCount && !preview.servers.length && noSkillTarget;
  // With no servers and no skills there is nothing to import; a button that imports nothing
  // looked like a broken preview next to a 「0 个技能」 heading.
  const nothingToImport = !preview?.servers.length && (preview?.plugin?.skillCount ?? 0) === 0;
  const missingRequired =
    preview?.plugin?.config.some((field) => {
      if (field.visibleWhen) {
        const controlling = preview.plugin?.config.find(
          (candidate) => candidate.key === field.visibleWhen?.key,
        );
        const value = config[field.visibleWhen.key] ?? controlling?.default;
        if (value !== field.visibleWhen.equals) return false;
      }
      if (!field.required) return false;
      const value = config[field.key];
      return (
        value === undefined ||
        (typeof value === "string" && value.trim() === "") ||
        (typeof value === "number" && !Number.isFinite(value))
      );
    }) ?? false;
  const currentPeer = useRef(peer);
  currentPeer.current = peer;
  const read = async (selectionId?: string) => {
    if (!peer || locked.current || (!selectionId && !text.trim())) return;
    if (!selectionId && new TextEncoder().encode(text).byteLength > CONNECTOR_IMPORT_MAX_BYTES) {
      setError("connectors.tooLarge");
      return;
    }
    const receiving = peer;
    locked.current = true;
    setBusy("preview");
    setError(undefined);
    try {
      const value = await receiving.call(
        "plugins.previewImport",
        { source: selectionId ? { kind: "selection", selectionId } : { kind: "json", text } },
        { timeoutMs: LONG_OPERATION_TIMEOUT_MS },
      );
      if (!active.current || currentPeer.current !== receiving) {
        // Closing during parsing must also retire a late-created backend preview.
        try {
          await receiving.call(
            "plugins.cancelPreview",
            { previewId: value.previewId },
            { timeoutMs: 5_000 },
          );
        } catch {
          cancelFailure.current = true;
        }
        return;
      }
      setText("");
      imported.current = false;
      previewRef.current = { peer: receiving, id: value.previewId };
      setPreview(summary(value));
      setNetworkDomains({});
      setConfigurationReviewed((value.plugin?.config.length ?? 0) === 0);
      setConfig(
        Object.fromEntries(
          (value.plugin?.config ?? [])
            .filter((field) => field.default !== undefined)
            .map((field) => [field.key, field.default as string | number | boolean]),
        ),
      );
      setNow(Date.now());
    } catch (failure) {
      if (active.current && currentPeer.current === receiving) setError(connectorError(failure));
    } finally {
      if (active.current && currentPeer.current === receiving) {
        locked.current = false;
        setBusy(undefined);
      }
    }
  };
  const openedSelection = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the selection is consumed once per mounted importer.
  useEffect(() => {
    if (!peer || !initialSelectionId || openedSelection.current) return;
    openedSelection.current = true;
    void read(initialSelectionId);
  }, [peer, initialSelectionId]);
  const refreshConfiguration = async () => {
    if (!peer || !preview?.plugin || missingRequired || locked.current) return;
    const receiving = peer;
    locked.current = true;
    setBusy("preview");
    setError(undefined);
    try {
      const value = await receiving.call(
        "plugins.previewImport",
        { source: { kind: "configured", previewId: preview.previewId, config } },
        { timeoutMs: LONG_OPERATION_TIMEOUT_MS },
      );
      if (!active.current || currentPeer.current !== receiving) {
        try {
          await receiving.call(
            "plugins.cancelPreview",
            { previewId: value.previewId },
            { timeoutMs: 5_000 },
          );
        } catch {
          cancelFailure.current = true;
        }
        return;
      }
      imported.current = false;
      previewRef.current = { peer: receiving, id: value.previewId };
      setPreview(summary(value));
      // A changed target is a new authorization snapshot; domain removals must be confirmed again.
      setNetworkDomains({});
      setConfigurationReviewed(true);
      setNow(Date.now());
    } catch (failure) {
      if (active.current && currentPeer.current === receiving) setError(connectorError(failure));
    } finally {
      if (active.current && currentPeer.current === receiving) {
        locked.current = false;
        setBusy(undefined);
      }
    }
  };
  const pick = async (kind: "file" | "directory") => {
    if (!peer || locked.current) return;
    locked.current = true;
    setBusy("preview");
    setError(undefined);
    try {
      // The method declares the picker's own long deadline; a shorter local one turned a
      // dialog still on screen into 「未能及时确认结果」. A cancel comes back as a result.
      const result = await peer.call("plugins.pickImport", { kind });
      locked.current = false;
      if (!active.current || result.canceled) return;
      if (result.selectionId) await read(result.selectionId);
    } catch (failure) {
      if (active.current) setError(connectorError(failure));
    } finally {
      if (active.current) {
        locked.current = false;
        setBusy(undefined);
      }
    }
  };
  const install = async (enable: boolean) => {
    if (
      !peer ||
      !preview ||
      (expired && !partialInstallation) ||
      missingRequired ||
      targetRequired ||
      (partialInstallation && noSkillTarget) ||
      !configurationReviewed ||
      locked.current ||
      uncertain
    )
      return;
    const receiving = peer;
    locked.current = true;
    setBusy("import");
    setError(undefined);
    try {
      const result = partialInstallation
        ? await (async () => {
            const status = await receiving.call("plugins.skillAssignments", {
              installationId: partialInstallation,
            });
            const assigned = await receiving.call(
              "plugins.assignSkills",
              {
                installationId: partialInstallation,
                expectedRevision: status.revision,
                targets: { bots: targets.bots, groups: targets.groups },
              },
              { timeoutMs: LONG_OPERATION_TIMEOUT_MS },
            );
            return {
              installation: { id: partialInstallation },
              unassignedSkillCount: assigned.unassignedCount,
              pendingSkillTargetCount: assigned.pendingTargetCount,
            };
          })()
        : await receiving.call(
            "plugins.import",
            {
              previewId: preview.previewId,
              expectedDigest: preview.digest,
              enable,
              config,
              networkDomains,
              skillTargets: { bots: targets.bots, groups: targets.groups },
            },
            { timeoutMs: LONG_OPERATION_TIMEOUT_MS },
          );
      imported.current = true;
      if (active.current && currentPeer.current === receiving) {
        changed();
        if ((result.pendingSkillTargetCount || result.unassignedSkillCount) && !noSkillTarget) {
          setError("connectors.skillsPartial");
          setPartialInstallation(result.installation.id);
        } else close();
      }
    } catch (failure) {
      if (active.current && currentPeer.current === receiving) {
        const key = connectorError(failure);
        setError(key);
        // No blind retries after an ambiguous mutation ACK. Lists/events remain authoritative.
        if (["connectors.timeout", "connectors.offline", "connectors.failed"].includes(key))
          setUncertain(true);
        changed();
      }
    } finally {
      if (active.current && currentPeer.current === receiving) {
        locked.current = false;
        setBusy(undefined);
      }
    }
  };
  return (
    <ConnectorPanel title={t("connectors.import")} close={close} busy={busy === "import"}>
      <p className={styles.note}>{t("connectors.jsonNote")}</p>
      {!peer && (
        <p role="alert" className={styles.error}>
          {t("connectors.offline")}
        </p>
      )}
      {!preview ? (
        <div className={styles.formCard}>
          <div className={styles.row}>
            {(["file", "directory"] as const).map((kind) => (
              <Button
                key={kind}
                variant="secondary"
                disabled={!!busy || !peer}
                onClick={() => void pick(kind)}
              >
                {t(kind === "file" ? "connectors.chooseJson" : "connectors.chooseDirectory")}
              </Button>
            ))}
          </div>
          <label className={styles.field} htmlFor={inputId}>
            {t("connectors.json")}
            <textarea
              id={inputId}
              value={text}
              rows={12}
              spellCheck={false}
              autoComplete="off"
              disabled={!!busy || !peer}
              onChange={(event) => setText(event.currentTarget.value)}
            />
          </label>
          <Button
            loading={busy === "preview"}
            disabled={!peer || !text.trim()}
            onClick={() => void read()}
          >
            {t(busy === "preview" ? "connectors.reading" : "connectors.preview")}
          </Button>
        </div>
      ) : (
        <>
          <h3>{preview.name[language]}</h3>
          <p>{preview.description[language]}</p>
          {preview.commandWarnings?.map((risk) => (
            <p key={risk} role="alert" className={styles.warn}>
              {t(
                risk === "dangerous"
                  ? "connectors.commandDangerous"
                  : "connectors.commandUnverified",
              )}
            </p>
          ))}
          {preview.declaredVersion && (
            <p className={styles.note}>
              {t("connectors.importVersion", { version: preview.declaredVersion })}
            </p>
          )}
          {preview.servers.length > 0 && (
            <section className={styles.card}>
              <h3>{t("connectors.previewConnections", { count: preview.servers.length })}</h3>
              <p className={styles.note}>{t("connectors.previewToolsUnknown")}</p>
            </section>
          )}
          {!!preview.plugin?.skillCount && (
            <section className={styles.card}>
              <h3>{t("connectors.previewSkills", { count: preview.plugin.skillCount })}</h3>
              <ConnectorAccessEditor
                access={targets}
                disabled={!!busy || uncertain}
                save={setTargets}
              />
              {noSkillTarget && (
                <p className={styles.note}>{t("connectors.skillTargetRequired")}</p>
              )}
            </section>
          )}
          {preview.plugin && (
            <>
              <p>
                {t("connectors.previewComponents", {
                  count: preview.plugin.components.length,
                  skills: preview.plugin.skillCount,
                })}
              </p>
              {preview.plugin.components.map((component) => (
                <section
                  key={`${component.kind}:${component.path ?? component.name}`}
                  className={styles.card}
                >
                  <strong>{component.name}</strong>
                  <p>
                    {t(
                      component.status === "import"
                        ? "connectors.componentImport"
                        : "connectors.componentUnsupported",
                    )}
                    {component.reason
                      ? ` · ${t(`connectors.unsupported.${component.reason}`)}`
                      : ""}
                  </p>
                  {component.path && <p className={styles.note}>{component.path}</p>}
                </section>
              ))}
              {preview.plugin.config.length > 0 && (
                <div className={styles.formCard}>
                  {preview.plugin.config.map((field) => {
                    if (field.visibleWhen) {
                      const controlling = preview.plugin?.config.find(
                        (candidate) => candidate.key === field.visibleWhen?.key,
                      );
                      const visibleValue = config[field.visibleWhen.key] ?? controlling?.default;
                      if (visibleValue !== field.visibleWhen.equals) return null;
                    }
                    const value = config[field.key] ?? "";
                    const fieldId = `${inputId}-${field.key}`;
                    return (
                      <label key={field.key} className={styles.field} htmlFor={fieldId}>
                        {field.title}
                        {field.type === "boolean" ? (
                          <Switch
                            id={fieldId}
                            label={field.title}
                            checked={value === true}
                            onCheckedChange={(checked) => {
                              setConfigurationReviewed(false);
                              setConfig((current) => ({ ...current, [field.key]: checked }));
                            }}
                          />
                        ) : field.options?.length ? (
                          <select
                            id={fieldId}
                            value={String(value)}
                            required={field.required}
                            onChange={(event) => {
                              const selected = field.options?.find(
                                (option) => String(option.value) === event.currentTarget.value,
                              );
                              if (!selected) return;
                              setConfigurationReviewed(false);
                              setConfig((current) => ({
                                ...current,
                                [field.key]: selected.value,
                              }));
                            }}
                          >
                            {field.options.map((option) => (
                              <option key={String(option.value)} value={String(option.value)}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <input
                            id={fieldId}
                            type={
                              field.sensitive
                                ? "password"
                                : field.type === "number"
                                  ? "number"
                                  : "text"
                            }
                            value={String(value)}
                            required={field.required}
                            autoComplete="off"
                            onChange={(event) => {
                              const raw = event.currentTarget.value;
                              setConfigurationReviewed(false);
                              setConfig((current) => ({
                                ...current,
                                [field.key]:
                                  field.type === "number" && raw !== "" ? Number(raw) : raw,
                              }));
                            }}
                          />
                        )}
                        <span className={styles.note}>
                          {field.description ||
                            t(
                              field.sensitive
                                ? "connectors.generatedSecret"
                                : "connectors.generatedSetting",
                            )}
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}
              {!configurationReviewed && (
                <div className={styles.stack}>
                  <p className={styles.note}>{t("connectors.configurationReviewNote")}</p>
                  <Button
                    variant="secondary"
                    loading={busy === "preview"}
                    disabled={missingRequired || !!busy}
                    onClick={() => void refreshConfiguration()}
                  >
                    {t("connectors.reviewConfiguration")}
                  </Button>
                </div>
              )}
            </>
          )}
          <p className={styles.note}>{t("connectors.previewSanitized")}</p>
          {preview.servers.map((server) => (
            <section key={server.id} className={styles.card}>
              <strong>
                {server.id} · {t(`connectors.transport.${server.transport}`)}
              </strong>
              <pre>{server.target}</pre>
              {server.bundledNode && <p className={styles.note}>{t("connectors.bundledNode")}</p>}
              {server.cwd && (
                <p className={styles.note}>{t("connectors.startup.cwd", { cwd: server.cwd })}</p>
              )}
              {server.startupTimeoutSec && (
                <p className={styles.note}>
                  {t("connectors.startup.timeout", { seconds: String(server.startupTimeoutSec) })}
                </p>
              )}
              <p>{t(`connectors.auth.${server.auth}`)}</p>
              <strong>{t("connectors.network")}</strong>
              {(networkDomains[server.id] ?? server.domains).length ? (
                <div className={styles.stack}>
                  {(networkDomains[server.id] ?? server.domains).map((domain) => (
                    <div key={domain} className={styles.row}>
                      <Chip className={styles.grow}>{domain}</Chip>
                      {server.transport === "stdio" && (
                        <Button
                          variant="ghost"
                          disabled={!!busy}
                          aria-label={t("connectors.removeNetworkDomain", { domain })}
                          onClick={() =>
                            setNetworkDomains((current) => ({
                              ...current,
                              [server.id]: (current[server.id] ?? server.domains).filter(
                                (candidate) => candidate !== domain,
                              ),
                            }))
                          }
                        >
                          {t("connectors.remove")}
                        </Button>
                      )}
                    </div>
                  ))}
                  {server.transport === "stdio" &&
                    server.domains.some((domain) =>
                      ["registry.npmjs.org", "pypi.org", "files.pythonhosted.org"].includes(domain),
                    ) && <p className={styles.note}>{t("connectors.packageNetworkHint")}</p>}
                </div>
              ) : (
                <p>{t("connectors.noNetwork")}</p>
              )}
              <strong>{t("connectors.requiredSecrets")}</strong>
              {server.secrets.length ? (
                <div className={styles.chipRow}>
                  {server.secrets.map((secret) => (
                    <Chip key={secret} tone="violet" className={styles.mono}>
                      {secret}
                    </Chip>
                  ))}
                </div>
              ) : (
                <p>{t("connectors.noSecrets")}</p>
              )}
            </section>
          ))}
          {hostPlatform() === "win32" &&
            preview.servers.some((server) => server.transport === "stdio") && (
              <p role="alert" className={styles.warn}>
                {t("connectors.windowsWarning")}
              </p>
            )}
          {preview.servers.length > 0 && (
            <p>
              {t("connectors.importDefaults", {
                access: t(`connectors.access.${newConnectionDefaults.accessMode}`),
                confirmation: t(
                  `connectors.confirmation.${newConnectionDefaults.confirmationMode}`,
                ),
              })}
            </p>
          )}
          {nothingToImport && <p className={styles.note}>{t("connectors.nothingToImport")}</p>}
          <p className={styles.note}>{t("connectors.importNote")}</p>
          <p role="status" className={expired ? styles.error : styles.note}>
            {expired
              ? t("connectors.expired")
              : t("connectors.expires", {
                  time: new Date(preview.expiresAt).toLocaleString(language),
                })}
          </p>
          <div className={styles.row}>
            <Button
              variant="secondary"
              disabled={!!busy || uncertain || !!partialInstallation}
              onClick={() => {
                void retire();
                setPreview(undefined);
                setConfig({});
                setNetworkDomains({});
                setConfigurationReviewed(true);
                setError(undefined);
              }}
            >
              {t("connectors.newPreview")}
            </Button>
            <Button
              variant="secondary"
              disabled={
                !peer ||
                (expired && !partialInstallation) ||
                missingRequired ||
                targetRequired ||
                nothingToImport ||
                !!partialInstallation ||
                !configurationReviewed ||
                !!busy ||
                uncertain
              }
              onClick={() => void install(false)}
            >
              {t("connectors.importOnly")}
            </Button>
            <Button
              loading={busy === "import"}
              disabled={
                !peer ||
                (expired && !partialInstallation) ||
                missingRequired ||
                targetRequired ||
                nothingToImport ||
                (!!partialInstallation && noSkillTarget) ||
                !configurationReviewed ||
                !!busy ||
                uncertain
              }
              onClick={() => void install(true)}
            >
              {t(partialInstallation ? "common.retry" : "connectors.importEnable")}
            </Button>
          </div>
        </>
      )}
      {busy === "import" && progress && (
        <p className={styles.note}>
          {t("connectors.importProgress", { files: progress.files, total: progress.total })}
        </p>
      )}
      {error && (
        <p role="alert" className={styles.error}>
          {t(error)}
        </p>
      )}
      {cancelError && (
        <p role="alert" className={styles.error}>
          {t("connectors.failed")}
        </p>
      )}
      {uncertain && (
        <>
          <p role="alert">{t("connectors.importUncertain")}</p>
          <Button
            onClick={() => {
              changed();
              close();
            }}
          >
            {t("connectors.checkList")}
          </Button>
        </>
      )}
    </ConnectorPanel>
  );
}
