import { Redirect } from "expo-router";
import { useMobileSelector } from "../src/runtime/context.tsx";

// Decide the first screen declaratively: an imperative replace from the root layout could run
// before the navigator mounted and was dropped in release builds, leaving an unpaired phone on
// the tabs with no way to pair.
export default function Index() {
  const mobile = useMobileSelector((s) => ({ ready: s.ready, devices: s.devices }));
  if (!mobile.ready) return null;
  return <Redirect href={mobile.devices.length ? "/(tabs)/chat" : "/pair"} />;
}
