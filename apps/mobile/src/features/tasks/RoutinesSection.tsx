import { isIndefinitePause } from "@pibot/protocol";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Text, View } from "react-native";
import { useText } from "../../runtime/context.tsx";
import { useColors } from "../../theme/use-theme.ts";
import { Button, ListCard, SectionTitle, Separator } from "../../ui/controls.tsx";
import { OptionRow, Sheet, SheetTitle } from "../../ui/sheet.tsx";
import { useTimeText } from "../../ui/time.ts";
import { latestByRoutine, type TaskCenter } from "./pages.ts";
import { RoutineRow, Rows } from "./TaskRows.tsx";
import type { PauseLength, useTasks } from "./use-tasks.ts";

type Act = (
  work: Promise<unknown>,
  message: "pausedAllToast" | "resumedAllToast" | "ranNowToast",
) => Promise<void>;
const lengths: [PauseLength, "pauseHour" | "pauseDay" | "pauseWeek"][] = [
  ["hour", "pauseHour"],
  ["day", "pauseDay"],
  ["week", "pauseWeek"],
];
/** Routines: latest run per routine, run now, and pause/resume all (single toggles stay on the computer). */
export function RoutinesSection({
  center,
  tasks,
  disabled,
  act,
}: {
  center: TaskCenter | undefined;
  tasks: ReturnType<typeof useTasks>;
  disabled: boolean;
  act: Act;
}) {
  const router = useRouter();
  const colors = useColors(),
    t = useText(),
    time = useTimeText();
  const [pausing, setPausing] = useState(false);
  const paused = !!center?.pausedUntil && Date.parse(center.pausedUntil) > Date.now();
  const pause = async (length: PauseLength) => {
    setPausing(false);
    await act(tasks.pause(length), "pausedAllToast");
  };
  return (
    <>
      <SectionTitle
        title={t("sectionRoutines")}
        right={
          <Button
            icon={paused ? "play" : "pause"}
            title={t(paused ? "resumeAll" : "pauseAll")}
            disabled={disabled}
            onPress={() =>
              paused ? void act(tasks.resume(), "resumedAllToast") : setPausing(true)
            }
          />
        }
      />
      {paused && center?.pausedUntil && (
        <Text
          style={{ paddingHorizontal: 20, paddingBottom: 8, fontSize: 12.5, color: colors.warn }}
        >
          {isIndefinitePause(center.pausedUntil)
            ? t("pausedIndefinitely")
            : t("pausedUntil", {
                time: `${time.list(center.pausedUntil)} ${time.clock(center.pausedUntil)}`,
              })}
        </Text>
      )}
      <Rows
        rows={latestByRoutine(center?.routines ?? [])}
        empty={t("noRoutines")}
        keyOf={(run) => run.id}
        render={(run) => (
          <RoutineRow
            run={run}
            disabled={disabled || paused}
            onRunNow={() => run.routineId && void act(tasks.runNow(run.routineId), "ranNowToast")}
            onOpen={() =>
              router.push({
                pathname: "/task/[kind]/[id]",
                params: { kind: "routine", id: run.id },
              })
            }
          />
        )}
      />
      <Text
        style={{
          paddingHorizontal: 20,
          paddingTop: 8,
          fontSize: 12.5,
          lineHeight: 19,
          color: colors.text2,
        }}
      >
        {t("routineDesktop")}
      </Text>
      <Sheet visible={pausing} onClose={() => setPausing(false)}>
        <SheetTitle text={t("pauseTitle")} />
        <ListCard flush>
          {lengths.map(([length, label], index) => (
            <View key={length}>
              {index > 0 && <Separator />}
              <OptionRow title={t(label)} disabled={disabled} onPress={() => void pause(length)} />
            </View>
          ))}
        </ListCard>
        <Button size="lg" variant="ghost" title={t("cancel")} onPress={() => setPausing(false)} />
      </Sheet>
    </>
  );
}
