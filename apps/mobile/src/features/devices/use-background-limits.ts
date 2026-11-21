import { useEffect, useState } from "react";
import { AppState, Platform } from "react-native";
import { pibotAndroid } from "../../../modules/pibot-android/index.ts";

type Limits = { restricted: boolean; optimized: boolean };

/**
 * Android battery limits that cut the background link ("Restricted" freezes the app at once).
 * Read again whenever the app returns, since the fix happens in system Settings.
 */
export function useBackgroundLimits() {
  const [limits, setLimits] = useState<Limits>();
  useEffect(() => {
    const android = Platform.OS === "android" ? pibotAndroid : null;
    if (!android) return;
    let alive = true;
    const read = () =>
      void android
        .backgroundLimits()
        .then((value) => {
          if (alive) setLimits(value);
        })
        .catch(() => {
          // A build without the module function shows no notice rather than a guess.
        });
    read();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") read();
    });
    return () => {
      alive = false;
      subscription.remove();
    };
  }, []);
  return {
    notice: limits?.restricted ? "restricted" : limits?.optimized ? "optimized" : undefined,
    open: () =>
      void pibotAndroid?.openBatterySettings().catch(() => {
        /* No settings page to open: the notice text still says where to look. */
      }),
  } as const;
}
