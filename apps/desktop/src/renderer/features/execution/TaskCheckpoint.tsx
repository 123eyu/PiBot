import { toolNameKey } from "@pibot/client-core";
import type { ExecutionCheckpoint } from "@pibot/protocol";
import { useT } from "@pibot/renderer-kit";
import { Button, Icon } from "@pibot/ui";
import { useState } from "react";
import styles from "./execution.module.css";

export function TaskCheckpoint({ checkpoint }: { checkpoint: ExecutionCheckpoint }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <p className={styles.hint}>
        {t("execution.taskCurrentStep")} ·{" "}
        {checkpoint.tool ? t(toolNameKey(checkpoint.tool)) : t("execution.checkpoint.idle")}
        {" · "}
        {t(`execution.checkpoint.${checkpoint.phase}`)}
      </p>
      {!!checkpoint.summary && (
        <>
          <Button variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
            {t("execution.checkpointDetails")}
            <Icon
              name="chevronRight"
              size={14}
              style={{ transform: open ? "rotate(90deg)" : undefined }}
            />
          </Button>
          {open && <pre className={styles.output}>{checkpoint.summary}</pre>}
        </>
      )}
    </>
  );
}
