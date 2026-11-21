import { RpcError, RpcErrorCodes } from "@pibot/protocol";
import { useAction, useRpc, useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useState } from "react";
import { Overlay } from "../workspace/Overlay.tsx";
import styles from "./force-release.module.css";

/**
 * Releasing a hung session loses its unfinished output, so the warning bar only opens
 * the confirmation. The brain re-checks the failure and may still refuse; the banner then stays.
 */
export function ForceRelease({ botId }: { botId?: string }) {
  const t = useT();
  const { peer } = useRpc();
  const task = useAction();
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <Button variant="secondary" onClick={() => setConfirming(true)}>
        {t("runtime.forceRelease")}
      </Button>
      {confirming && (
        <Overlay
          title={t("runtime.forceRelease")}
          icon="power"
          tone="red"
          close={() => setConfirming(false)}
          busy={task.busy}
          footer={
            <>
              <Button variant="secondary" disabled={task.busy} onClick={() => setConfirming(false)}>
                {t("common.cancel")}
              </Button>
              <Button
                className={styles.release}
                disabled={!peer}
                loading={task.busy}
                onClick={() => {
                  if (!peer) return;
                  // The brain may wait the whole release timeout, so the call outlives its 30 s default.
                  void task
                    .run(
                      (signal) =>
                        peer.call(
                          "runtime.forceRelease",
                          botId ? { botId, confirmed: true } : { confirmed: true },
                          { signal, timeoutMs: 45_000 },
                        ),
                      (error) =>
                        error instanceof RpcError && error.code === RpcErrorCodes.busy
                          ? "runtime.forceReleaseFailed"
                          : "workspace.failed",
                    )
                    .then((result) => {
                      if (!result) return;
                      // Healthy clears the banner through `runtime.health`; a partial or refused
                      // release must say the app still needs a restart.
                      if (result.healthy) setConfirming(false);
                      else task.setError("runtime.forceReleaseFailed");
                    });
                }}
              >
                {t("runtime.forceRelease")}
              </Button>
            </>
          }
        >
          <p className={styles.text}>{t("runtime.forceReleaseConfirm")}</p>
          {task.error && (
            <p role="alert" className={styles.error}>
              {t(task.error)}
            </p>
          )}
        </Overlay>
      )}
    </>
  );
}
