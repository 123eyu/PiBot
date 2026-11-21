import { RpcError, RpcErrorCodes } from "@pibot/protocol";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { z } from "zod";
import type { MobileKey } from "../../i18n/messages.ts";
import { useLinkState, useRuntime, useText } from "../../runtime/context.tsx";
import { errorKey } from "../../runtime/errors.ts";
import { mono, radius, type } from "../../theme/scale.ts";
import { useColors } from "../../theme/use-theme.ts";
import { Banner, Button, EmptyState } from "../../ui/controls.tsx";
import { NavBar } from "../../ui/headers.tsx";
import { MAX_LOG_PAGES, moreRunLog, openRunLog, type RunLog } from "./log.ts";
import { useRecordPresent } from "./use-present.ts";

const ParamsSchema = z.object({ runId: z.uuid(), title: z.string().max(400).optional() });
const size = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${Math.round(bytes / 1024)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
function logError(cause: unknown): MobileKey {
  if (cause instanceof RpcError && cause.code === RpcErrorCodes.runLogMissing)
    return "recordLogMissing";
  if (cause instanceof Error && cause.message === "offline") return "recordLogNotCached";
  return errorKey(cause);
}
/**
 * A run's execution log, read-only: the computer's redacted view in frame-sized pages,
 * monospace, kept on the phone once opened so it reads offline too.
 */
export function RunLogScreen() {
  const params = ParamsSchema.safeParse(useLocalSearchParams());
  const router = useRouter(),
    t = useText(),
    colors = useColors();
  if (!params.success)
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <NavBar title={t("recordLog")} onBack={() => router.back()} />
        <EmptyState icon="terminal" title={t("stale")} />
      </View>
    );
  return <RunLogView runId={params.data.runId} title={params.data.title} />;
}
function RunLogView({ runId, title }: { runId: string; title?: string }) {
  const router = useRouter(),
    t = useText(),
    colors = useColors(),
    runtime = useRuntime(),
    mobile = useLinkState(),
    { context } = useRecordPresent();
  const online = mobile.status === "online";
  const computerId = mobile.selectedId;
  const [log, setLog] = useState<RunLog>();
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<MobileKey>();
  const [busy, setBusy] = useState(false);
  const owner = useRef<AbortController | undefined>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the run, computer and connection own the copy.
  useEffect(() => {
    if (!computerId) return;
    const abort = new AbortController();
    owner.current = abort;
    setBusy(true);
    setError(undefined);
    openRunLog(runtime, runtime.storage.files, { computerId, runId, online }, abort.signal)
      .then((result) => {
        if (abort.signal.aborted) return;
        setLog(result.log);
        setStale(result.stale);
      })
      .catch((cause: unknown) => {
        if (!abort.signal.aborted && !(mobile.status === "connecting" && !log))
          setError(logError(cause));
      })
      .finally(() => {
        if (!abort.signal.aborted) setBusy(false);
      });
    return () => abort.abort();
  }, [runId, computerId, online]);
  const more = async () => {
    const abort = owner.current;
    if (!log || !computerId || !abort || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const next = await moreRunLog(
        runtime,
        runtime.storage.files,
        { computerId, runId, log },
        abort.signal,
      );
      if (!abort.signal.aborted) setLog(next);
    } catch (cause) {
      if (!abort.signal.aborted) setError(logError(cause));
    } finally {
      if (!abort.signal.aborted) setBusy(false);
    }
  };
  // Offsets count bytes of the computer's redacted view; the end of it is the whole log.
  const read = log ? (log.nextOffset ?? log.totalBytes) : 0;
  const empty = !!log && log.pages.every((page) => !page);
  const atLimit = !!log && log.nextOffset !== null && log.pages.length >= MAX_LOG_PAGES;
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <NavBar
        title={t("recordLog")}
        subtitle={
          log ? t("recordLogSize", { size: size(log.totalBytes), read: size(read) }) : title
        }
        onBack={() => router.back()}
      />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 32 }}>
        {(stale || (!online && !!log)) && <Banner text={t("recordLogOffline")} />}
        {!!error && (
          <Banner tone={error === "recordLogMissing" ? "plain" : "danger"} text={t(error)} />
        )}
        {busy && !log && (
          <Text style={[type.caption, { color: colors.text2 }]}>
            {context.shared("common.loading")}
          </Text>
        )}
        {empty && (
          <Text style={[type.caption, { color: colors.text2 }]}>{context.shared("log.empty")}</Text>
        )}
        {!!log && !empty && (
          <View
            style={{
              borderRadius: radius.code,
              borderWidth: 1,
              borderColor: colors.b2,
              backgroundColor: colors.card,
              paddingVertical: 10,
              paddingHorizontal: 12,
            }}
          >
            {log.pages.map((page, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: pages only ever append.
              <Text key={index} selectable style={[mono(12), { color: colors.text }]}>
                {page}
              </Text>
            ))}
          </View>
        )}
        {!!log && log.nextOffset !== null && !atLimit && (
          <Button
            title={context.shared("log.more")}
            style={{ alignSelf: "center" }}
            disabled={!online || busy}
            onPress={() => void more()}
          />
        )}
        {atLimit && (
          <Text style={[type.caption, { color: colors.text2 }]}>{t("recordLogLimit")}</Text>
        )}
        {!!log?.truncated && log.nextOffset === null && (
          <Text style={[type.caption, { color: colors.text2 }]}>
            {context.shared("log.truncated")}
          </Text>
        )}
      </ScrollView>
    </View>
  );
}
