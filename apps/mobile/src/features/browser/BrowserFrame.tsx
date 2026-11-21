import { useMemo, useRef, useState } from "react";
import { Image, PanResponder, View } from "react-native";
import { useColors } from "../../theme/use-theme.ts";
import type { ShownFrame } from "./use-bot-browser.ts";

/** Movement under this many points is a tap, not a scroll. */
const TAP_SLOP = 8;

/**
 * The live frame, fitted into the available box. While taken over a tap becomes a click at the
 * same spot of the page (sent as a fraction of the frame; the computer maps it to the page) and
 * a drag scrolls the page by the distance dragged, in page pixels.
 */
export function BrowserFrame({
  frame,
  interactive,
  onTap,
  onScroll,
}: {
  frame: ShownFrame;
  interactive: boolean;
  onTap(x: number, y: number): void;
  onScroll(x: number, y: number, deltaX: number, deltaY: number): void;
}) {
  const colors = useColors();
  const [box, setBox] = useState({ width: 0, height: 0 });
  const scale = Math.min(box.width / frame.width, box.height / frame.height) || 0;
  const drawn = { width: frame.width * scale, height: frame.height * scale };
  // The responder is created once; it reads the latest values through this ref.
  const latest = useRef({ drawn, frame, interactive, onTap, onScroll });
  latest.current = { drawn, frame, interactive, onTap, onScroll };
  const start = useRef({ x: 0, y: 0 });
  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => latest.current.interactive,
        onMoveShouldSetPanResponder: () => latest.current.interactive,
        onPanResponderGrant: (event) => {
          start.current = { x: event.nativeEvent.locationX, y: event.nativeEvent.locationY };
        },
        onPanResponderRelease: (_event, gesture) => {
          const { drawn, frame, onTap, onScroll } = latest.current;
          if (!(drawn.width > 0 && drawn.height > 0)) return;
          const clamp = (value: number) => Math.max(0, Math.min(1, value));
          const x = clamp(start.current.x / drawn.width);
          const y = clamp(start.current.y / drawn.height);
          if (Math.abs(gesture.dx) < TAP_SLOP && Math.abs(gesture.dy) < TAP_SLOP) {
            onTap(x, y);
            return;
          }
          // Dragging up moves the page content up, as on a touch screen.
          const limit = (value: number) => Math.max(-5000, Math.min(5000, Math.round(value)));
          onScroll(
            x,
            y,
            limit((-gesture.dx * frame.width) / drawn.width),
            limit((-gesture.dy * frame.height) / drawn.height),
          );
        },
      }),
    [],
  );
  return (
    <View
      style={{ flex: 1, alignItems: "center", justifyContent: "center" }}
      onLayout={(event) => {
        const { width, height } = event.nativeEvent.layout;
        setBox({ width, height });
      }}
    >
      {scale > 0 && (
        <View
          {...responder.panHandlers}
          style={{
            width: drawn.width,
            height: drawn.height,
            borderRadius: 12,
            overflow: "hidden",
            backgroundColor: colors.card,
          }}
        >
          <Image
            source={{ uri: frame.uri }}
            // Each frame replaces the last; a cross-fade would only blur the page.
            fadeDuration={0}
            resizeMode="stretch"
            accessibilityIgnoresInvertColors
            style={{ width: "100%", height: "100%" }}
          />
          {/* Drawn over the image so touch coordinates stay those of the frame itself. */}
          <View
            pointerEvents="none"
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              borderRadius: 12,
              // Amber while taken over: taps land on the computer (desktop takeover frame).
              borderWidth: interactive ? 2 : 1,
              borderColor: interactive ? colors.warn : colors.b2,
            }}
          />
        </View>
      )}
    </View>
  );
}
