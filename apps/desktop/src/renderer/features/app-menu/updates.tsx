import type { DesktopUpdateAction, DesktopUpdateState, MethodResults } from "@pibot/protocol";
import { useRpc } from "@pibot/renderer-kit";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { openWebsite } from "./AppPanels.tsx";

type Fallback = { busy: boolean; failed: boolean; result?: MethodResults["app.checkUpdates"] };
interface UpdatesValue {
  /** Undefined until the desktop main process answers. */
  state?: DesktopUpdateState;
  /** The bridge did not answer; the panel falls back to the brain's manifest check. */
  bridgeFailed: boolean;
  /** Development runs: the brain's stable.json check, which only links to the download. */
  fallback: Fallback;
  run(action: DesktopUpdateAction): void;
  check(): void;
  /** Opens this platform's installer download (or the website) in the default browser. */
  openDownload(): Promise<void>;
  /** The updates panel shows the same content, so the corner notice waits while it is open. */
  holdNotice(): () => void;
  noticeHeld: boolean;
}
const UpdatesContext = createContext<UpdatesValue | null>(null);

export function useUpdates() {
  const value = useContext(UpdatesContext);
  if (!value) throw new Error("UpdatesProvider missing");
  return value;
}

export function UpdatesProvider({ children }: { children: ReactNode }) {
  const { peer } = useRpc();
  const [state, setState] = useState<DesktopUpdateState>();
  const [bridgeFailed, setBridgeFailed] = useState(false);
  const [held, setHeld] = useState(0);
  const [fallback, setFallback] = useState<Fallback>({ busy: false, failed: false });
  const fallbackRequest = useRef(0);
  useEffect(() => {
    let pushed = false,
      alive = true;
    const bridge = window.pibot.updates;
    // Every change is pushed; request replies could arrive after a newer push, so only the
    // initial read uses one, and only until the first push.
    const off = bridge.onState((next) => {
      pushed = true;
      setState(next);
    });
    void bridge.run("state").then(
      (next) => {
        if (alive && !pushed) setState(next);
      },
      () => {
        if (alive) setBridgeFailed(true);
      },
    );
    return () => {
      alive = false;
      off();
    };
  }, []);
  const run = useCallback((action: DesktopUpdateAction) => {
    void window.pibot.updates.run(action).then(
      () => setBridgeFailed(false),
      () => setBridgeFailed(true),
    );
  }, []);
  const legacy = state?.reason === "dev" || (!state && bridgeFailed);
  const check = useCallback(() => {
    if (!legacy) {
      run("check");
      return;
    }
    const request = ++fallbackRequest.current;
    setFallback({ busy: true, failed: false });
    const finish = (next: Fallback) => {
      if (fallbackRequest.current === request) setFallback(next);
    };
    if (!peer) finish({ busy: false, failed: true });
    else
      void peer.call("app.checkUpdates", undefined, { timeoutMs: 25000 }).then(
        (result) => finish({ busy: false, failed: false, result }),
        () => finish({ busy: false, failed: true }),
      );
  }, [legacy, peer, run]);
  const openDownload = useCallback(async () => {
    if (!peer) throw new Error("app_offline");
    // stable.json names the installer for this platform; the website is the fallback.
    const result = await peer
      .call("app.checkUpdates", undefined, { timeoutMs: 25000 })
      .catch(() => undefined);
    await openWebsite(peer, result?.status === "available" ? result.url : undefined);
  }, [peer]);
  const holdNotice = useCallback(() => {
    setHeld((count) => count + 1);
    return () => setHeld((count) => count - 1);
  }, []);
  const value = useMemo(
    () => ({
      state,
      bridgeFailed,
      fallback,
      run,
      check,
      openDownload,
      holdNotice,
      noticeHeld: held > 0,
    }),
    [state, bridgeFailed, fallback, run, check, openDownload, holdNotice, held],
  );
  return <UpdatesContext.Provider value={value}>{children}</UpdatesContext.Provider>;
}
