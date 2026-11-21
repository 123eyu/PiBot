import {
  CloudCredentialsSchema,
  type MethodParams,
  type Provider,
} from "@pibot/models-contract/full";
import { AppSelect, setupStyles as styles, useRpc, useT } from "@pibot/renderer-kit";
import { Button, TextField } from "@pibot/ui";
import { useEffect, useState } from "react";
import { requirePeer, writeCredential } from "../../setup/operations.ts";
import authStyles from "./auth-forms.module.css";
import type { Task } from "./provider-form.tsx";

export function CloudProviderForm({
  provider,
  task,
  refresh,
  onDirtyChange,
}: {
  provider: Provider;
  task: Task;
  refresh(): Promise<void>;
  onDirtyChange?(dirty: boolean): void;
}) {
  const { peer } = useRpc();
  const t = useT();
  const [fields, setFields] = useState<Record<string, string>>({});
  const [mode, setMode] = useState("keys");
  const [identityAcknowledged, setIdentityAcknowledged] = useState(false);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    let active = true;
    void peer
      ?.call("providers.getConfig", { providerId: provider.id })
      .then((config) => {
        if (!active || !config) return;
        const { providerId: _id, ...publicFields } = config;
        setFields(
          Object.fromEntries(
            Object.entries(publicFields).map(([key, value]) => [
              key,
              typeof value === "string" ? value : JSON.stringify(value),
            ]),
          ),
        );
        if ("mode" in config) setMode(config.mode);
      })
      .catch(() => {
        /* RPC disconnect leaves the replacement form usable. */
      });
    return () => {
      active = false;
    };
  }, [peer, provider.id]);
  const disabled = task.busy || task.blocked || !peer;
  const update = (name: string, value: string) => {
    setFields((old) => ({ ...old, [name]: value }));
    setDirty(true);
  };
  const field = (
    name:
      | "region"
      | "profile"
      | "accessKeyId"
      | "secretAccessKey"
      | "sessionToken"
      | "project"
      | "location"
      | "endpoint"
      | "apiVersion"
      | "accountId"
      | "gatewayId"
      | "apiToken",
    secret = false,
  ) => (
    <TextField
      key={name}
      label={t(`auth.${name}`)}
      value={fields[name] ?? ""}
      type={secret ? "password" : "text"}
      autoComplete={secret ? "new-password" : "off"}
      disabled={disabled}
      onChange={(e) => update(name, e.target.value)}
    />
  );
  const localIdentity = mode === "profile" || mode === "adc";
  return (
    <form
      className={styles.stack}
      onSubmit={(event) => {
        event.preventDefault();
        void task.run(async () => {
          const f = (key: string) => fields[key] ?? "";
          let input: unknown;
          if (provider.id === "amazon-bedrock")
            input = {
              providerId: provider.id,
              region: f("region"),
              auth:
                mode === "profile"
                  ? { kind: "profile", profile: f("profile") }
                  : {
                      kind: "keys",
                      accessKeyId: f("accessKeyId"),
                      secretAccessKey: f("secretAccessKey"),
                      ...(f("sessionToken") ? { sessionToken: f("sessionToken") } : {}),
                    },
            };
          else if (provider.id === "google-vertex")
            input = {
              providerId: provider.id,
              project: f("project"),
              location: f("location"),
              auth:
                mode === "adc"
                  ? { kind: "adc" }
                  : {
                      kind: "serviceAccount",
                      serviceAccountJson: JSON.stringify(JSON.parse(f("json"))),
                    },
            };
          else if (provider.id === "azure")
            input = {
              providerId: provider.id,
              endpoint: f("endpoint"),
              apiVersion: f("apiVersion"),
              deployments: JSON.parse(f("deployments") || "{}"),
              apiKey: f("apiToken"),
            };
          else
            input = {
              providerId: provider.id,
              accountId: f("accountId"),
              apiToken: f("apiToken"),
              ...(provider.id === "cloudflare-ai-gateway" ? { gatewayId: f("gatewayId") } : {}),
            };
          if (localIdentity && !identityAcknowledged) return;
          try {
            const parsed = CloudCredentialsSchema.parse(input);
            await writeCredential(() =>
              requirePeer(peer).call(
                "providers.setCredentials",
                parsed as MethodParams["providers.setCredentials"],
              ),
            );
            task.setSuccess(t("setup.saved"));
            setDirty(false);
          } finally {
            setFields((old) =>
              Object.fromEntries(
                Object.entries(old).filter(
                  ([name]) =>
                    ![
                      "accessKeyId",
                      "secretAccessKey",
                      "sessionToken",
                      "apiToken",
                      "json",
                    ].includes(name),
                ),
              ),
            );
          }
          await refresh();
        });
      }}
    >
      {(provider.id === "amazon-bedrock" || provider.id === "google-vertex") && (
        <AppSelect
          label={t("auth.method")}
          value={provider.id === "google-vertex" && mode === "keys" ? "serviceAccount" : mode}
          disabled={disabled}
          change={(value) => {
            setMode(value);
            setIdentityAcknowledged(false);
            setDirty(true);
          }}
          options={(provider.id === "amazon-bedrock"
            ? (["keys", "profile"] as const)
            : (["serviceAccount", "adc"] as const)
          ).map((value) => ({ value, label: t(`auth.mode.${value}`) }))}
        />
      )}
      {provider.id === "amazon-bedrock" && (
        <>
          {field("region")}
          {mode === "profile" ? (
            field("profile")
          ) : (
            <>
              {field("accessKeyId", true)}
              {field("secretAccessKey", true)}
              {field("sessionToken", true)}
            </>
          )}
        </>
      )}
      {provider.id === "google-vertex" && (
        <>
          {field("project")}
          {field("location")}
          {mode !== "adc" && (
            <>
              <label className={authStyles.field}>
                {t("auth.json")}
                <textarea
                  value={fields.json ?? ""}
                  disabled={disabled}
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(e) => update("json", e.target.value)}
                />
              </label>
              <label className={authStyles.field}>
                {t("auth.jsonFile")}
                <input
                  type="file"
                  accept=".json,application/json"
                  disabled={disabled}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (file)
                      void task.run(async () => {
                        if (file.size > 1048576) throw new Error("File too large");
                        update("json", JSON.stringify(JSON.parse(await file.text())));
                      });
                  }}
                />
              </label>
            </>
          )}
        </>
      )}
      {provider.id === "azure" && (
        <>
          {field("endpoint")}
          {field("apiToken", true)}
          {field("apiVersion")}
          <label className={authStyles.field}>
            {t("auth.deployments")}
            <textarea
              value={fields.deployments ?? "{}"}
              disabled={disabled}
              onChange={(e) => update("deployments", e.target.value)}
            />
          </label>
        </>
      )}
      {provider.id.startsWith("cloudflare-") && (
        <>
          {field("accountId")}
          {provider.id === "cloudflare-ai-gateway" && field("gatewayId")}
          {field("apiToken", true)}
        </>
      )}
      {localIdentity && (
        <label className={authStyles.confirm}>
          <input
            type="checkbox"
            checked={identityAcknowledged}
            disabled={disabled}
            onChange={(e) => setIdentityAcknowledged(e.target.checked)}
          />
          {t("auth.identityNote")}
        </label>
      )}
      <p className={styles.note}>{t("auth.cloudNote")}</p>
      <Button
        type="submit"
        loading={task.busy}
        disabled={disabled || (localIdentity && !identityAcknowledged)}
      >
        {t("common.save")}
      </Button>
    </form>
  );
}
