import type {
  HostParams,
  HostResults,
  RoutineControlSchema,
  RoutineDevControl,
} from "@pibot/protocol";
import type { z } from "zod";

/**
 * What routines need from the desktop main process: keep-awake leases, the tray, the
 * background state and the stream of power/focus controls. It used to be `BrainHost.routines` in
 * the kernel; it now belongs to the capability, and the composition root passes it to
 * `routinesCapability`. A brain without a desktop (server, CLI) simply has no adapter.
 */
export interface RoutineHostAdapter {
  keepAwake(
    params: HostParams["host.keepAwake"],
    signal: AbortSignal,
  ): Promise<HostResults["host.keepAwake"]>;
  updateTray(params: HostParams["tray.update"], signal: AbortSignal): Promise<void>;
  backgroundState(signal: AbortSignal): Promise<HostResults["host.backgroundState"]>;
  onControl(listener: (input: z.infer<typeof RoutineControlSchema>) => Promise<void>): () => void;
  onDevControl?(listener: (input: RoutineDevControl) => Promise<void>): () => void;
}
