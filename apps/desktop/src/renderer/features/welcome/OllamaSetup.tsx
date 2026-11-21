import type { MethodResults } from "@pibot/protocol";
import { AppSelect, useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import shared from "../../../../../../packages/renderer-kit/src/widgets/setup/setup.module.css";
import styles from "./welcome.module.css";

/** The local card's body; the model step renders it only while that card is chosen. */
export function OllamaSetup({
  result,
  selected,
  busy,
  detecting,
  change,
  detect,
  configure,
}: {
  result?: MethodResults["local.detectOllama"];
  selected: string;
  busy: boolean;
  detecting: boolean;
  change(value: string): void;
  detect(): void;
  configure(): void;
}) {
  const t = useT();
  return (
    <>
      <p role="status" className={shared.note}>
        {detecting
          ? t("welcome.model.detecting")
          : result?.running
            ? result.models.length
              ? t("welcome.model.detected", { count: result.models.length })
              : t("welcome.model.noLocalModels")
            : t("welcome.model.notDetected")}
      </p>
      {!detecting && result?.running && !!result.models.length && (
        <>
          <AppSelect
            label={t("models.model")}
            value={selected}
            disabled={busy}
            change={change}
            options={result.models.map((entry) => ({ value: entry.id, label: entry.id }))}
          />
          <Button variant="secondary" disabled={busy || !selected} onClick={configure}>
            {t("setup.useLocal")}
          </Button>
        </>
      )}
      {!detecting && (!result?.running || !result.models.length) && (
        <>
          <p className={shared.note}>
            {t("setup.installHint")}{" "}
            <a
              className={styles.link}
              href="https://ollama.com/download"
              target="_blank"
              rel="noreferrer"
            >
              {t("welcome.model.installOllama")}
            </a>
          </p>
          <div>
            <Button variant="secondary" disabled={busy} onClick={detect}>
              {t("welcome.model.detectAgain")}
            </Button>
          </div>
        </>
      )}
    </>
  );
}
