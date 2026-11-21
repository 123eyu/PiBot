import { type RemoteSettings, remoteStunConnection } from "@pibot/remote-contract";
import { SettingsRow, useT } from "@pibot/renderer-kit";
import { Chip } from "@pibot/ui";

/** Rows inside the Devices 高级 fold (it used to be a section of its own there). */
export function StunPrivacy({ settings }: { settings: RemoteSettings }) {
  const t = useT();
  const entry = remoteStunConnection(settings);
  return (
    <SettingsRow
      icon="shield"
      tone="green"
      label={`${t("remote.stun.privacy")} · ${entry.address}`}
      note={t("remote.stun.inventory")}
      info={t("remote.stun.disclosure")}
    >
      <Chip tone={entry.enabled ? "ok" : "neutral"}>
        {t(entry.enabled ? "remote.stun.active" : "remote.stun.inactive")}
      </Chip>
    </SettingsRow>
  );
}
