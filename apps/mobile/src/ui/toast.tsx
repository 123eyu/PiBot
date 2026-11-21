import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { Text, View } from "react-native";
import { useColors } from "../theme/use-theme.ts";
import { useTabBarInset } from "./tab-bar.tsx";

const Context = createContext<(text: string) => void>(() => undefined);
export function useToast() {
  return useContext(Context);
}
/** One short status line at a time near the bottom; it never carries an action. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const colors = useColors(),
    // Clear of the floating tab bar, which every tab page draws over its content.
    bottom = useTabBarInset();
  const [text, setText] = useState<string>();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const show = useCallback((value: string) => {
    clearTimeout(timer.current);
    setText(value);
    timer.current = setTimeout(() => setText(undefined), 1800);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <Context.Provider value={show}>
      {children}
      {text && (
        <View
          pointerEvents="none"
          style={{ position: "absolute", left: 0, right: 0, bottom, alignItems: "center" }}
        >
          <Text
            accessibilityRole="alert"
            accessibilityLiveRegion="polite"
            style={{
              backgroundColor: colors.prim,
              color: colors.onPrim,
              paddingVertical: 9,
              paddingHorizontal: 16,
              borderRadius: 999,
              overflow: "hidden",
              fontSize: 14,
              maxWidth: "86%",
            }}
          >
            {text}
          </Text>
        </View>
      )}
    </Context.Provider>
  );
}
