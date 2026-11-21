import { ActivityIndicator, Image, Pressable, ScrollView, Text, View } from "react-native";
import { useRuntime, useText } from "../../runtime/context.tsx";
import { radius, type } from "../../theme/scale.ts";
import { useColors } from "../../theme/use-theme.ts";
import type { PendingFile } from "../../transport/link-port.ts";
import { Icon } from "../../ui/icons.tsx";
import { sizeText } from "../files/Attachments.tsx";

const THUMB = 56;

/** One prepared file: a thumbnail for an image, name and size for a file. */
export function LocalFileChip({
  file,
  onRemove,
  compact,
}: {
  file: PendingFile;
  onRemove?: () => void;
  /** Pending bubbles: no remove button, a little smaller. */
  compact?: boolean;
}) {
  const colors = useColors(),
    t = useText(),
    runtime = useRuntime();
  const uri = runtime.storage.share?.uri?.(file.blob);
  const size = compact ? 48 : THUMB;
  const body =
    file.kind === "image" ? (
      <View
        accessibilityLabel={t("fileImage", { name: file.name })}
        style={{
          width: size,
          height: size,
          borderRadius: radius.row,
          overflow: "hidden",
          borderWidth: 1,
          borderColor: colors.b1,
          backgroundColor: colors.tert,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {uri ? (
          <Image source={{ uri }} resizeMode="cover" style={{ width: "100%", height: "100%" }} />
        ) : (
          <Icon name="image" color={colors.text2} size={20} />
        )}
      </View>
    ) : (
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          height: size,
          maxWidth: 200,
          paddingLeft: 10,
          paddingRight: onRemove ? 26 : 10,
          borderRadius: radius.row,
          borderWidth: 1,
          borderColor: colors.b2,
          backgroundColor: colors.card,
        }}
      >
        <Icon name="file" color={colors.text2} size={18} />
        <View style={{ flexShrink: 1 }}>
          <Text numberOfLines={1} style={{ fontSize: 13.5, color: colors.text }}>
            {file.name}
          </Text>
          <Text style={[type.small, { color: colors.text2 }]}>{sizeText(file.bytes)}</Text>
        </View>
      </View>
    );
  if (!onRemove) return body;
  return (
    <View>
      {body}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("attachRemove", { name: file.name })}
        onPress={onRemove}
        hitSlop={8}
        style={({ pressed }) => ({
          position: "absolute",
          top: 4,
          right: 4,
          width: 20,
          height: 20,
          borderRadius: 10,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: pressed ? colors.text : colors.text2,
        })}
      >
        <Icon name="close" color={colors.bg} size={12} strokeWidth={2.2} />
      </Pressable>
    </View>
  );
}
/** The composer's attached files above the input, with a remove button on each. */
export function AttachmentTray({
  files,
  preparing,
  hint,
  disabled,
  onRemove,
}: {
  files: readonly PendingFile[];
  preparing: boolean;
  /** A one-line note under the chips (a reply is running). */
  hint?: string;
  disabled?: boolean;
  onRemove: (blob: string) => void;
}) {
  const colors = useColors(),
    t = useText();
  if (!files.length && !preparing) return null;
  return (
    <View style={{ marginBottom: 8, gap: 6 }}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ gap: 8, alignItems: "center" }}
      >
        {files.map((file) => (
          <LocalFileChip
            key={file.blob}
            file={file}
            onRemove={disabled ? undefined : () => onRemove(file.blob)}
          />
        ))}
        {preparing && (
          <View
            accessibilityLabel={t("attachPreparing")}
            style={{
              width: THUMB,
              height: THUMB,
              borderRadius: radius.row,
              borderWidth: 1,
              borderColor: colors.b2,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <ActivityIndicator color={colors.text2} />
          </View>
        )}
      </ScrollView>
      {!!hint && <Text style={[type.small, { color: colors.text2 }]}>{hint}</Text>}
    </View>
  );
}
