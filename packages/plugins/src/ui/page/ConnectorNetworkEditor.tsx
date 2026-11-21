import { DomainSchema } from "@pibot/plugins-contract/full";
import { useSettings } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useState } from "react";
import styles from "./connectors.module.css";

/** The parent keys drafts by revision so a stale edit never silently replaces a newer list. */
export function ConnectorNetworkEditor({
  domains,
  disabled,
  save,
}: {
  domains: readonly string[];
  disabled: boolean;
  save(domains: string[]): void;
}) {
  const { t } = useSettings();
  const [text, setText] = useState(domains.join("\n"));
  const entries = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const parsed = entries.map((entry) => DomainSchema.safeParse(entry));
  const valid = entries.length <= 64 && parsed.every((entry) => entry.success);
  const normalized = [...new Set(parsed.flatMap((entry) => (entry.success ? [entry.data] : [])))];
  const changed = JSON.stringify(normalized) !== JSON.stringify(domains);
  return (
    <section className={styles.stack}>
      <label className={styles.field}>
        {t("connectors.network.title")}
        <textarea
          value={text}
          disabled={disabled}
          maxLength={16384}
          rows={4}
          onChange={(event) => setText(event.currentTarget.value)}
        />
      </label>
      <p className={styles.note}>{t("connectors.network.note")}</p>
      {!valid && (
        <p role="alert" className={styles.warn}>
          {t("connectors.network.invalid")}
        </p>
      )}
      <Button
        variant="secondary"
        disabled={disabled || !valid || !changed}
        onClick={() => save(normalized)}
      >
        {t("connectors.network.save")}
      </Button>
    </section>
  );
}
