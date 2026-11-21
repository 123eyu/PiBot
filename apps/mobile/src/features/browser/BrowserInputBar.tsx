import { useState } from "react";
import { Pressable, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useText } from "../../runtime/context.tsx";
import { useColors } from "../../theme/use-theme.ts";
import { Button } from "../../ui/controls.tsx";
import { Icon } from "../../ui/icons.tsx";
import type { BotBrowserView } from "./use-bot-browser.ts";

const TEXT_MAX = 1000;

/**
 * Typing into the page during a takeover. Text goes to whatever field is focused on the computer
 * (tap it in the frame first). Password mode uses the system's secure entry; in either mode the
 * text lives only in this field until sent, never in storage, history or logs.
 */
export function BrowserInputBar({ browser }: { browser: BotBrowserView }) {
  const colors = useColors(),
    t = useText(),
    insets = useSafeAreaInsets();
  const [text, setText] = useState("");
  const [secure, setSecure] = useState(false);
  const busy = browser.input.busy;
  const send = async () => {
    const value = text;
    if (!value || busy) return;
    if ((await browser.type(value)) !== undefined) setText("");
  };
  return (
    <View
      style={{
        gap: 8,
        paddingTop: 8,
        paddingHorizontal: 12,
        paddingBottom: Math.max(insets.bottom, 8),
        backgroundColor: colors.bg,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Pressable
          accessibilityRole="switch"
          accessibilityLabel={t("browserSecure")}
          accessibilityState={{ checked: secure }}
          onPress={() => {
            // Switching modes never carries typed text across.
            setText("");
            setSecure((value) => !value);
          }}
          style={{
            width: 38,
            height: 38,
            borderRadius: 19,
            alignItems: "center",
            justifyContent: "center",
            borderWidth: 1,
            borderColor: secure ? colors.accentBg : colors.b2,
            backgroundColor: secure ? colors.accentBg : colors.card,
          }}
        >
          <Icon name="lock" color={secure ? colors.accent : colors.text2} size={18} />
        </Pressable>
        <TextInput
          // A remount drops anything the platform keeps for the old field.
          key={secure ? "secure" : "plain"}
          value={text}
          onChangeText={setText}
          maxLength={TEXT_MAX}
          secureTextEntry={secure}
          autoCorrect={false}
          autoCapitalize="none"
          autoComplete="off"
          importantForAutofill="no"
          textContentType={secure ? "password" : "none"}
          contextMenuHidden={secure}
          placeholder={t(secure ? "browserTypeSecure" : "browserType")}
          placeholderTextColor={colors.text2}
          accessibilityLabel={t(secure ? "browserTypeSecure" : "browserType")}
          returnKeyType="send"
          onSubmitEditing={() => void send()}
          style={{
            flex: 1,
            height: 44,
            borderRadius: 22,
            borderWidth: 1,
            borderColor: colors.b2,
            paddingHorizontal: 16,
            backgroundColor: colors.card,
            color: colors.text,
            fontSize: 16,
          }}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("browserSendText")}
          accessibilityState={{ disabled: !text || busy }}
          disabled={!text || busy}
          onPress={() => void send()}
          style={{
            width: 38,
            height: 38,
            borderRadius: 19,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: colors.prim,
            opacity: !text || busy ? 0.35 : 1,
          }}
        >
          <Icon name="up" color={colors.onPrim} size={18} strokeWidth={2} />
        </Pressable>
      </View>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Button
          icon="keyboard"
          title={t("browserEnter")}
          disabled={busy}
          onPress={() => void browser.key("Enter")}
        />
        <Button
          size="small"
          title={t("browserDelete")}
          disabled={busy}
          onPress={() => void browser.key("Backspace")}
        />
        <Button
          size="small"
          title={t("browserTab")}
          disabled={busy}
          onPress={() => void browser.key("Tab")}
        />
      </View>
    </View>
  );
}
