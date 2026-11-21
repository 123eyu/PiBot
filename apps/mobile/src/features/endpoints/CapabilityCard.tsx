import { Text, View } from "react-native";
import { useLanguage, useText } from "../../runtime/context.tsx";
import { space, type } from "../../theme/scale.ts";
import { useColors } from "../../theme/use-theme.ts";
import { Button, Switch } from "../../ui/controls.tsx";
import { useTimeText } from "../../ui/time.ts";
import type { EndpointRow } from "./model.ts";

const availability = {
  available: undefined,
  local_switch_off: "endpointsLocalOff",
  unsupported: "endpointsUnsupported",
} as const;
const states = { auto_on: "endpointsAuto", user_on: "endpointsOn", off: "endpointsOff" } as const;

/**
 * Capability row, as the desktop "device capabilities": the name, who may use it and when it
 * was last called, then Scope and the switch on the right. Problems (local switch off, offline)
 * are in the warning colour on the second line.
 */
export function CapabilityRow({
  row,
  writable,
  onToggle,
  onScope,
}: {
  row: EndpointRow;
  writable: boolean;
  onToggle: (enabled: boolean) => void;
  onScope: () => void;
}) {
  const t = useText(),
    colors = useColors(),
    language = useLanguage(),
    time = useTimeText();
  const name = row.name[language];
  const enabled = row.state !== "off";
  const describe = (ids: string[] | null) =>
    t(ids === null ? "endpointsAll" : ids.length ? "endpointsSelected" : "endpointsNone", {
      count: ids?.length ?? 0,
    });
  const problem = availability[row.availability];
  const facts = [
    t(states[row.state]),
    `${t("endpointsBots")} ${describe(row.scope.botIds)} · ${t("endpointsGroups")} ${describe(row.scope.groupIds)}`,
    row.lastCalledAt && t("endpointsLastCall", { time: time.stamp(row.lastCalledAt) }),
  ].filter(Boolean);
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        minHeight: space.settingsRow,
        paddingVertical: 10,
        paddingHorizontal: 14,
      }}
    >
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <Text style={[type.rowTitle, { color: colors.text }]}>{name}</Text>
        <Text style={[type.caption, { color: colors.text2 }]}>{facts.join(" · ")}</Text>
        {(!!problem || !row.online) && (
          <Text style={[type.caption, { color: colors.warn }]}>
            {[problem && t(problem), !row.online && t("deviceOffline")].filter(Boolean).join(" · ")}
          </Text>
        )}
      </View>
      <Button title={t("endpointsScopeEdit")} disabled={!writable} onPress={onScope} />
      <Switch
        label={name}
        value={enabled}
        disabled={!writable || (!enabled && (!row.online || row.availability !== "available"))}
        onValueChange={onToggle}
      />
    </View>
  );
}
