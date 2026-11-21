import { useT } from "@pibot/renderer-kit";
import type { SkillContract } from "@pibot/skills-contract/full";
import {
  EditorField,
  EditorRow,
  EditorSection,
  type InvalidField,
} from "./WorkflowEditorParts.tsx";
import styles from "./workflow.module.css";

function cleanNumber(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : Number.NaN;
}

export function WorkflowRulesEditor({
  contract,
  change,
  invalid,
}: {
  contract: SkillContract;
  change(contract: SkillContract): void;
  invalid: InvalidField;
}) {
  const t = useT();
  return (
    <>
      <EditorSection
        title={t("workflows.editor.rules")}
        add={
          contract.stop.length < 3
            ? () => change({ ...contract, stop: [...contract.stop, ""] })
            : undefined
        }
      >
        {contract.stop.map((rule, index) => (
          <EditorRow
            // biome-ignore lint/suspicious/noArrayIndexKey: Controlled positional contract row.
            key={`stop-${index}`}
            remove={() =>
              change({ ...contract, stop: contract.stop.filter((_, item) => item !== index) })
            }
          >
            <input
              className={styles.rowWide}
              aria-label={t("workflows.editor.stopRule")}
              value={rule}
              maxLength={300}
              aria-invalid={invalid(`contract.stop.${index}`) || undefined}
              onChange={(event) =>
                change({
                  ...contract,
                  stop: contract.stop.map((item, itemIndex) =>
                    itemIndex === index ? event.currentTarget.value : item,
                  ),
                })
              }
            />
          </EditorRow>
        ))}
        <EditorField
          label={t("workflows.editor.maxFixRounds")}
          invalid={invalid("contract.maxFixRounds")}
        >
          <select
            value={contract.maxFixRounds}
            onChange={(event) =>
              change({ ...contract, maxFixRounds: Number(event.currentTarget.value) })
            }
          >
            {[0, 1, 2].map((rounds) => (
              <option key={rounds} value={rounds}>
                {rounds}
              </option>
            ))}
          </select>
        </EditorField>
      </EditorSection>

      <EditorSection title={t("workflows.editor.budget")}>
        <div className={styles.threeColumns}>
          {(["costUsd", "modelRequests", "activeSeconds"] as const).map((key) => (
            <EditorField
              key={key}
              label={t(`workflows.editor.budget.${key}`)}
              invalid={invalid(`contract.budget.${key}`)}
            >
              <input
                type="number"
                min={key === "activeSeconds" ? 30 : key === "modelRequests" ? 1 : 0}
                step={key === "costUsd" ? "0.01" : "1"}
                value={contract.budget?.[key] ?? ""}
                onChange={(event) => {
                  const value = cleanNumber(event.currentTarget.value);
                  const budget = { ...contract.budget, [key]: value };
                  if (Object.values(budget).every((item) => item === undefined))
                    change({ ...contract, budget: undefined });
                  else change({ ...contract, budget });
                }}
              />
            </EditorField>
          ))}
        </div>
        <EditorField
          label={t("workflows.editor.modelTier")}
          invalid={invalid("contract.model.tier")}
        >
          <select
            value={contract.model?.tier ?? "main"}
            onChange={(event) =>
              change({
                ...contract,
                model: {
                  ...contract.model,
                  tier: event.currentTarget.value as "main" | "cheap",
                },
              })
            }
          >
            <option value="main">{t("workflows.editor.model.main")}</option>
            <option value="cheap">{t("workflows.editor.model.cheap")}</option>
          </select>
        </EditorField>
      </EditorSection>
    </>
  );
}
