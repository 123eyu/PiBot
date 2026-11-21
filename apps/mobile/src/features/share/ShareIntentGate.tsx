import { useRootNavigationState, useRouter } from "expo-router";
import { useShareIntentContext } from "expo-share-intent";
import { useEffect } from "react";
import { useMobileSelector } from "../../runtime/context.tsx";

/** Opens the share screen when another app shares into Pi Bot, once paired. */
export function ShareIntentGate() {
  const share = useShareIntentContext(),
    mobile = useMobileSelector((s) => ({ ready: s.ready, devices: s.devices })),
    router = useRouter(),
    navigation = useRootNavigationState();
  useEffect(() => {
    if (navigation?.key && share.hasShareIntent && mobile.ready && mobile.devices.length)
      router.push("/share");
  }, [navigation?.key, share.hasShareIntent, mobile.ready, mobile.devices.length, router]);
  return null;
}
