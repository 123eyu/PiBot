import type { MethodResults } from "@pibot/protocol";
import { useRouter } from "expo-router";
import { type ReactNode, useState } from "react";
import { ScrollView, View } from "react-native";
import type { MobileKey } from "../../i18n/messages.ts";
import { useMobileSelector, useText } from "../../runtime/context.tsx";
import {
  Button,
  EmptyState,
  ErrorLine,
  FootNote,
  ListCard,
  SectionTitle,
  Separator,
} from "../../ui/controls.tsx";
import { HeaderPill, NavBar } from "../../ui/headers.tsx";
import type { IconName } from "../../ui/icons.tsx";
import { SettingRow } from "../../ui/rows.tsx";
import { RunnerAuthorizationStatus } from "./RunnerAuthorizationStatus.tsx";
import { useDevicePage } from "./use-device-page.ts";

type Device = MethodResults["devices.endpoints"]["items"][number];
// Ten devices a page (the method's maximum), so most people see every device at once.
const PAGE = 10;
const icons: Record<Device["kind"], IconName> = {
  desktop: "laptop",
  runner: "server",
  phone: "phone",
};
const platforms: Record<NonNullable<Device["platform"]>, MobileKey> = {
  darwin: "platformMac",
  win32: "platformWindows",
  linux: "platformLinux",
  android: "platformAndroid",
  ios: "platformIos",
};
const paths: Record<NonNullable<Device["path"]>, MobileKey> = {
  lan: "endpointLan",
  punched: "endpointPunched",
  relay: "endpointRelay",
  address: "endpointDirect",
  direct: "endpointDirect",
};
/** "macOS · Runner · Online · Direct": what the device is and how it is reached right now. */
function useDescribe() {
  const t = useText(),
    mobile = useMobileSelector((s) => ({ path: s.path, kind: s.pathKind }));
  return (device: Device, fresh: boolean) => {
    const online = fresh && device.online;
    // The phone's own link to this computer: the TCP LAN socket, or WebRTC on / off the LAN.
    const path =
      device.kind !== "desktop"
        ? device.path
        : mobile.path === "direct" && mobile.kind
          ? mobile.kind
          : mobile.path;
    return [
      device.platform ? t(platforms[device.platform]) : t("endpointPlatformUnknown"),
      device.kind === "runner" && t("deviceRunner"),
      t(online ? "deviceOnline" : "deviceOffline"),
      online && path && t(paths[path]),
    ]
      .filter(Boolean)
      .join(" · ");
  };
}
function useDeviceName() {
  const t = useText();
  return (device: Device) => (device.kind === "desktop" ? t("endpointComputer") : device.name);
}
/** Every device first, each with how it is reached; a tap opens its capabilities. */
export function DeviceList() {
  const t = useText(),
    router = useRouter(),
    describe = useDescribe(),
    nameOf = useDeviceName();
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const page = useDevicePage(cursors.at(-1), PAGE);
  const fresh = page.online && !page.stale && !page.action.busy && !page.action.error;
  const items = page.value?.items ?? [];
  return (
    <ScrollView contentContainerStyle={{ paddingBottom: 32 }}>
      <View style={{ alignItems: "flex-end", paddingHorizontal: 16, paddingTop: 4 }}>
        <HeaderPill
          icon="refresh"
          title={t("refresh")}
          disabled={page.action.busy}
          onPress={() => void page.load()}
        />
      </View>
      <FootNote text={t("devicesPickHint")} />
      <ErrorLine text={page.action.error && t(page.action.error)} />
      {page.action.busy && !page.value && <FootNote text={t("loading")} />}
      {page.value && !fresh && <FootNote text={t("endpointsCached")} />}
      {page.value && !items.length && <EmptyState icon="laptop" title={t("endpointsEmpty")} />}
      {items.length > 0 && (
        <>
          <SectionTitle title={t("devicesListSection")} />
          <ListCard>
            {items.map((device, index) => (
              <View key={device.id}>
                {index > 0 && <Separator />}
                <SettingRow
                  icon={icons[device.kind]}
                  tint={fresh && device.online ? "teal" : "gray"}
                  title={nameOf(device)}
                  hint={describe(device, fresh)}
                  onPress={() =>
                    router.push({
                      pathname: "/endpoint-capabilities",
                      params: {
                        device: device.id,
                        name: nameOf(device),
                        // The detail page reads only the first device page; carry what it needs.
                        runner: device.kind === "runner" ? device.target : "",
                      },
                    })
                  }
                />
              </View>
            ))}
          </ListCard>
          <FootNote text={t("devicesOfflineFoot")} />
        </>
      )}
      {(cursors.length > 1 || !!page.value?.nextAfter) && (
        <View style={{ flexDirection: "row", justifyContent: "center", gap: 8 }}>
          {cursors.length > 1 && (
            <Button
              title={t("endpointsPrev")}
              disabled={page.action.busy}
              onPress={() => setCursors((v) => v.slice(0, -1))}
            />
          )}
          {!!page.value?.nextAfter && (
            <Button
              title={t("devicesLoadMore")}
              disabled={page.action.busy}
              onPress={() => {
                const cursor = page.value?.nextAfter;
                if (cursor) setCursors((v) => [...v, cursor]);
              }}
            />
          )}
        </View>
      )}
    </ScrollView>
  );
}
/** One device's capability rows; its name and state come from the cached device page. */
export function DeviceDetail({
  computerId,
  deviceId,
  fallbackName,
  runnerTarget,
  focused,
  renderCapabilities,
}: {
  computerId: string;
  deviceId: string;
  fallbackName: string;
  runnerTarget?: string;
  focused: boolean;
  renderCapabilities: (endpointId: string) => ReactNode;
}) {
  const router = useRouter(),
    describe = useDescribe(),
    nameOf = useDeviceName();
  const page = useDevicePage(undefined, PAGE);
  const fresh = page.online && !page.stale && !page.action.busy && !page.action.error;
  const device = page.value?.items.find((item) => item.id === deviceId);
  const target = device ? (device.kind === "runner" ? device.target : undefined) : runnerTarget;
  return (
    <>
      <NavBar
        title={device ? nameOf(device) : fallbackName}
        subtitle={device ? describe(device, fresh) : undefined}
        tint="teal"
        onBack={() => router.back()}
      />
      {focused && (
        <ScrollView contentContainerStyle={{ paddingBottom: 32 }}>
          {target && <RunnerAuthorizationStatus computerId={computerId} target={target} />}
          {renderCapabilities(deviceId)}
        </ScrollView>
      )}
    </>
  );
}
