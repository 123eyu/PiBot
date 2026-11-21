import { SystemPermissionRows } from "@pibot/computer-use/ui";
import { hostPlatform, useT } from "@pibot/renderer-kit";
import { Button, IconTile } from "@pibot/ui";
import { useEffect, useRef, useState } from "react";
import styles from "./welcome.module.css";

export function SystemPermissionsStep({ onReady }: { onReady(ready: boolean): void }) {
  const t = useT();
  const [restarting, setRestarting] = useState(false);
  const [failed, setFailed] = useState(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  return (
    <div className={styles.permissions}>
      <SystemPermissionRows onboarding={{ onReady }} />
      {hostPlatform() === "darwin" && (
        <div className={styles.band}>
          <IconTile icon="refresh" tone="violet" size="sm" />
          <span>{t("welcome.computer.restartHint")}</span>
          <Button
            variant="pill"
            loading={restarting}
            onClick={() => {
              if (restarting) return;
              setRestarting(true);
              setFailed(false);
              void window.pibot
                .restartApp()
                .catch(() => {
                  if (active.current) setFailed(true);
                })
                .finally(() => {
                  if (active.current) setRestarting(false);
                });
            }}
          >
            {t("welcome.computer.restart")}
          </Button>
        </div>
      )}
      {failed && (
        <p role="alert" className={styles.band} data-tone="danger">
          <span>{t("welcome.computer.restartFailed")}</span>
        </p>
      )}
    </div>
  );
}
