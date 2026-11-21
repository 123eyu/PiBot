import { streamPortable } from "@pibot/agent/portable";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import { useRuntime } from "../runtime/context.tsx";
import type { MobileRuntime } from "../runtime/runtime.ts";
import { OfflineEngine } from "./engine.ts";
import { runnerConnection } from "./runner-connection.ts";
import type { OfflineCall } from "./sync.ts";
import { nativeVault } from "./vault-native.ts";

const Context = createContext<OfflineEngine | null>(null);
const call =
  (runtime: MobileRuntime): OfflineCall =>
  (method, params, signal, timeoutMs) =>
    runtime.call(method, params, signal, timeoutMs);

/** One offline engine per app runtime; it syncs while online and replies while offline. */
export function OfflineProvider({ children }: { children: ReactNode }) {
  const runtime = useRuntime();
  // One engine per runtime, created before the first render so the app never blinks without it.
  const [engine] = useState(
    () =>
      new OfflineEngine({
        host: {
          getSnapshot: runtime.getSnapshot,
          subscribe: runtime.subscribe,
          call: call(runtime),
          updateBot: async (botId, providerId, modelId, signal) => {
            await runtime.call(
              "bots.update",
              { botId, modelProvider: providerId, modelId },
              signal,
            );
          },
          getBot: async (botId, signal) =>
            (await runtime.call("bots.profile", { botId }, signal)).bot,
        },
        data: runtime.storage.data,
        vault: nativeVault,
        runnerConnection: runnerConnection(runtime.storage, nativeVault),
        phone: runtime.phone,
        stream: streamPortable,
      }),
  );
  useEffect(() => {
    engine.start();
    return () => {
      void engine.stop();
    };
  }, [engine]);
  return <Context.Provider value={engine}>{children}</Context.Provider>;
}
export function useOfflineEngine() {
  const engine = useContext(Context);
  if (!engine) throw new Error("offline_engine_unavailable");
  return engine;
}
export function useOffline() {
  const engine = useOfflineEngine();
  return useSyncExternalStore(engine.subscribe, engine.getSnapshot, engine.getSnapshot);
}
