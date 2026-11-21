import { useEffect, useState } from "react";

/** A display preview must never own admission to the live UI after its first hand-off. */
export function useStartupCover(input: {
  connected: boolean;
  settled: boolean;
  leftChat: boolean;
  failed: boolean;
}) {
  const [attached, setAttached] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const done = input.settled || input.leftChat || input.failed;
  useEffect(() => {
    if (input.connected) setAttached(true);
  }, [input.connected]);
  useEffect(() => {
    if (done) setDismissed(true);
  }, [done]);
  useEffect(() => {
    if (!attached || dismissed) return;
    // The deadline survives a disconnect; repeated reconnects cannot extend a stale preview.
    const timer = setTimeout(() => setDismissed(true), 3000);
    return () => clearTimeout(timer);
  }, [attached, dismissed]);
  return !dismissed && !done;
}
