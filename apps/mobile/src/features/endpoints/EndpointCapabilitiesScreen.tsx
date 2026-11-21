import { RpcError, RpcErrorCodes } from "@pibot/protocol";
import { useIsFocused, useLocalSearchParams, useRouter } from "expo-router";
import { Fragment, useEffect, useState } from "react";
import { View } from "react-native";
import { useLanguage, useLinkState, useRuntime, useText } from "../../runtime/context.tsx";
import { confirmBiometrically } from "../../runtime/local-auth.ts";
import { useAction } from "../../runtime/use-action.ts";
import { useColors } from "../../theme/use-theme.ts";
import {
  Button,
  EmptyState,
  ErrorLine,
  FootNote,
  ListCard,
  SectionTitle,
  Separator,
} from "../../ui/controls.tsx";
import { NavBar } from "../../ui/headers.tsx";
import { Sheet, SheetText, SheetTitle } from "../../ui/sheet.tsx";
import { CapabilityRow } from "./CapabilityCard.tsx";
import { DeviceDetail, DeviceList } from "./DeviceList.tsx";
import { EndpointScopeSheet } from "./EndpointScopeSheet.tsx";
import { changeFor, type EndpointRow, requiresBiometric, type Scope, sensitive } from "./model.ts";
import { useEndpointPage } from "./use-endpoint-page.ts";

type Edit = { row: EndpointRow; peer: ReturnType<typeof useLinkState>["peer"]; enabled?: boolean };
function Page({
  computerId,
  after,
  endpointId,
  prev,
  next,
}: {
  computerId: string;
  after?: string;
  endpointId: string;
  prev?: () => void;
  next: (cursor: string) => void;
}) {
  const t = useText();
  const language = useLanguage();
  const runtime = useRuntime();
  const mobile = useLinkState();
  const page = useEndpointPage(computerId, after, endpointId);
  const [draft, setEdit] = useState<Edit>();
  const [uncertain, setUncertain] = useState(false);
  const { peer, status } = mobile;
  const action = useAction(status, peer);
  const edit = status === "online" && draft?.peer === peer ? draft : undefined;

  // biome-ignore lint/correctness/useExhaustiveDependencies: a dialog belongs to the original link generation.
  useEffect(() => setEdit(undefined), [peer, status]);

  function submit(current: Edit, scope: Scope) {
    void action.run(async (signal) => {
      const row = current.row;
      const stillOnline = () => {
        const snapshot = runtime.getSnapshot();
        return (
          peer &&
          snapshot.peer === peer &&
          snapshot.selectedId === computerId &&
          snapshot.status === "online"
        );
      };
      if (!stillOnline() || !page.writable) throw new Error("offline");
      // A desktop edit while the sheet was open must be reviewed before submitting.
      const latest = page.value?.items.find(
        (item) => item.endpointId === row.endpointId && item.capabilityId === row.capabilityId,
      );
      if (
        !latest ||
        latest.state !== row.state ||
        latest.version !== row.version ||
        JSON.stringify(latest.scope) !== JSON.stringify(row.scope)
      )
        throw new Error("approval_changed");
      const enabled = current.enabled ?? row.state !== "off";
      setEdit(undefined);
      if (requiresBiometric(row, enabled, scope))
        await confirmBiometrically(
          t("endpointsBiometricPrompt", { name: row.name[language] }),
          t("cancel"),
          signal,
        );
      signal.throwIfAborted();
      if (!stillOnline()) throw new Error("offline");
      setUncertain(true);
      try {
        await runtime.call("endpoints.capability.set", changeFor(row, enabled, scope), signal);
        if (!signal.aborted) setUncertain(false);
      } catch (error) {
        if (
          !signal.aborted &&
          error instanceof RpcError &&
          error.message === "endpoint_unavailable"
        ) {
          setUncertain(false);
          action.setError("endpointsUnavailable");
          return;
        }
        if (
          !signal.aborted &&
          error instanceof RpcError &&
          (error.code === RpcErrorCodes.invalidParams ||
            error.code === RpcErrorCodes.unsupported ||
            error.code === RpcErrorCodes.methodNotFound ||
            error.code === RpcErrorCodes.busy)
        )
          setUncertain(false);
        throw error;
      } finally {
        // Timeout/disconnect may have happened after a commit. Refresh the read, never the write.
        if (!signal.aborted) page.refresh();
      }
    });
  }

  const writable = page.writable && !action.busy;
  const close = () => setEdit(undefined);
  const items = page.value?.items ?? [];
  return (
    <View>
      {page.stale && <FootNote text={t("endpointsCached")} />}
      {!action.busy && uncertain && <ErrorLine text={t("endpointsUncertain")} />}
      <ErrorLine text={page.error && t(page.error)} />
      <ErrorLine text={action.error && t(action.error)} />
      {page.busy && !page.value && <FootNote text={t("loading")} />}
      {page.error && (
        <Button title={t("retry")} style={{ alignSelf: "center" }} onPress={page.refresh} />
      )}
      {page.value?.items.length === 0 && <EmptyState icon="puzzle" title={t("endpointsEmpty")} />}
      {items.length > 0 && (
        <>
          <SectionTitle title={t("capabilitiesSectionTitle")} />
          <ListCard>
            {items.map((row, index) => (
              <Fragment key={`${row.endpointId}:${row.capabilityId}`}>
                {index > 0 && <Separator />}
                <CapabilityRow
                  row={row}
                  writable={writable}
                  onToggle={(enabled) => setEdit({ row, peer, enabled })}
                  onScope={() => setEdit({ row, peer })}
                />
              </Fragment>
            ))}
          </ListCard>
          <FootNote
            text={[
              items.some(sensitive) ? t("endpointsBiometricHint") : "",
              t("endpointsPermissionsHint"),
            ]
              .filter(Boolean)
              .join("\n")}
          />
        </>
      )}
      {(prev || !!page.value?.nextAfter) && (
        <View style={{ flexDirection: "row", justifyContent: "center", padding: 8, gap: 8 }}>
          {prev && <Button title={t("endpointsPrev")} disabled={action.busy} onPress={prev} />}
          {!!page.value?.nextAfter && (
            <Button
              title={t("endpointsNext")}
              disabled={action.busy}
              onPress={() => {
                const cursor = page.value?.nextAfter;
                if (cursor) next(cursor);
              }}
            />
          )}
        </View>
      )}
      {edit && edit.enabled === undefined && (
        <EndpointScopeSheet
          row={edit.row}
          name={edit.row.name[language]}
          disabled={!writable}
          close={close}
          save={(scope) => submit(edit, scope)}
        />
      )}
      {edit && edit.enabled !== undefined && (
        <Sheet visible onClose={close}>
          <SheetTitle text={t("endpointsConfirm", { name: edit.row.name[language] })} />
          {edit.enabled && sensitive(edit.row) && <SheetText text={t("endpointsBiometricHint")} />}
          <Button
            size="lg"
            variant="prim"
            title={t(edit.enabled ? "endpointsEnable" : "endpointsDisable")}
            disabled={!writable}
            onPress={() => submit(edit, edit.row.scope)}
          />
          <Button size="lg" variant="ghost" title={t("cancel")} onPress={close} />
        </Sheet>
      )}
    </View>
  );
}

function CapabilityPages({ computerId, endpointId }: { computerId: string; endpointId: string }) {
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const after = cursors.at(-1);
  return (
    <Page
      key={after ?? ""}
      computerId={computerId}
      endpointId={endpointId}
      after={after}
      prev={cursors.length > 1 ? () => setCursors((all) => all.slice(0, -1)) : undefined}
      next={(cursor) => setCursors((all) => [...all, cursor])}
    />
  );
}

export function EndpointCapabilitiesScreen() {
  const router = useRouter(),
    colors = useColors(),
    t = useText(),
    mobile = useLinkState(),
    focused = useIsFocused();
  const params = useLocalSearchParams<{ device?: string; name?: string; runner?: string }>();
  const computerId = mobile.selectedId;
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      {!computerId ? (
        <>
          <NavBar title={t("endpointsTitle")} tint="teal" onBack={() => router.back()} />
          <EmptyState icon="laptop" title={t("phoneDataNoComputer")} />
        </>
      ) : params.device ? (
        <DeviceDetail
          key={`${computerId}:${params.device}`}
          computerId={computerId}
          deviceId={params.device}
          fallbackName={params.name ?? ""}
          runnerTarget={params.runner || undefined}
          focused={focused}
          renderCapabilities={(endpointId) => (
            <CapabilityPages computerId={computerId} endpointId={endpointId} />
          )}
        />
      ) : (
        <>
          <NavBar title={t("endpointsTitle")} tint="teal" onBack={() => router.back()} />
          {focused && <DeviceList key={computerId} />}
        </>
      )}
    </View>
  );
}
