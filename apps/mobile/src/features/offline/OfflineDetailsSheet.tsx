import { Text } from "react-native";
import { useText } from "../../runtime/context.tsx";
import { useColors } from "../../theme/use-theme.ts";
import { Button } from "../../ui/controls.tsx";
import { Sheet, SheetText, SheetTitle } from "../../ui/sheet.tsx";

export function OfflineDetailsSheet({
  visible,
  can,
  wait,
  runner,
  onClose,
}: {
  visible: boolean;
  can?: string;
  wait?: string;
  runner?: string;
  onClose: () => void;
}) {
  const t = useText();
  const colors = useColors();
  return (
    <Sheet visible={visible} onClose={onClose}>
      <SheetTitle text={t("offlineDetails")} />
      {(
        [
          ["offlineDetailsCan", can],
          ["offlineDetailsWait", wait],
          ["offlineDetailsRunner", runner],
        ] as const
      ).map(
        ([title, text]) =>
          text && <Section key={title} title={t(title)} text={text} color={colors.text} />,
      )}
      <Button size="lg" title={t("close")} onPress={onClose} />
    </Sheet>
  );
}

function Section({ title, text, color }: { title: string; text: string; color: string }) {
  return (
    <>
      <Text accessibilityRole="header" style={{ color, fontWeight: "600" }}>
        {title}
      </Text>
      <SheetText text={text} />
    </>
  );
}
