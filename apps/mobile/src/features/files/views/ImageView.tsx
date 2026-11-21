import { useState } from "react";
import { Image, ScrollView, useWindowDimensions } from "react-native";
import { useText } from "../../../runtime/context.tsx";
import { useColors } from "../../../theme/use-theme.ts";

/** A cached image file, fitted to the width; pinch to zoom where the platform supports it. */
export function ImageView({ uri, name }: { uri: string; name: string }) {
  const t = useText(),
    colors = useColors(),
    window = useWindowDimensions();
  const [ratio, setRatio] = useState(1);
  const width = window.width - 32;
  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: 16, alignItems: "center" }}
      maximumZoomScale={4}
      minimumZoomScale={1}
      centerContent
    >
      <Image
        accessibilityLabel={t("fileImage", { name })}
        source={{ uri }}
        resizeMode="contain"
        onLoad={(event) => {
          const { width: w, height: h } = event.nativeEvent.source;
          if (w > 0 && h > 0) setRatio(w / h);
        }}
        style={{
          width,
          height: width / ratio,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: colors.b1,
        }}
      />
    </ScrollView>
  );
}
