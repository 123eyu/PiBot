import { useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { usedOfflineModels } from "../../offline/engine.ts";
import { useOffline, useOfflineEngine } from "../../offline/OfflineProvider.tsx";
import { useMobile, useText } from "../../runtime/context.tsx";
import { useColors } from "../../theme/use-theme.ts";
import { EmptyState, FootNote, ListCard, SectionTitle, Separator } from "../../ui/controls.tsx";
import { NavBar } from "../../ui/headers.tsx";
import { useTimeText } from "../../ui/time.ts";
import { usePlanBots } from "./plan-bots.ts";

function Row({ title, hint }: { title: string; hint?: string }) {
  const colors = useColors();
  return (
    <View style={{ padding: 14 }}>
      <Text style={{ fontSize: 15, color: colors.text }}>{title}</Text>
      {!!hint && <Text style={{ fontSize: 12.5, color: colors.text2, marginTop: 2 }}>{hint}</Text>}
    </View>
  );
}

/**
 * Read-only. Which models the selected computer delivered to this phone, which Bots can
 * reply here while it is unreachable, and the phone's own privacy ledger of direct requests. All
 * changes are made on the computer (Devices page), so nothing here can grant anything.
 */
export function OfflineSettingsScreen() {
  const colors = useColors(),
    t = useText(),
    router = useRouter(),
    time = useTimeText(),
    mobile = useMobile(),
    offline = useOffline(),
    engine = useOfflineEngine();
  const computer = mobile.devices.find((d) => d.id === mobile.selectedId);
  const [held, setHeld] = useState<ReadonlySet<string>>(new Set());
  // Only the digest index is read: the keys themselves never reach a screen. Re-read on every
  // engine change (a sync may have delivered or cleared a key).
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision marks any engine change.
  useEffect(() => {
    if (!offline.computerId) return;
    let live = true;
    void engine.store
      .keyIndex(offline.computerId)
      .then((index) => live && setHeld(new Set(index.map((entry) => entry.grantId))))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [engine, offline.computerId, offline.revision]);
  const manifest = offline.manifest;
  // An older computer lists a router provider's whole catalog as
  // delivered (hundreds of rows); only the models the Bots answer with matter here, by provider.
  const delivered = useMemo(() => {
    const groups = new Map<string, NonNullable<typeof manifest>["models"]>();
    for (const model of usedOfflineModels(manifest))
      groups.set(model.providerName, [...(groups.get(model.providerName) ?? []), model]);
    return [...groups];
  }, [manifest]);
  // B8: the ledger stores the provider's id; its name comes from the manifest when still there.
  const providerNames = useMemo(
    () => new Map((manifest?.models ?? []).map((model) => [model.providerId, model.providerName])),
    [manifest],
  );
  const plan = usePlanBots(
    offline.computerId,
    (manifest?.bots ?? []).filter((bot) => bot.offline && !bot.grantId).map((bot) => bot.id),
  );
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <NavBar title={t("offlineTitle")} onBack={() => router.back()} />
      <ScrollView contentContainerStyle={{ paddingBottom: 32 }}>
        {!computer ? (
          <EmptyState icon="laptop" title={t("offlineNoComputer")} />
        ) : (
          <>
            <Text style={{ color: colors.text2, fontSize: 13, padding: 18, paddingBottom: 6 }}>
              {t("offlineLead")}
            </Text>
            {!manifest ? (
              <FootNote text={t("offlineNotSynced", { name: computer.name })} />
            ) : (
              <>
                <SectionTitle title={t("offlineModels")} />
                {!delivered.length && (
                  <ListCard>
                    <Row title={t("offlineNoModels")} />
                  </ListCard>
                )}
                {delivered.map(([provider, models]) => (
                  <View key={provider}>
                    <Text
                      style={{
                        color: colors.text2,
                        fontSize: 12.5,
                        paddingHorizontal: 18,
                        paddingVertical: 6,
                      }}
                    >
                      {provider}
                    </Text>
                    <ListCard>
                      {models.map((model, index) => (
                        <View key={model.grantId}>
                          {index > 0 && <Separator />}
                          <Row
                            title={model.modelName}
                            hint={t(
                              held.has(model.grantId) ? "offlineKeyHere" : "offlineKeyMissing",
                            )}
                          />
                        </View>
                      ))}
                    </ListCard>
                  </View>
                ))}
                <SectionTitle title={t("offlineBots")} />
                <ListCard>
                  {manifest.bots.map((bot, index) => (
                    <View key={bot.id}>
                      {index > 0 && <Separator />}
                      <Row
                        title={bot.name}
                        hint={t(
                          bot.kind === "agent"
                            ? "agentNeedsComputer"
                            : !bot.offline
                              ? "offlineBotOff"
                              : offline.ready.includes(bot.id)
                                ? "offlineBotReady"
                                : plan.has(bot.id)
                                  ? "offlineBotPlan"
                                  : "offlineBotNotReady",
                        )}
                      />
                    </View>
                  ))}
                </ListCard>
              </>
            )}
            {offline.waiting > 0 && (
              <FootNote text={t("offlineWaiting", { count: offline.waiting })} />
            )}
            <SectionTitle title={t("offlineLedger")} />
            <ListCard>
              {!offline.ledger.length && <Row title={t("offlineLedgerEmpty")} />}
              {offline.ledger.slice(0, 50).map((entry, index) => (
                <View key={entry.clientId}>
                  {index > 0 && <Separator />}
                  <Row
                    title={t("offlineLedgerRow", {
                      provider: providerNames.get(entry.providerId) ?? entry.providerId,
                      model: entry.modelId,
                      count: entry.messageCount,
                    })}
                    hint={`${manifest?.bots.find((b) => b.id === entry.botId)?.name ?? ""} · ${time.stamp(entry.at)}`}
                  />
                </View>
              ))}
            </ListCard>
            <FootNote text={t("offlineLedgerHint")} />
          </>
        )}
      </ScrollView>
    </View>
  );
}
