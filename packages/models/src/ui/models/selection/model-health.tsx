import type { ModelInfo, ModelMethodResults, Provider } from "@pibot/models-contract/full";
import { useRpc, useRpcEvent, useSettings, useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useEffect, useRef, useState } from "react";

type Model = { provider: string; id: string };
type RecordedReason = NonNullable<ModelMethodResults["models.health"][number]>;
type Reason = RecordedReason | "sign_in_required" | "provider_not_configured";

function unavailable(
  model: Model | null | undefined,
  providers: Provider[],
  available: ModelInfo[],
  catalog: ModelInfo[],
  recorded: RecordedReason | null | undefined,
): Reason | undefined {
  if (!model) return "no_model";
  const entries = providers.filter((provider) => provider.id === model.provider);
  const signedIn = entries.find((provider) => provider.chatgpt)?.chatgpt;
  if (signedIn && signedIn.state !== "connected") return "sign_in_required";
  if (signedIn && recorded === "auth_failed") return "sign_in_required";
  if (recorded) return recorded;
  if (available.some((item) => item.provider === model.provider && item.id === model.id)) return;
  if (entries.length && !entries.some((entry) => entry.configured) && !signedIn)
    return "provider_not_configured";
  if (!catalog.some((item) => item.provider === model.provider && item.id === model.id))
    return "model_not_found";
  return "no_model";
}

export function useModelHealth(providers: Provider[], models: ModelInfo[], catalog: ModelInfo[]) {
  const { settings } = useSettings();
  const { peer } = useRpc();
  const [revision, setRevision] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const changed = () => {
    // One run may publish both chat and inbox changes; these are display reads, not a poll.
    timer.current ??= setTimeout(() => {
      timer.current = undefined;
      setRevision((value) => value + 1);
    }, 150);
  };
  useEffect(() => {
    if (!peer) return;
    return () => {
      clearTimeout(timer.current);
      timer.current = undefined;
    };
  }, [peer]);
  useRpcEvent("chat.done", changed);
  useRpcEvent("chat.error", changed);
  useRpcEvent("inbox.changed", changed);
  const defaults = settings?.defaultModel;
  const auxiliary = settings?.auxiliaryModel ?? defaults;
  const requested = [defaults, auxiliary].filter((model): model is Model => !!model);
  const key = JSON.stringify(requested.map(({ provider, id }) => ({ provider, id })));
  const [observed, setObserved] = useState<{ key: string; reasons: (RecordedReason | null)[] }>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: completed runs and credential refreshes invalidate recorded evidence without changing the selected model.
  useEffect(() => {
    if (!peer) return;
    const controller = new AbortController();
    void peer
      .call(
        "models.health",
        { models: JSON.parse(key) },
        {
          signal: controller.signal,
          timeoutMs: 10_000,
        },
      )
      .then((reasons) => {
        if (!controller.signal.aborted) setObserved({ key, reasons });
      })
      .catch(() => {
        // Older owners have no health projection; login/catalog facts still remain available.
        if (!controller.signal.aborted) setObserved(undefined);
      });
    return () => controller.abort();
  }, [peer, key, revision, providers]);
  const reasons = observed?.key === key ? observed.reasons : undefined;
  return {
    default: settings ? unavailable(defaults, providers, models, catalog, reasons?.[0]) : undefined,
    auxiliary: settings
      ? unavailable(auxiliary, providers, models, catalog, reasons?.[defaults ? 1 : 0])
      : undefined,
  };
}

export function openModelPicker(id: string) {
  document.getElementById(id)?.click();
}

export function ModelHealthNotice({
  reason,
  label,
  pickerId,
}: {
  reason?: Reason;
  label?: string;
  pickerId: string;
}) {
  const t = useT();
  if (!reason) return null;
  const explanation =
    reason === "model_not_found"
      ? t("models.health.notFound")
      : reason === "sign_in_required"
        ? t("models.health.signIn")
        : reason === "provider_not_configured"
          ? t("models.health.configure")
          : t(`errors.${reason}`);
  return (
    <span role="alert">
      {label && <strong>{label} · </strong>}
      {t("models.health.unavailable", { reason: explanation })}{" "}
      <Button variant="ghost" onClick={() => openModelPicker(pickerId)}>
        {t("models.health.change")}
      </Button>
    </span>
  );
}
