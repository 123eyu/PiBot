import { forwardCard } from "@pibot/client-core";
import type { MessageForward } from "@pibot/protocol";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useLanguage, useSharedText } from "../../../runtime/context.tsx";
import { type } from "../../../theme/scale.ts";
import { useColors } from "../../../theme/use-theme.ts";
import { Icon } from "../../../ui/icons.tsx";
import { MessageMarkdown } from "../../../ui/markdown.tsx";

/**
 * FORWARD-DISPLAY: the collapsed record under a forwarded message, built by the same client-core
 * presenter as the desktop. Forwarded messages stay plain text (untrusted); only the handoff
 * summary uses the reply Markdown renderer (no raw HTML, no images, links shown not opened).
 */
export function ForwardCard({ forward }: { forward: MessageForward }) {
  const colors = useColors(),
    t = useSharedText(),
    language = useLanguage();
  const [open, setOpen] = useState(false);
  const card = forwardCard(forward, t, (at) =>
    new Date(at).toLocaleString(language, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }),
  );
  return (
    <View
      style={{
        alignSelf: "flex-end",
        maxWidth: "80%",
        borderWidth: 1,
        borderColor: colors.b1,
        borderRadius: 12,
        backgroundColor: colors.card,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${card.title} · ${t(open ? "messages.forwardedCollapse" : "messages.forwardedExpand")}`}
        onPress={() => setOpen((value) => !value)}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          paddingVertical: 8,
          paddingHorizontal: 12,
        }}
      >
        <Icon name="arrow" color={colors.text2} size={14} />
        <Text numberOfLines={1} style={[type.small, { flexShrink: 1, color: colors.text2 }]}>
          {card.title}
        </Text>
        <Icon name={open ? "chevron" : "chevronRight"} color={colors.text2} size={14} />
      </Pressable>
      {open && (
        <View
          style={{
            gap: 10,
            paddingHorizontal: 12,
            paddingBottom: 12,
            paddingTop: 8,
            borderTopWidth: 1,
            borderTopColor: colors.b1,
          }}
        >
          {card.items.map((item) => (
            <View key={item.key} style={{ gap: 2 }}>
              <Text style={[type.small, { color: colors.text2 }]}>
                <Text style={{ color: colors.text, fontWeight: "600" }}>{item.sender}</Text>
                {`  ${item.time}`}
              </Text>
              {!!item.quote && (
                <Text
                  numberOfLines={3}
                  style={[
                    type.small,
                    {
                      color: colors.text2,
                      borderLeftWidth: 2,
                      borderLeftColor: colors.b3,
                      paddingLeft: 8,
                    },
                  ]}
                >
                  {item.quote}
                </Text>
              )}
              {!!item.body && <Text style={[type.body, { color: colors.text }]}>{item.body}</Text>}
            </View>
          ))}
          {!!card.truncatedNote && (
            <Text style={[type.small, { color: colors.text2 }]}>{card.truncatedNote}</Text>
          )}
          {!!card.summary && (
            <View style={{ gap: 6, paddingTop: 8, borderTopWidth: 1, borderTopColor: colors.b1 }}>
              <Text style={[type.small, { color: colors.text2, fontWeight: "600" }]}>
                {card.summaryLabel}
              </Text>
              <View style={{ backgroundColor: colors.tert, borderRadius: 10, padding: 10 }}>
                <MessageMarkdown text={card.summary} color={colors.text} />
              </View>
            </View>
          )}
        </View>
      )}
    </View>
  );
}
