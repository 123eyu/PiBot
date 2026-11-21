import { useT } from "@pibot/renderer-kit";
import type { SkillContract } from "@pibot/skills-contract/full";
import { Switch } from "@pibot/ui";
import { EditorRow, EditorSection, type InvalidField } from "./WorkflowEditorParts.tsx";
import styles from "./workflow.module.css";

export function WorkflowInputEditor({
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
        title={t("workflows.editor.inputs")}
        add={
          contract.inputs.length < 12
            ? () =>
                change({
                  ...contract,
                  inputs: [...contract.inputs, { name: "", kind: "text", required: false }],
                })
            : undefined
        }
      >
        {contract.inputs.map((input, index) => (
          <EditorRow
            // Contract rows have no persistent UI id; every control is controlled by position.
            // biome-ignore lint/suspicious/noArrayIndexKey: See above.
            key={`input-${index}`}
            remove={() =>
              change({
                ...contract,
                inputs: contract.inputs.filter((_, item) => item !== index),
              })
            }
          >
            <input
              aria-label={t("workflows.editor.inputName")}
              placeholder={t("workflows.editor.inputName")}
              value={input.name}
              maxLength={40}
              aria-invalid={invalid(`contract.inputs.${index}.name`) || undefined}
              onChange={(event) =>
                change({
                  ...contract,
                  inputs: contract.inputs.map((item, itemIndex) =>
                    itemIndex === index ? { ...item, name: event.currentTarget.value } : item,
                  ),
                })
              }
            />
            <select
              aria-label={t("workflows.editor.inputType")}
              value={input.kind}
              onChange={(event) =>
                change({
                  ...contract,
                  inputs: contract.inputs.map((item, itemIndex) =>
                    itemIndex === index
                      ? { ...item, kind: event.currentTarget.value as typeof input.kind }
                      : item,
                  ),
                })
              }
            >
              {(["text", "file", "folder", "previous"] as const).map((kind) => (
                <option value={kind} key={kind}>
                  {t(`workflows.input.${kind}`)}
                </option>
              ))}
            </select>
            <Switch
              label={t("workflows.input.required")}
              checked={input.required}
              onCheckedChange={(required) =>
                change({
                  ...contract,
                  inputs: contract.inputs.map((item, itemIndex) =>
                    itemIndex === index ? { ...item, required } : item,
                  ),
                })
              }
            />
            <input
              className={styles.rowWide}
              aria-label={t("workflows.editor.description")}
              placeholder={t("workflows.editor.description")}
              value={input.description ?? ""}
              maxLength={200}
              onChange={(event) =>
                change({
                  ...contract,
                  inputs: contract.inputs.map((item, itemIndex) =>
                    itemIndex === index
                      ? { ...item, description: event.currentTarget.value || undefined }
                      : item,
                  ),
                })
              }
            />
          </EditorRow>
        ))}
      </EditorSection>

      <EditorSection
        title={t("workflows.editor.prechecks")}
        add={
          contract.prechecks.length < 12 && contract.inputs.length
            ? () =>
                change({
                  ...contract,
                  prechecks: [
                    ...contract.prechecks,
                    { input: contract.inputs[0]?.name ?? "", check: "exists" },
                  ],
                })
            : undefined
        }
      >
        {contract.prechecks.map((rule, index) =>
          typeof rule === "string" ? (
            <EditorRow
              // biome-ignore lint/suspicious/noArrayIndexKey: Controlled positional contract row.
              key={`precheck-text-${index}`}
              remove={() =>
                change({
                  ...contract,
                  prechecks: contract.prechecks.filter((_, item) => item !== index),
                })
              }
            >
              <input
                className={styles.rowWide}
                readOnly
                aria-label={t("workflows.editor.modelRule")}
                value={rule}
              />
            </EditorRow>
          ) : (
            <EditorRow
              // biome-ignore lint/suspicious/noArrayIndexKey: Controlled positional contract row.
              key={`precheck-${index}`}
              remove={() =>
                change({
                  ...contract,
                  prechecks: contract.prechecks.filter((_, item) => item !== index),
                })
              }
            >
              <select
                aria-label={t("workflows.editor.precheckInput")}
                value={rule.input}
                aria-invalid={invalid(`contract.prechecks.${index}.input`) || undefined}
                onChange={(event) =>
                  change({
                    ...contract,
                    prechecks: contract.prechecks.map((item, itemIndex) =>
                      itemIndex === index ? { ...rule, input: event.currentTarget.value } : item,
                    ),
                  })
                }
              >
                <option value="">{t("workflows.editor.chooseInput")}</option>
                {contract.inputs.map((input) => (
                  <option key={input.name} value={input.name}>
                    {input.name}
                  </option>
                ))}
              </select>
              <select
                aria-label={t("workflows.editor.checkType")}
                value={rule.check}
                onChange={(event) =>
                  change({
                    ...contract,
                    prechecks: contract.prechecks.map((item, itemIndex) =>
                      itemIndex === index
                        ? { ...rule, check: event.currentTarget.value as "exists" | "nonEmpty" }
                        : item,
                    ),
                  })
                }
              >
                <option value="exists">{t("workflows.editor.exists")}</option>
                <option value="nonEmpty">{t("workflows.editor.nonEmpty")}</option>
              </select>
            </EditorRow>
          ),
        )}
      </EditorSection>
    </>
  );
}
