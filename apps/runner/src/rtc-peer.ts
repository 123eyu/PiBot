import type { RtcPeerFactory } from "@pibot/link";
import { createNativeRunnerRtcFactory } from "./rtc-native.ts";
import { createProcessRtcFactory } from "./rtc-process.ts";

export function createRunnerRtcFactory(warn?: (code: string) => void): {
  createPeer: RtcPeerFactory;
  close(): Promise<void>;
} {
  return process.platform === "win32"
    ? createProcessRtcFactory(warn)
    : createNativeRunnerRtcFactory();
}
