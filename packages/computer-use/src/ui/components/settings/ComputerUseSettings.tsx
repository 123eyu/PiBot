import type { Bot } from "@pibot/computer-use-contract/full";
import {
  hostPlatform,
  SettingsHero,
  SettingsLine,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  useRpc,
  useT,
} from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useEffect, useState } from "react";
import styles from "../computer.module.css";
import { activeComputerState, computerErrorKey, computerStateText } from "../presentation.ts";
import { useComputerStates } from "../state-store.ts";
import { BlocklistSettings, ScreenshotRetention } from "./BlocklistSettings.tsx";
import { SystemPermissionRows } from "./SystemPermissions.tsx";

export const STOP_SHORTCUT = {
  darwin: "⌃⌥⌘.",
  other: "Ctrl+Alt+Shift+.",
} as const;
export function stopShortcut(platform: string) {
  return platform === "darwin" ? STOP_SHORTCUT.darwin : STOP_SHORTCUT.other;
}

/** Names for the "who is using it" rows; a failed read falls back to a generic label. */
function useBotNames() {
  const { peer } = useRpc();
  const [bots, setBots] = useState<Bot[]>([]);
  useEffect(() => {
    if (!peer) return;
    let active = true;
    peer
      .call("bots.list", undefined)
      .then((result) => {
        if (active) setBots(result);
      })
      .catch(() => {
        // Advisory only: rows still show "a Bot" and the stop button works by id.
      });
    return () => {
      active = false;
    };
  }, [peer]);
  return new Map(bots.map((bot) => [bot.id, bot.name]));
}

function InUse() {
  const t = useT();
  const { peer } = useRpc();
  const states = useComputerStates();
  const names = useBotNames();
  const [stopping, setStopping] = useState<string>();
  const [error, setError] = useState<ReturnType<typeof computerErrorKey>>();
  const active = [...states.values()].filter((state) => activeComputerState(state));
  const stop = async (botId: string) => {
    if (!peer || stopping) return;
    setStopping(botId);
    setError(undefined);
    try {
      await peer.call("computer.stop", { botId });
    } catch (e) {
      setError(computerErrorKey(e));
    } finally {
      setStopping(undefined);
    }
  };
  // Who is operating the computer is the page's hero card.
  return (
    <SettingsSection title={t("computerUse.settings.inUse")} bare>
      {active.map((state) => (
        <SettingsHero
          key={state.botId}
          icon="hand"
          title={t("computerUse.settings.botState", {
            name: names.get(state.botId) ?? t("computerUse.settings.someBot"),
            state: computerStateText(state, t),
          })}
          note={t("computerUse.settings.steps", { count: state.stepCount })}
        >
          <Button
            className={styles.stopButton}
            loading={stopping === state.botId}
            disabled={!peer || !!stopping}
            onClick={() => void stop(state.botId)}
          >
            {t("computerUse.settings.stop")}
          </Button>
        </SettingsHero>
      ))}
      {!active.length && <SettingsHero icon="hand" title={t("computerUse.settings.idle")} />}
      {error && (
        <SettingsLine role="alert" tone="danger">
          {t(error)}
        </SettingsLine>
      )}
    </SettingsSection>
  );
}

/**
 * Settings · Computer use: everything about Bots operating this computer, and nothing else
 * (the background service moved to Schedules & background; Bot browsers to each Bot's profile).
 */
export function ComputerUseSettings() {
  const t = useT();
  return (
    <SettingsPage>
      {/* Who is using the computer comes first. */}
      <InUse />
      <SystemPermissionRows />
      <SettingsSection title={t("computerUse.shortcut.title")}>
        <SettingsRow
          icon="bolt"
          tone="pink"
          label={t("computerUse.shortcut.label")}
          note={t("computerUse.shortcut.note")}
        >
          <kbd className={styles.kbd}>{stopShortcut(hostPlatform() ?? "unknown")}</kbd>
        </SettingsRow>
      </SettingsSection>
      <BlocklistSettings />
      <ScreenshotRetention />
    </SettingsPage>
  );
}
