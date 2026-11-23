import { Fragment } from "react";
import { Text, View } from "react-native";
import type { MobileKey } from "../../i18n/messages.ts";
import { useText } from "../../runtime/context.tsx";
import { useColors } from "../../theme/use-theme.ts";
import { Separator, Switch } from "../../ui/controls.tsx";
import type { usePhoneData } from "./use-phone-data.ts";

// Each source says what it reads, not one shared sentence for both.
const READ_ROWS = [
  {
    kind: "notifications",
    title: "phoneDataNotifications",
    granted: "phoneDataNotificationsGranted",
    ask: "phoneDataNotificationsAsk",
  },
  {
    kind: "calls",
    title: "phoneDataCalls",
    granted: "phoneDataCallsGranted",
    ask: "phoneDataCallsAsk",
  },
] as const;
// No operation contract yet, so these never get a switch.
const PENDING_ROWS = ["phoneDataAccessibility", "phoneDataShizuku"] as const;

/** Rows; a saved preference or an OS grant alone never enables a capability. */
export function AndroidCapabilityRows({ data }: { data: ReturnType<typeof usePhoneData> }) {
  const t = useText(),
    colors = useColors();
  const row = (
    title: MobileKey,
    hint: MobileKey,
    value: boolean,
    onChange?: (on: boolean) => void,
  ) => (
    <Fragment key={title}>
      <Separator />
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12, padding: 14 }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={{ fontSize: 15, color: colors.text }}>{t(title)}</Text>
          <Text style={{ fontSize: 12.5, color: colors.text2, marginTop: 2 }}>{t(hint)}</Text>
        </View>
        <Switch
          label={t(title)}
          value={value}
          disabled={!onChange || data.busy}
          onValueChange={(on) => onChange?.(on)}
        />
      </View>
    </Fragment>
  );
  return (
    <>
      {READ_ROWS.map(({ kind, title, granted, ask }) => {
        const access = data.platform === "android" ? data.readPages[kind] : "unsupported";
        return access === "unsupported"
          ? row(title, "phoneDataAdapterMissing", false)
          : row(
              title,
              access === "granted" ? granted : ask,
              data.prefs[kind],
              (on) => void data.setReadPage(kind, on),
            );
      })}
      {PENDING_ROWS.map((title) =>
        row(
          title,
          data.platform === "android" ? "phoneDataContractPending" : "phoneDataAdapterMissing",
          false,
        ),
      )}
    </>
  );
}
