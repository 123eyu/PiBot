import type { LoginStep, ProviderAuthState } from "@pibot/models-contract/full";
import { type Peer, useRpc } from "@pibot/renderer-kit";
import { useEffect, useRef, useState } from "react";
import { createOAuthProgress } from "./oauth-progress.ts";

/**
 * Live state of a Sign in with ChatGPT attempt. Events win over RPC replies that arrive later.
 * Leaving the page, or this effect re-running (a new peer, the gate flag), does not cancel an
 * attempt: the person may still be finishing it in the browser, and a cancel here once killed a
 * callback that was about to arrive. Only the Cancel button cancels; otherwise the brain's
 * five-minute flow timeout ends it, and coming back reattaches through authState / loginStep.
 */
export function useChatGPTLogin(
  /** Either plan sign-in: the official one or the legacy Codex one (maintainers 2026-11-15). */
  PROVIDER: string,
  enabled: boolean,
  initial: ProviderAuthState["state"],
) {
  const { peer } = useRpc();
  const [state, setState] = useState<ProviderAuthState>({ providerId: PROVIDER, state: initial });
  const [step, setStep] = useState<LoginStep | null>(null);
  const session = useRef<{ peer: Peer | null; progress: ReturnType<typeof createOAuthProgress> }>(
    null,
  );
  useEffect(() => {
    if (!enabled) return;
    const progress = createOAuthProgress();
    const current = { peer, progress };
    session.current = current;
    setStep(null);
    const snapshot = progress.capture();
    const offState = peer?.on("providers.loginState", (next) => {
      if (next.providerId !== PROVIDER || !progress.alive()) return;
      progress.changed();
      setState(next);
      if (next.state !== "connecting") setStep(null);
    });
    const offStep = peer?.on("providers.loginStep", (next) => {
      if (next.providerId !== PROVIDER || !progress.alive()) return;
      progress.changed();
      setState({ providerId: PROVIDER, state: "connecting" });
      setStep(next);
    });
    void (async () => {
      if (!peer) return;
      const now = await peer.call("providers.authState", { providerId: PROVIDER });
      if (!progress.current(snapshot)) return;
      setState(now);
      if (now.state !== "connecting") return;
      const pending = await peer.call("providers.loginStep", { providerId: PROVIDER });
      if (progress.current(snapshot)) setStep(pending);
    })().catch(() => {
      if (progress.current(snapshot)) setState({ providerId: PROVIDER, state: "error" });
    });
    return () => {
      progress.dispose();
      if (session.current === current) session.current = null;
      offState?.();
      offStep?.();
    };
  }, [enabled, peer, PROVIDER]);
  const live = () => {
    const current = session.current;
    return current?.peer === peer ? current : null;
  };
  return {
    state,
    step,
    /** Applies an RPC reply only if no event has superseded it meanwhile. */
    async apply(call: () => Promise<ProviderAuthState>) {
      const current = live();
      if (!current) return;
      const snapshot = current.progress.changed();
      const next = await call();
      if (live() !== current || !current.progress.current(snapshot)) return;
      current.progress.changed();
      setState(next);
      if (next.state !== "connecting") setStep(null);
    },
    async input(value: string) {
      const current = live();
      if (!step || !current || !peer) return;
      const promptId = step.promptId;
      const snapshot = current.progress.capture();
      await peer.call("providers.loginInput", { providerId: PROVIDER, promptId, value });
      if (live() === current && current.progress.current(snapshot)) {
        current.progress.changed();
        setStep((now) => (now?.promptId === promptId ? null : now));
      }
    },
  };
}
