import { usePreventRemove } from "expo-router";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { useText } from "../runtime/context.tsx";
import { Button } from "./controls.tsx";
import { Sheet, SheetText, SheetTitle } from "./sheet.tsx";

/**
 * Asks before a page with unsent or unsaved text is left, however it is left: the bar's back
 * button, Android's back gesture or key, the iOS edge swipe (the native stack holds the swipe while
 * removal is prevented) or a navigation that would remove the page. Without it a back gesture
 * silently dropped a typed message, because drafts live in the page's own state.
 */
export function LeaveGuard({
  dirty,
  title,
  text,
}: {
  dirty: boolean;
  title: string;
  text: string;
}) {
  const t = useText();
  const [leave, setLeave] = useState<() => void>();
  // Cleared together with `repeat`, so the hook and its prop agree while the page goes away.
  const [released, setReleased] = useState(false);
  usePreventRemove(dirty && !released, ({ repeat }) => setLeave(() => repeat));
  useEffect(() => {
    // Replay only after the navigation hook has committed the released guard.
    if (!released || !leave) return;
    setLeave(undefined);
    leave();
  }, [released, leave]);
  return (
    <Sheet visible={!!leave} onClose={() => setLeave(undefined)}>
      <SheetTitle text={title} />
      <SheetText text={text} />
      <View style={{ gap: 8 }}>
        <Button
          size="lg"
          variant="danger"
          title={t("leaveDiscard")}
          onPress={() => {
            setReleased(true);
          }}
        />
        <Button
          size="lg"
          variant="ghost"
          title={t("leaveKeep")}
          onPress={() => setLeave(undefined)}
        />
      </View>
    </Sheet>
  );
}
