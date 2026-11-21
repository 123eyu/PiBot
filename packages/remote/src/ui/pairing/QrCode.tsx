import { create } from "qrcode";
import { useMemo } from "react";
import styles from "../settings/remote.module.css";
export function QrCode({
  payload,
  label,
  errorLabel,
}: {
  payload: string;
  label: string;
  errorLabel: string;
}) {
  const qr = useMemo(() => {
    try {
      const { modules } = create(payload, { errorCorrectionLevel: "M" });
      const cells: string[] = [];
      for (let y = 0; y < modules.size; y++)
        for (let x = 0; x < modules.size; x++)
          if (modules.get(y, x)) cells.push(`M${x + 4} ${y + 4}h1v1h-1z`);
      return { size: modules.size + 8, path: cells.join("") };
    } catch {
      return undefined;
    }
  }, [payload]);
  if (!qr) return <p role="alert">{errorLabel}</p>;
  return (
    <svg className={styles.qr} viewBox={`0 0 ${qr.size} ${qr.size}`} role="img" aria-label={label}>
      <title>{label}</title>
      <rect width={qr.size} height={qr.size} fill="var(--logo-ink-ink)" />
      <path d={qr.path} fill="currentColor" />
    </svg>
  );
}
