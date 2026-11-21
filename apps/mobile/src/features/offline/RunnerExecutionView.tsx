import { approvalFactText } from "@pibot/client-core";
import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { useOffline, useOfflineEngine } from "../../offline/OfflineProvider.tsx";
import { useSharedText, useText } from "../../runtime/context.tsx";
import { confirmBiometrically } from "../../runtime/local-auth.ts";
import { monoFont, useColors } from "../../theme/use-theme.ts";
import { Button, ErrorLine, FootNote, ListCard } from "../../ui/controls.tsx";

export function RunnerExecutionView({ botId }: { botId: string }) {
  const offline = useOffline(),
    engine = useOfflineEngine(),
    t = useText(),
    shared = useSharedText(),
    colors = useColors();
  const owner = useRef<AbortController | undefined>(undefined);
  const [confirming, setConfirming] = useState(false);
  const [failed, setFailed] = useState(false);
  const card = offline.live?.botId === botId ? offline.runnerApproval : undefined;
  const output = offline.runnerOutput?.botId === botId ? offline.runnerOutput.text : undefined;
  const receipts = offline.topics[botId]?.runnerReceipts ?? [];
  // biome-ignore lint/correctness/useExhaustiveDependencies: each approval owns a fresh biometric cancellation scope.
  useEffect(() => {
    const controller = new AbortController();
    owner.current = controller;
    setConfirming(false);
    setFailed(false);
    return () => {
      controller.abort();
      if (owner.current === controller) owner.current = undefined;
    };
  }, [card?.id]);
  return (
    <View style={{ gap: 8 }}>
      {receipts.length > 0 && (
        <ListCard>
          <View style={{ padding: 12, gap: 6 }}>
            <FootNote text={t("offlineRunnerRecords")} />
            {receipts.map((entry) => (
              <View key={entry.clientId} style={{ gap: 2 }}>
                <Text style={{ color: colors.text, fontSize: 13 }}>
                  {entry.tool} ·{" "}
                  {t(
                    entry.outcome === "done"
                      ? "offlineRunnerDone"
                      : entry.outcome === "failed"
                        ? "offlineRunnerFailed"
                        : entry.outcome === "denied"
                          ? "offlineRunnerDenied"
                          : entry.outcome === "unknown"
                            ? "offlineRunnerUnknown"
                            : "offlineRunnerPending",
                  )}
                </Text>
                <FootNote text={entry.command ?? entry.change?.path ?? entry.path ?? entry.cwd} />
                {entry.commandResult && (
                  <FootNote
                    text={t("offlineRunnerExit", { code: entry.commandResult.exitCode ?? "—" })}
                  />
                )}
              </View>
            ))}
          </View>
        </ListCard>
      )}
      {card && (
        <ListCard>
          <View style={{ padding: 14, gap: 8 }}>
            <Text style={{ color: colors.text, fontSize: 16, fontWeight: "600" }}>
              {t("offlineRunnerConfirm")}
            </Text>
            <FootNote
              text={`${card.name}\n${card.cwd}\n${t(card.risk === "danger" ? "offlineRunnerDanger" : "offlineRunnerNormal")}`}
            />
            <Text selectable style={{ color: colors.text, fontFamily: monoFont, fontSize: 13 }}>
              {card.command ?? card.path}
            </Text>
            {[...new Set(card.facts.map((fact) => approvalFactText(fact, shared)))].map((fact) => (
              <FootNote key={fact} text={fact} />
            ))}
            <FootNote text={t("offlineRunnerOnceOnly")} />
            <ErrorLine text={failed ? t("offlineRunnerConfirmFailed") : undefined} />
            <Button
              title={t("offlineRunnerAllowOnce")}
              variant="prim"
              disabled={confirming}
              onPress={() => {
                const controller = owner.current;
                if (confirming || !controller || controller.signal.aborted) return;
                setConfirming(true);
                setFailed(false);
                const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]);
                void (async () => {
                  try {
                    if (card.risk === "danger")
                      await confirmBiometrically(t("offlineRunnerConfirm"), t("cancel"), signal);
                    engine.respondRunnerApproval(card.id, true);
                  } catch {
                    if (owner.current === controller && !controller.signal.aborted) setFailed(true);
                  } finally {
                    if (owner.current === controller && !controller.signal.aborted)
                      setConfirming(false);
                  }
                })();
              }}
            />
            <Button
              title={t("offlineRunnerDeny")}
              disabled={confirming}
              onPress={() => engine.respondRunnerApproval(card.id, false)}
            />
          </View>
        </ListCard>
      )}
      {output && (
        <ListCard>
          <View style={{ padding: 12, gap: 6 }}>
            <FootNote text={t("offlineRunnerOutput")} />
            <Text selectable style={{ color: colors.text, fontFamily: monoFont, fontSize: 12 }}>
              {output}
            </Text>
          </View>
        </ListCard>
      )}
    </View>
  );
}
