/** Settings for selecting the user's browser and showing extension health. */
import type { BrowserExtensionStatusSchema } from "@pibot/protocol";
import {
  SettingsPage,
  SettingsRow,
  SettingsSection,
  TaskStatus,
  useRpc,
  useRpcEvent,
  useT,
  useTask,
} from "@pibot/renderer-kit";
import { SegmentedControl } from "@pibot/ui";
import { useEffect, useState } from "react";
import type { z } from "zod";

type BrowserExtensionStatus = z.infer<typeof BrowserExtensionStatusSchema>;
type ExtensionState = BrowserExtensionStatus["extension"];

const STATUS_TONES = {
  connected: "ok",
  installed: "warn",
  not_installed: "warn",
  unsupported: "danger",
} as const;

export function BrowserSettings() {
  const { peer } = useRpc();
  const t = useT();
  const task = useTask();
  const [status, setStatus] = useState<BrowserExtensionStatus>();
  useEffect(() => {
    if (!peer) return;
    let active = true;
    void peer
      .call("browserExtension.status", {})
      .then((value) => {
        if (active) setStatus(value);
      })
      // An unavailable status leaves the rows disabled; the changed event fills them later.
      .catch(() => {
        if (active) setStatus(undefined);
      });
    return () => {
      active = false;
    };
  }, [peer]);
  useRpcEvent("browserExtension.changed", setStatus);
  const disabled = !peer || task.busy || !status;
  const change = (preference: "user" | "bot") => {
    if (!peer) return;
    void task.run(async () => {
      setStatus(await peer.call("browserExtension.setPreference", { preference }));
    });
  };
  const extension: ExtensionState = status?.extension ?? "unsupported";
  const extensionLabel = {
    connected: t("settings.browserExtensionStatus.connected"),
    installed: t("settings.browserExtensionStatus.installed"),
    not_installed: t("settings.browserExtensionStatus.not_installed"),
    unsupported: t("settings.browserExtensionStatus.unsupported"),
  }[extension];
  const browserName = status?.defaultBrowser?.name ?? t("settings.browserUnknown");
  return (
    <SettingsPage>
      <TaskStatus task={task} />
      <SettingsSection title={t("settings.browserSection")}>
        <SettingsRow
          icon="globe"
          tone="blue"
          label={t("settings.browserDefault")}
          note={browserName}
        />
        <SettingsRow
          icon="plug"
          tone="teal"
          label={t("settings.browserExtension")}
          note={extensionLabel}
          dot={STATUS_TONES[extension]}
        />
        <SettingsRow icon="shield" tone="violet" label={t("settings.browserPreference")}>
          <SegmentedControl
            label={t("settings.browserPreference")}
            disabled={disabled}
            value={status?.preference ?? "user"}
            options={[
              { value: "user", label: t("settings.browserPreferenceUser") },
              { value: "bot", label: t("settings.browserPreferenceBot") },
            ]}
            onValueChange={change}
          />
        </SettingsRow>
      </SettingsSection>
    </SettingsPage>
  );
}
