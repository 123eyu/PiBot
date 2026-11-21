import type { Approval } from "@pibot/protocol";
import { approvalStyles as styles, useComboboxText, useSettings } from "@pibot/renderer-kit";
import { Combobox } from "@pibot/ui";
import { useId } from "react";

type Choice = "once" | "bot" | "all";
export function ConnectorApprovalScope({
  request,
  choice,
  setChoice,
  disabled,
}: {
  request: NonNullable<Approval["connectorConsent"]>;
  choice: Choice;
  setChoice(value: Choice): void;
  disabled: boolean;
}) {
  const { t, language } = useSettings(),
    comboboxText = useComboboxText(),
    hint = useId();
  const display = request.display;
  return (
    <div className={styles.connectorScope}>
      {display && (
        <dl className={styles.connectorFacts}>
          <div>
            <dt>{t("approval.connection")}</dt>
            <dd>{display.name[language]}</dd>
          </div>
          <div>
            <dt>{t("approval.connectedTool")}</dt>
            <dd>{display.description || display.tool}</dd>
          </div>
        </dl>
      )}
      <Combobox
        {...comboboxText}
        label={t("approval.connectorAccess")}
        placeholder={t("approval.connectorOnce")}
        value={choice}
        disabled={disabled}
        onValueChange={(value) => {
          if (value === "once" || value === "bot" || value === "all") setChoice(value);
        }}
        options={[
          { value: "once", label: t("approval.connectorOnce") },
          { value: "bot", label: t("approval.connectorBot") },
          { value: "all", label: t("approval.connectorAll") },
        ]}
      />
      <p id={hint} className={styles.note} role="status">
        {t(`approval.connectorHint.${choice}`)}
      </p>
      <details className={styles.connectorTechnical}>
        <summary>{t("approval.connectorDetails")}</summary>
        <dl className={styles.connectorFacts}>
          <div>
            <dt>{t("approval.connectionId")}</dt>
            <dd>
              <code>{request.connectorId}</code>
            </dd>
          </div>
          {display && (
            <div>
              <dt>{t("approval.toolId")}</dt>
              <dd>
                <code>{display.tool}</code>
              </dd>
            </div>
          )}
        </dl>
      </details>
    </div>
  );
}
