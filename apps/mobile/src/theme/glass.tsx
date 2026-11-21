import { BlurTargetView, BlurView } from "expo-blur";
import {
  type ComponentRef,
  createContext,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Platform, type StyleProp, StyleSheet, View, type ViewStyle } from "react-native";
import { useDisplay } from "./display.tsx";
import { useReducedTransparency } from "./motion.ts";
import { GlassSheen } from "./page-wash.tsx";
import { useColors } from "./use-theme.ts";

type Target = RefObject<ComponentRef<typeof View> | null>;
interface Scope {
  targets: ReadonlyMap<string, Target>;
  register: (key: string, ref: Target) => () => void;
}
const ScopeContext = createContext<Scope | null>(null);

/**
 * Android blurs only what sits inside an expo-blur BlurTargetView, and the glass itself must stay
 * outside it. A scope collects the pages' targets by key (a tab's route name), so a bar outside
 * the pages blurs whichever page is in front. iOS blurs whatever is behind and ignores targets.
 */
export function GlassScope({ children }: { children: ReactNode }) {
  const [targets, setTargets] = useState<ReadonlyMap<string, Target>>(new Map());
  const register = useCallback((key: string, ref: Target) => {
    setTargets((current) => new Map(current).set(key, ref));
    return () =>
      setTargets((current) => {
        if (current.get(key) !== ref) return current;
        const next = new Map(current);
        next.delete(key);
        return next;
      });
  }, []);
  const value = useMemo(() => ({ targets, register }), [targets, register]);
  return <ScopeContext.Provider value={value}>{children}</ScopeContext.Provider>;
}
export function useGlassTarget(key: string): Target | undefined {
  return useContext(ScopeContext)?.targets.get(key);
}
/** Content a glass bar of the same scope may blur. */
export function BlurTarget({
  name,
  children,
  style,
}: {
  name: string;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const ref = useRef<ComponentRef<typeof View>>(null);
  const register = useContext(ScopeContext)?.register;
  useEffect(() => register?.(name, ref), [register, name]);
  return (
    <BlurTargetView ref={ref} style={[{ flex: 1 }, style]}>
      {children}
    </BlurTargetView>
  );
}
/**
 * Whether this device draws real blur: iOS always, Android from 12 (API 31) where RenderEffect
 * keeps it cheap, and never under iOS "reduce transparency". Elsewhere glass is the opaque card.
 */
function useCanBlur(target: Target | undefined) {
  const reduced = useReducedTransparency();
  if (reduced) return false;
  if (Platform.OS === "ios") return true;
  return Platform.OS === "android" && Number(Platform.Version) >= 31 && !!target;
}
/**
 * The glass pane: blur, a translucent fill, a bright rim and a sheen on the top edge, over the
 * soft shadow. Content may scroll under it.
 */
export function Glass({
  children,
  radius,
  target,
  style,
  innerStyle,
}: {
  children: ReactNode;
  radius: number;
  target?: Target;
  style?: StyleProp<ViewStyle>;
  innerStyle?: StyleProp<ViewStyle>;
}) {
  const colors = useColors(),
    { scheme } = useDisplay();
  const blur = useCanBlur(target);
  return (
    <View style={[{ borderRadius: radius, boxShadow: colors["shadow-soft"] }, style]}>
      <View
        style={[
          {
            flex: 1,
            borderRadius: radius,
            overflow: "hidden",
            borderWidth: 1,
            borderColor: blur ? colors["glass-edge"] : colors.b1,
            backgroundColor: blur ? "transparent" : colors.card,
          },
          innerStyle,
        ]}
      >
        {blur && (
          <>
            <BlurView
              tint={scheme}
              intensity={40}
              blurMethod="dimezisBlurViewSdk31Plus"
              blurTarget={target}
              style={StyleSheet.absoluteFill}
            />
            <View
              pointerEvents="none"
              style={[StyleSheet.absoluteFill, { backgroundColor: colors.glass }]}
            />
            <GlassSheen color={colors["glass-sheen"]} />
          </>
        )}
        {children}
      </View>
    </View>
  );
}
