import { useState } from "react";
import { useMobile, useRuntime } from "../../runtime/context.tsx";
import { useAction } from "../../runtime/use-action.ts";

export function useDevices() {
  const runtime = useRuntime(),
    mobile = useMobile(),
    action = useAction(mobile.selectedId, mobile.peer);
  const [removing, setRemoving] = useState<string>();
  return {
    ...mobile,
    action,
    removing,
    setRemoving,
    select: (id: string) => action.run(() => runtime.select(id)),
    canKeepConnected: runtime.canKeepConnected(),
    setKeepConnected: (on: boolean) => action.run(() => runtime.setKeepConnected(on)),
    forget: () =>
      action.run(async () => {
        if (!removing) return;
        try {
          await runtime.forget(removing);
        } catch {
          throw new Error("forget_failed");
        }
        setRemoving(undefined);
      }),
  };
}
