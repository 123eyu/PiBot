import { ScrollView } from "react-native";
import { useText } from "../../runtime/context.tsx";
import { useColors } from "../../theme/use-theme.ts";
import { Chip } from "../../ui/controls.tsx";

export type StripSheet = "folder" | "plan" | "tasks" | "changes" | "yolo";
/**
 * The desktop chat strip under the header: folder, plan progress (a DM's todo plan, a group's
 * task plan), the Bot browser while it has pages on the computer, changes and YOLO.
 */
export function ControlStrip({
  folder,
  plan,
  tasks,
  changes,
  yolo,
  open,
  browser,
}: {
  folder: string;
  plan?: { done: number; total: number };
  /** A group's current plan: passed steps of all steps, and whether one waits for the user. */
  tasks?: { done: number; total: number; attention: boolean };
  changes: number;
  yolo: boolean;
  open: (sheet: StripSheet) => void;
  browser?: { takeover: boolean; onPress: () => void };
}) {
  const colors = useColors(),
    t = useText();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={{ flexGrow: 0, borderBottomWidth: 1, borderBottomColor: colors.b1 }}
      contentContainerStyle={{ gap: 6, paddingVertical: 8, paddingHorizontal: 12 }}
    >
      <Chip icon="folder" trailing="chevron" label={folder} onPress={() => open("folder")} />
      {plan && plan.total > 0 && (
        <Chip icon="audit" label={t("planChip", plan)} onPress={() => open("plan")} />
      )}
      {tasks && tasks.total > 0 && (
        // Amber while a step waits for the user, so it reads as needing attention.
        <Chip
          icon="menu"
          hot={tasks.attention}
          label={t("gpChip", { done: tasks.done, total: tasks.total })}
          onPress={() => open("tasks")}
        />
      )}
      {browser && (
        // Blue while the Bot drives it; amber once someone has taken it over.
        <Chip
          icon="globe"
          live={!browser.takeover}
          hot={browser.takeover}
          label={t("browserChip")}
          onPress={browser.onPress}
        />
      )}
      <Chip
        icon="file"
        label={changes ? t("changesChipCount", { count: changes }) : t("changesChip")}
        onPress={() => open("changes")}
      />
      <Chip
        hot={yolo}
        label={t(yolo ? "yoloOnChip" : "yoloOffChip")}
        onPress={() => open("yolo")}
      />
    </ScrollView>
  );
}
