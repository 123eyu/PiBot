import type { SocketConstructor } from "@pibot/link";
import Constants from "expo-constants";
import { getRandomBytes } from "expo-crypto";
import { AppState, Platform } from "react-native";
import { nativeMedia } from "../features/phone-data/media-native.ts";
import { nativeReadPages } from "../features/phone-data/read-pages-native.ts";
import { nativeSms } from "../features/phone-data/sms-native.ts";
import { nativeShareFiles } from "../features/share/share-files-native.ts";
import { openLocalData, secretData } from "../storage/native.ts";
import { nativeBlobFiles } from "../storage/native-files.ts";
import { MobileStorage } from "../storage/state.ts";
import { discoverLan } from "../transport/lan-discovery.ts";
import { createMobileLink } from "../transport/real-link.ts";
import { nativeLinkService } from "./link-service-native.ts";
import { MobileRuntime } from "./runtime.ts";

/** Process entry owner: headless notification and UI share one runtime and one database writer. */
function createOwner() {
  let current: Promise<MobileRuntime> | undefined;
  let refs = 0;
  let closing: Promise<void> = Promise.resolve();
  return {
    async acquire(language: () => "zh" | "en") {
      refs++;
      current ??= closing.then(async () => {
        const data = await openLocalData();
        const runtime = new MobileRuntime(
          new MobileStorage(data, secretData, nativeBlobFiles, nativeShareFiles),
          createMobileLink({
            WebSocket: globalThis.WebSocket as unknown as SocketConstructor,
            random: getRandomBytes,
            discoverLan,
          }),
          undefined,
          {
            appVersion: Constants.expoConfig?.version ?? "unknown",
            platform: Platform.OS === "ios" ? "ios" : "android",
            media: nativeMedia,
            ...(nativeReadPages ? { readPages: nativeReadPages } : {}),
            ...(nativeSms ? { sms: nativeSms } : {}),
          },
          nativeLinkService(language),
        );
        try {
          runtime.setLanguage(language());
          await runtime.setForeground(AppState.currentState === "active");
          await runtime.initialize();
          return runtime;
        } catch (error) {
          await runtime.dispose();
          throw error;
        }
      });
      try {
        return await current;
      } catch (error) {
        refs--;
        current = undefined;
        throw error;
      }
    },
    async release() {
      if (--refs > 0) return;
      const old = current;
      current = undefined;
      closing = (async () => {
        const runtime = await old;
        await runtime?.dispose();
      })();
      await closing;
    },
  };
}
// Shared only at the mobile process composition root; business services receive the runtime.
export const mobileOwner = createOwner();
