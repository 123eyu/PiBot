import * as Clipboard from "expo-clipboard";
import { createContext, type ReactNode, useCallback, useContext, useState } from "react";
import { Text, View } from "react-native";
import { useText } from "../runtime/context.tsx";
import { monoFont, useColors } from "../theme/use-theme.ts";
import { Button } from "./controls.tsx";
import { Sheet, SheetText, SheetTitle } from "./sheet.tsx";
import { useToast } from "./toast.tsx";

const Context = createContext<(url: string) => void>(() => undefined);
export const useShowLink = () => useContext(Context);

/**
 * The phone never opens web pages. A tapped link shows its full address (which may
 * differ from the link text) with a copy button; nothing is handed to the phone's browser.
 */
export function LinkSheetProvider({ children }: { children: ReactNode }) {
  const t = useText(),
    colors = useColors(),
    toast = useToast();
  const [url, setUrl] = useState<string>();
  // Every Markdown bubble reads this: a new function per render re-rendered all of them.
  const show = useCallback((next: string) => setUrl(next.slice(0, 4096)), []);
  const copy = async () => {
    if (!url) return;
    try {
      await Clipboard.setStringAsync(url);
      setUrl(undefined);
      toast(t("linkCopied"));
    } catch {
      // The clipboard can refuse (e.g. a locked device profile); the address stays selectable.
      toast(t("failed"));
    }
  };
  return (
    <Context.Provider value={show}>
      {children}
      <Sheet visible={!!url} onClose={() => setUrl(undefined)}>
        <SheetTitle text={t("linkTitle")} />
        <SheetText text={t("linkHint")} />
        <View
          style={{
            borderRadius: 16,
            backgroundColor: colors.card,
            borderWidth: 1,
            borderColor: colors.b2,
            paddingVertical: 14,
            paddingHorizontal: 16,
          }}
        >
          <Text selectable style={{ fontFamily: monoFont, fontSize: 14, color: colors.text }}>
            {url}
          </Text>
        </View>
        <Button
          size="lg"
          variant="prim"
          icon="copy"
          title={t("linkCopy")}
          onPress={() => void copy()}
        />
        <Button size="lg" title={t("close")} onPress={() => setUrl(undefined)} />
      </Sheet>
    </Context.Provider>
  );
}
