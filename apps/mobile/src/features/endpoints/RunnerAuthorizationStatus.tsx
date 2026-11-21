import { useEffect, useState } from "react";
import { useOffline } from "../../offline/OfflineProvider.tsx";
import { readRunnerAuthorizations } from "../../offline/runner-authorizations.ts";
import { nativeVault } from "../../offline/vault-native.ts";
import { useLanguage, useMobileSelector, useText } from "../../runtime/context.tsx";
import { FootNote } from "../../ui/controls.tsx";

/** Only public expiry metadata leaves the vault; a device row never holds a signed grant. */
export function RunnerAuthorizationStatus({
  computerId,
  target,
}: {
  computerId: string;
  target?: string;
}) {
  const mobile = useMobileSelector((s) => ({ devices: s.devices, selectedId: s.selectedId }));
  const offline = useOffline();
  const language = useLanguage();
  const t = useText();
  const issuer = mobile.devices.find((device) => device.id === computerId)?.publicKey;
  const [state, setState] = useState<{
    computerId: string;
    issuer: string;
    target: string;
    expiresAt?: number;
    failed?: boolean;
  }>();
  const [revision, refresh] = useState(0);
  // The manifest object changes after a sync, not on every streamed model token.
  const manifest = offline.computerId === computerId ? offline.manifest : undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: completed sync and expiry invalidate the secure-store projection.
  useEffect(() => {
    let retired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (!issuer || !target || mobile.selectedId !== computerId) return;
    const identity = { computerId, issuer, target };
    void readRunnerAuthorizations(nativeVault, computerId, issuer).then(
      (grants) => {
        if (retired) return;
        const expiresAt = grants.find((grant) => `runner:${grant.body.runnerId}` === target)?.body
          .expiresAt;
        setState({ ...identity, expiresAt });
        if (expiresAt !== undefined)
          timer = setTimeout(
            () => refresh((value) => value + 1),
            Math.max(1, expiresAt - Date.now()),
          );
      },
      () => {
        if (!retired) setState({ ...identity, failed: true });
      },
    );
    return () => {
      retired = true;
      clearTimeout(timer);
    };
  }, [computerId, issuer, target, mobile.selectedId, manifest, revision]);
  const current =
    state?.computerId === computerId && state.issuer === issuer && state.target === target
      ? state
      : undefined;
  const expiry = current?.expiresAt;
  return (
    <FootNote
      text={`${t("offlineRunnerAuthorization")} · ${
        !issuer || !target
          ? t("offlineRunnerNoAuthorization")
          : !current
            ? t("loading")
            : current.failed
              ? t("offlineRunnerAuthorizationFailed")
              : expiry !== undefined && expiry > Date.now()
                ? t("offlineRunnerAuthorizationUntil", {
                    date: new Date(expiry).toLocaleString(language === "zh" ? "zh-CN" : "en"),
                  })
                : t("offlineRunnerNoAuthorization")
      }`}
    />
  );
}
