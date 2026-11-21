import { useEffect, useRef } from "react";
import { Animated, Easing, Image, Text, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { useDisplay } from "../theme/display.tsx";
import { useReducedMotion } from "../theme/motion.ts";
import { avatarColor, useColors } from "../theme/use-theme.ts";
import { Icon } from "./icons.tsx";

// Same shapes, eye anchors and states as packages/ui/src/components/Avatar.tsx (desktop).
const shapes: Record<string, [d: string, ey: number, ex: number]> = {
  blob: ["M50 6 C80 6 94 20 94 50 C94 80 80 94 50 94 C20 94 6 80 6 50 C6 20 20 6 50 6 Z", 42, 13],
  pill: [
    "M50 6 C72 6 82 20 82 40 V62 C82 82 70 94 50 94 C30 94 18 82 18 62 V40 C18 20 28 6 50 6 Z",
    40,
    12,
  ],
  drop: [
    "M50 6 C64 26 88 44 88 64 C88 84 72 94 50 94 C28 94 12 84 12 64 C12 44 36 26 50 6 Z",
    60,
    13,
  ],
  pebble: [
    "M30 14 C46 4 78 6 88 26 C98 46 92 76 74 88 C56 98 22 94 12 76 C2 58 12 26 30 14 Z",
    44,
    14,
  ],
  flower: [
    "M50 6 A20 20 0 0 1 72 28 A20 20 0 0 1 94 50 A20 20 0 0 1 72 72 A20 20 0 0 1 50 94 A20 20 0 0 1 28 72 A20 20 0 0 1 6 50 A20 20 0 0 1 28 28 A20 20 0 0 1 50 6 Z",
    46,
    12,
  ],
  cloud: [
    "M28 84 C14 84 6 74 6 62 C6 50 15 42 26 42 C27 26 38 16 52 16 C66 16 76 26 78 38 C88 38 94 48 94 60 C94 74 84 84 72 84 Z",
    54,
    14,
  ],
  ghost: [
    "M14 50 C14 24 30 8 50 8 C70 8 86 24 86 50 V90 L76 82 L66 90 L56 82 L50 88 L44 82 L34 90 L24 82 L14 90 Z",
    42,
    13,
  ],
  cat: [
    "M14 30 L22 6 L40 22 H60 L78 6 L86 30 C92 44 92 60 88 72 C82 88 68 94 50 94 C32 94 18 88 12 72 C8 60 8 44 14 30 Z",
    52,
    14,
  ],
  hex: ["M50 6 L88 28 V72 L50 94 L12 72 V28 Z", 46, 13],
  circle: ["M50 6 A44 44 0 1 1 49.9 6 Z", 44, 14],
  bean: [
    "M10 46 C10 26 26 16 48 16 C72 16 92 24 92 46 C92 68 74 84 50 84 C26 84 10 66 10 46 Z",
    40,
    14,
  ],
  tri: [
    "M22 10 C30 6 40 8 48 14 L88 46 C96 52 96 62 88 68 L36 92 C26 96 14 90 14 78 L12 24 C12 18 16 12 22 10 Z",
    44,
    12,
  ],
};
export interface AvatarLook {
  name: string;
  shape: string;
  color: string;
  eyes: string;
  /** A PNG data URL (an external agent's logo, an uploaded picture): drawn instead of the shape. */
  image?: string;
}
export type AvatarState = "idle" | "thinking" | "working" | "waiting" | "blocked" | "done";
const eyeShift: Partial<Record<AvatarState, [number, number]>> = {
  thinking: [0, -5],
  working: [5, 1],
  waiting: [0, 2],
};
function eyePaths(eyes: string, state: AvatarState, ey: number, ex: number) {
  const [dx, dy] = eyeShift[state] ?? [0, 0];
  let fill = "";
  let stroke = "";
  let width = 7;
  for (const [i, x] of [50 - ex, 50 + ex].entries()) {
    if (state === "blocked") {
      width = 6;
      stroke += `M${x - 5} ${ey - 5} L${x + 5} ${ey + 5} M${x + 5} ${ey - 5} L${x - 5} ${ey + 5} `;
    } else if (state === "done") {
      width = 6;
      stroke += `M${x - 6} ${ey + 3} Q${x} ${ey - 7} ${x + 6} ${ey + 3} `;
    } else if (eyes === "marks") {
      const tilt = i === 0 ? -2 : 2;
      stroke += `M${x + tilt + dx} ${ey - 7 + dy} L${x - tilt + dx} ${ey + 5 + dy} `;
    } else if (eyes === "sleepy") {
      width = 5;
      stroke += `M${x - 6 + dx} ${ey + dy} Q${x + dx} ${ey + 5 + dy} ${x + 6 + dx} ${ey + dy} `;
    } else if (eyes === "pixel") fill += `M${x - 4.5 + dx} ${ey - 4.5 + dy} h9 v9 h-9 Z `;
    else {
      const [rx, ry] = eyes === "oval" ? [4.5, 7] : [5.5, 5.5];
      fill += `M${x - rx + dx} ${ey + dy} a${rx} ${ry} 0 1 0 ${2 * rx} 0 a${rx} ${ry} 0 1 0 ${-2 * rx} 0 Z `;
    }
  }
  return { fill, stroke, width };
}
// Desktop keyframes: thinking bobs up 8%, working sways ±5°, waiting wiggles once every 3.2 s.
const motions = {
  thinking: { duration: 1600, input: [0, 0.5, 1], output: [0, -0.08, 0] },
  working: { duration: 1100, input: [0, 0.5, 1], output: [-5, 5, -5] },
  waiting: {
    duration: 3200,
    input: [0, 0.06, 0.12, 0.18, 0.24, 0.3, 0.4, 1],
    output: [0, -12, 10, -8, 6, -3, 0, 0],
  },
} as const;
/** The state motion of an avatar; idle, blocked and done stand still (no blink on the phone). */
function useMotion(state: AvatarState, size: number) {
  const reduced = useReducedMotion();
  const progress = useRef(new Animated.Value(0)).current;
  const motion = reduced ? undefined : motions[state as keyof typeof motions];
  useEffect(() => {
    if (!motion) return;
    progress.setValue(0);
    const loop = Animated.loop(
      Animated.timing(progress, {
        toValue: 1,
        duration: motion.duration,
        easing: Easing.inOut(Easing.ease),
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [motion, progress]);
  if (!motion) return undefined;
  if (state === "thinking")
    return {
      transform: [
        {
          translateY: progress.interpolate({
            inputRange: [...motion.input],
            outputRange: motion.output.map((v) => v * size),
          }),
        },
      ],
    };
  return {
    transform: [
      {
        rotate: progress.interpolate({
          inputRange: [...motion.input],
          outputRange: motion.output.map((v) => `${v}deg`),
        }),
      },
    ],
  };
}
export function BotAvatar({
  bot,
  size = 44,
  state = "idle",
}: {
  bot: AvatarLook;
  size?: number;
  state?: AvatarState;
}) {
  const colors = useColors(),
    { scheme } = useDisplay();
  const [d, ey, ex] = shapes[bot.shape] ?? (shapes.blob as [string, number, number]);
  const fill = avatarColor(colors, bot.color);
  // Phone 2026-11-14: the ink body is the dark page colour, so only its eyes showed in dark
  // mode. A thin light ring outlines it there; every other colour reads on both pages.
  const ring = scheme === "dark" && bot.color === "ink" ? colors.text2 : undefined;
  const eye = bot.color === "gray" ? colors["avatar-eye-gray"] : colors["avatar-eye"];
  const eyes = eyePaths(bot.eyes, state, ey, ex);
  const motion = useMotion(state, size);
  if (bot.image)
    return (
      <Animated.View
        style={[
          { width: size, height: size, transformOrigin: "50% 80%" },
          state === "blocked" && { opacity: 0.6 },
          motion,
        ]}
      >
        <Image
          source={{ uri: bot.image }}
          accessibilityLabel={bot.name}
          style={{ width: size, height: size, borderRadius: size * 0.28 }}
        />
      </Animated.View>
    );
  return (
    <Animated.View
      style={[
        { width: size, height: size, transformOrigin: "50% 80%" },
        // RN has no grayscale filter on iOS; a blocked Bot is dimmed instead of desaturated.
        state === "blocked" && { opacity: 0.6 },
        motion,
      ]}
    >
      <Svg width={size} height={size} viewBox="0 0 100 100" accessibilityLabel={bot.name}>
        {ring && <Path d={d} fill="none" stroke={ring} strokeWidth={12} strokeLinejoin="round" />}
        <Path d={d} fill={fill} stroke={fill} strokeWidth={6} strokeLinejoin="round" />
        {!!eyes.fill && <Path d={eyes.fill} fill={eye} />}
        {!!eyes.stroke && (
          <Path
            d={eyes.stroke}
            fill="none"
            stroke={eye}
            strokeWidth={eyes.width}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
      </Svg>
    </Animated.View>
  );
}
/**
 * Desktop GroupAvatar: members at 59% in the corners (two on the diagonal, three as two up and
 * one centred); more than four show three and a "+N" disc. No tile behind them.
 */
export function GroupAvatar({ members, size = 44 }: { members: AvatarLook[]; size?: number }) {
  const colors = useColors();
  const count = Math.min(members.length, 4);
  const shown = members.slice(0, members.length > 4 ? 3 : 4);
  const cell = count === 1 ? size : Math.round(size * 0.59);
  const corner = (slot: number) => {
    if (slot === 0) return { top: 0, left: 0 };
    if (slot === 1) return count === 2 ? { bottom: 0, right: 0 } : { top: 0, right: 0 };
    if (slot === 2)
      return count === 3 ? { bottom: 0, left: (size - cell) / 2 } : { bottom: 0, left: 0 };
    return { bottom: 0, right: 0 };
  };
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ width: size, height: size }}
    >
      {shown
        .map((member, slot) => ({ member, slot, id: `${slot}:${member.name}` }))
        .map(({ member, slot, id }) => (
          <View key={id} style={{ position: "absolute", ...corner(slot) }}>
            <BotAvatar bot={member} size={cell} />
          </View>
        ))}
      {members.length > 4 && (
        <View
          style={{
            position: "absolute",
            ...corner(3),
            width: cell,
            height: cell,
            borderRadius: cell / 2,
            borderWidth: 1,
            borderColor: colors.b2,
            backgroundColor: colors.tert,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text
            style={{
              fontSize: Math.max(9, Math.round(size * 0.22)),
              fontWeight: "600",
              color: colors.text2,
            }}
          >
            +{members.length - shown.length}
          </Text>
        </View>
      )}
    </View>
  );
}
/** The main Bot's violet star at the avatar's lower right, ringed in the page colour. */
export function MainBadge({ label }: { label?: string }) {
  const colors = useColors();
  return (
    <View
      accessible={!!label}
      accessibilityRole={label ? "image" : undefined}
      accessibilityLabel={label}
      style={{
        position: "absolute",
        right: -2,
        bottom: -2,
        width: 20,
        height: 20,
        borderRadius: 10,
        borderWidth: 2,
        borderColor: colors.bg,
        backgroundColor: colors.brand,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Icon name="star" color={colors["avatar-eye"]} size={10} strokeWidth={2} />
    </View>
  );
}
