import type { PairStatus } from "@pibot/remote-contract";
import { SettingsLine, useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useEffect, useState } from "react";
import { QrCode } from "./QrCode.tsx";
export function Pairing({
  pair,
  busy,
  cancel,
}: {
  pair: PairStatus & { payload?: string };
  busy: boolean;
  cancel(): void;
}) {
  const t = useT();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.ceil((Date.parse(pair.expiresAt) - now) / 1000));
  if (pair.status === "paired")
    return (
      <SettingsLine role="status" tone="ok">
        {t("remote.securityCode", { code: pair.securityCode ?? "" })}
      </SettingsLine>
    );
  if (pair.status !== "waiting" || !seconds)
    return <SettingsLine role="status">{t("remote.pairEnded")}</SettingsLine>;
  return (
    <div>
      <SettingsLine>{t("remote.scan")}</SettingsLine>
      {pair.payload && (
        <QrCode payload={pair.payload} label={t("remote.scan")} errorLabel={t("remote.failed")} />
      )}
      <SettingsLine
        action={
          <Button variant="secondary" disabled={busy} onClick={cancel}>
            {t("remote.cancel")}
          </Button>
        }
      >
        {t("remote.expires", { seconds })}
      </SettingsLine>
    </div>
  );
}
