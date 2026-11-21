import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { z } from "zod";
import { useLinkState, useRuntime, useText } from "../../runtime/context.tsx";
import { type } from "../../theme/scale.ts";
import { useColors } from "../../theme/use-theme.ts";
import { BotAvatar } from "../../ui/avatar.tsx";
import {
  Banner,
  EmptyState,
  FootNote,
  ListCard,
  SectionTitle,
  Separator,
} from "../../ui/controls.tsx";
import { NavBar } from "../../ui/headers.tsx";
import { Icon } from "../../ui/icons.tsx";
import { OptionRow } from "../../ui/sheet.tsx";
import { useTimeText } from "../../ui/time.ts";
import { useToast } from "../../ui/toast.tsx";
import { listTopics } from "../chat/controls/calls.ts";
import { useConversations } from "../conversations/conversations-context.tsx";
import { logRunId, type RecordRow } from "./model.ts";
import { presentRecord, recordFacts } from "./present.ts";
import { Outcome } from "./RecordRows.tsx";
import { useRecords } from "./records-context.tsx";
import { resolveRecordTarget } from "./target.ts";
import { useRecordPresent } from "./use-present.ts";

const ParamsSchema = z.object({ id: z.string().min(1).max(200) });
const CachedTopicsSchema = z.object({ topics: z.array(z.object({ id: z.string() })).max(50) });

/** One record, read-only: facts, the run's log, and the chat it came from. */
export function RecordDetailScreen() {
  const params = ParamsSchema.safeParse(useLocalSearchParams());
  const router = useRouter(),
    t = useText(),
    colors = useColors(),
    records = useRecords();
  const row = params.success ? records.rows.find((item) => item.id === params.data.id) : undefined;
  if (!row)
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <NavBar title={t("recordDetail")} onBack={() => router.back()} />
        {records.loaded && <EmptyState icon="audit" title={t("stale")} />}
      </View>
    );
  return <RecordDetail row={row} />;
}
function RecordDetail({ row }: { row: RecordRow }) {
  const router = useRouter(),
    t = useText(),
    colors = useColors(),
    time = useTimeText(),
    toast = useToast(),
    runtime = useRuntime(),
    mobile = useLinkState(),
    conversations = useConversations(),
    records = useRecords(),
    { context } = useRecordPresent();
  const view = presentRecord(row, context);
  // Same label and value twice says nothing new (the desktop dedupes the same way).
  const facts = [
    ...new Map(
      recordFacts(row, view, context, time).map((fact) => [`${fact.label}:${fact.value}`, fact]),
    ).entries(),
  ];
  const runId = logRunId(row);
  const online = mobile.status === "online";
  const [opening, setOpening] = useState(false);
  const owner = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => owner.current?.abort(), []);
  const openChat = async () => {
    const computerId = mobile.selectedId;
    if (opening || !computerId) return;
    const abort = new AbortController();
    owner.current = abort;
    setOpening(true);
    try {
      const result = await resolveRecordTarget(
        row,
        {
          c: runtime,
          online,
          rows: records.rows,
          exists: (kind, id) => !!conversations.find(kind, id),
          topics: async (kind, id, signal) => {
            if (online)
              return (await listTopics(runtime, kind, id, signal)).map((topic) => topic.id);
            const cached = CachedTopicsSchema.safeParse(
              await runtime.storage.data.get(`cache:${computerId}:topics:${kind}:${id}`),
            );
            return cached.success ? cached.data.topics.map((topic) => topic.id) : undefined;
          },
        },
        AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]),
      );
      if (abort.signal.aborted) return;
      if ("notice" in result) toast(t(result.notice));
      else
        router.push({
          pathname: "/conversation/[kind]/[id]",
          params: {
            kind: result.target.kind,
            id: result.target.id,
            ...(result.target.topic ? { topic: result.target.topic } : {}),
            ...(result.target.focus ? { focus: result.target.focus } : {}),
          },
        });
    } catch {
      if (!abort.signal.aborted) toast(t(online ? "recordChatGone" : "recordOpenOffline"));
    } finally {
      if (!abort.signal.aborted) setOpening(false);
    }
  };
  const summary =
    row.type === "routine"
      ? row.run.summary || context.shared("activity.routineNoSummary")
      : row.type === "audit"
        ? view.what
        : undefined;
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <NavBar title={t("recordDetail")} subtitle={view.badge} onBack={() => router.back()} />
      <ScrollView contentContainerStyle={{ paddingBottom: 24 }}>
        <View
          style={{
            flexDirection: "row",
            gap: 12,
            alignItems: "center",
            padding: 16,
            paddingBottom: 12,
          }}
        >
          {view.look && <BotAvatar bot={view.look} size={44} state="idle" />}
          <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
            <Text
              selectable
              style={{ fontSize: 17, lineHeight: 23, fontWeight: "600", color: colors.text }}
            >
              {view.what}
            </Text>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <Outcome outcome={view.outcome} />
              <Text style={[type.caption, { color: colors.text2 }]}>
                {[view.who, time.stamp(row.at)].join(" · ")}
              </Text>
            </View>
          </View>
        </View>
        {row.type === "routine" && !!row.run.attentionReason && (
          <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
            <Banner tone="warn" icon="warning" text={row.run.attentionReason} />
          </View>
        )}
        {row.type === "routine" && !!summary && (
          <Text
            selectable
            style={[type.body, { color: colors.text, paddingHorizontal: 20, paddingBottom: 4 }]}
          >
            {summary}
          </Text>
        )}
        <SectionTitle title={t("recordFacts")} />
        <ListCard>
          {facts.length ? (
            facts.map(([key, fact], index) => (
              <View key={key}>
                {index > 0 && <Separator />}
                <View style={{ paddingVertical: 10, paddingHorizontal: 16, gap: 2 }}>
                  <Text style={[type.caption, { color: colors.text2 }]}>{fact.label}</Text>
                  <Text selectable style={[type.rowValue, { color: colors.text }]}>
                    {fact.value}
                  </Text>
                </View>
              </View>
            ))
          ) : (
            <Text style={[type.caption, { color: colors.text2, padding: 16 }]}>
              {context.shared("activity.noFacts")}
            </Text>
          )}
        </ListCard>
        <View style={{ paddingTop: 16 }}>
          <ListCard>
            <OptionRow
              title={context.shared(
                row.type === "routine" ? "activity.routineOpenChat" : "activity.openChat",
              )}
              subtitle={opening ? t("recordOpening") : undefined}
              lead={<Icon name="message" color={colors.text} size={18} />}
              right={<Icon name="chevronRight" color={colors.text2} size={16} />}
              disabled={opening}
              onPress={() => void openChat()}
            />
            {!!runId && (
              <>
                <Separator />
                <OptionRow
                  title={t("recordLog")}
                  lead={<Icon name="terminal" color={colors.text} size={18} />}
                  right={<Icon name="chevronRight" color={colors.text2} size={16} />}
                  onPress={() =>
                    router.push({ pathname: "/run-log", params: { runId, title: view.what } })
                  }
                />
              </>
            )}
          </ListCard>
        </View>
        <FootNote text={t("recordsFoot")} />
      </ScrollView>
    </View>
  );
}
