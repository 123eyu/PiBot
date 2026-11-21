import { DEFAULT_STUN_URL, type RemoteDirect, StunUrlSchema } from "@pibot/remote-contract";
import { SettingsLine, SettingsRow, useT } from "@pibot/renderer-kit";
import { SegmentedControl, TextField } from "@pibot/ui";

export function DirectSettings({
  value,
  busy,
  edit,
  commit,
}: {
  value: RemoteDirect;
  busy: boolean;
  /** Changes the shown value only (typing). */
  edit(value: RemoteDirect): void;
  /** Saves the value (a mode switch at once, the address on leaving the field). */
  commit(value: RemoteDirect): void;
}) {
  const t = useT();
  const invalid = !StunUrlSchema.safeParse(value.stunUrl).success;
  return (
    <>
      <SettingsRow
        icon="network"
        tone="green"
        label={t("remote.direct.mode")}
        note={t("remote.direct.scope")}
        stacked
      >
        <SegmentedControl
          label={t("remote.direct.mode")}
          value={value.mode}
          disabled={busy}
          options={[
            { value: "lan", label: t("remote.direct.lan") },
            { value: "stun", label: t("remote.direct.stun") },
          ]}
          onValueChange={(mode) =>
            commit({
              ...value,
              mode,
              stunUrl: StunUrlSchema.safeParse(value.stunUrl).success
                ? value.stunUrl
                : DEFAULT_STUN_URL,
            })
          }
        />
      </SettingsRow>
      {value.mode === "stun" && (
        <>
          <SettingsRow
            icon="network"
            tone="green"
            label={t("remote.stun.address")}
            note={t("remote.stun.disclosure")}
            stacked
          >
            <TextField
              label={t("remote.stun.address")}
              // The row already shows this label (maintainers 2026-11-12: it appeared twice).
              hideLabel
              value={value.stunUrl}
              maxLength={2048}
              disabled={busy}
              aria-invalid={invalid}
              onChange={(event) => edit({ ...value, stunUrl: event.target.value })}
              onBlur={() => {
                if (!invalid) commit(value);
              }}
            />
          </SettingsRow>
          {invalid && (
            <SettingsLine role="alert" tone="danger">
              {t("remote.stun.invalid")}
            </SettingsLine>
          )}
        </>
      )}
    </>
  );
}
