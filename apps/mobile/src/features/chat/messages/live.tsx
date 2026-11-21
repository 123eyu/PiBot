import { type LiveRunActivity, runActivityText } from "@pibot/client-core";
import { useEffect, useId, useRef, useState } from "react";
import { Animated, StyleSheet, Text, View } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { useSharedText, useText } from "../../../runtime/context.tsx";
import { useReducedMotion } from "../../../theme/motion.ts";
import { usePageTint } from "../../../theme/page-tint.tsx";
import { type } from "../../../theme/scale.ts";
import { tintOf, withAlpha } from "../../../theme/tint.ts";
import { useColors } from "../../../theme/use-theme.ts";

/**
 * The user's bubble is a gradient in the Bot's colour. The deepened fill keeps white text
 * readable; the bright avatar colour rises toward the lower right, at most a third.
 */
export function BubbleGradient({ wash }: { wash: string }) {
  const id = `bubble${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  return (
    <Svg style={StyleSheet.absoluteFill} width="100%" height="100%" pointerEvents="none">
      <Defs>
        <LinearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor={wash} stopOpacity={0} />
          <Stop offset="1" stopColor={wash} stopOpacity={0.32} />
        </LinearGradient>
      </Defs>
      <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${id})`} />
    </Svg>
  );
}
/** Three dots taking turns; still (all half-lit) under the system "reduce motion" setting. */
export function Dots({ color, size = 5 }: { color: string; size?: number }) {
  const reduced = useReducedMotion();
  const progress = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    progress.setValue(0);
    if (reduced) return;
    const loop = Animated.loop(
      Animated.timing(progress, { toValue: 1, duration: 1200, useNativeDriver: true }),
    );
    loop.start();
    return () => loop.stop();
  }, [reduced, progress]);
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ flexDirection: "row", alignItems: "center", gap: 3 }}
    >
      {[0, 1, 2].map((index) => {
        // Each dot peaks a sixth of the cycle after the one before (the sketch's 0.2 s delays).
        const peak = 0.15 + index * 0.17;
        const input = [0, peak - 0.15, peak, peak + 0.15, 1];
        return (
          <Animated.View
            key={index}
            style={{
              width: size,
              height: size,
              borderRadius: size / 2,
              backgroundColor: color,
              opacity: reduced
                ? 0.6
                : progress.interpolate({
                    inputRange: input,
                    outputRange: [0.25, 0.25, 1, 0.25, 0.25],
                  }),
              transform: reduced
                ? []
                : [
                    {
                      translateY: progress.interpolate({
                        inputRange: input,
                        outputRange: [0, 0, -2, 0, 0],
                      }),
                    },
                  ],
            }}
          />
        );
      })}
    </View>
  );
}
/** A soft capsule in the page colour: dots, then what the run is doing and for how long. */
function LivePill({ text, label }: { text: string; label?: string }) {
  const colors = useColors(),
    tone = tintOf(colors, usePageTint());
  return (
    <View
      accessible
      accessibilityLabel={label ?? text}
      accessibilityLiveRegion="polite"
      style={{
        flexDirection: "row",
        alignItems: "center",
        alignSelf: "flex-start",
        gap: 6,
        paddingVertical: 4,
        paddingHorizontal: 10,
        borderRadius: 999,
        backgroundColor: withAlpha(tone.wash, 0.12),
      }}
    >
      <Dots color={tone.ink} />
      {!!text && (
        <Text style={[type.small, { color: tone.ink, fontVariant: ["tabular-nums"] }]}>{text}</Text>
      )}
    </View>
  );
}
/** Before the first words arrive: the capsule alone ("typing"). */
export function TypingPill() {
  const t = useText();
  return <LivePill text="" label={t("typing")} />;
}
/** While a reply streams: what the run is doing right now, with its seconds. */
export function RunActivityPill({ activity }: { activity: LiveRunActivity }) {
  const t = useText(),
    shared = useSharedText();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <LivePill
      text={runActivityText(activity, now, shared, {
        waiting: (seconds) => t("activityWaiting", { seconds }),
        preparing: (tool, characters, seconds) =>
          t("activityPreparing", { tool, characters, seconds }),
        executing: (tool, seconds) => t("activityExecuting", { tool, seconds }),
        generatingImage: (seconds) => t("activityGeneratingImage", { seconds }),
      })}
    />
  );
}
