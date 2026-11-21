import { useT } from "@pibot/renderer-kit";
import type { SkillContract } from "@pibot/skills-contract/full";
import {
  EditorRow,
  EditorSection,
  type InvalidField,
  nextEditorId,
} from "./WorkflowEditorParts.tsx";
import styles from "./workflow.module.css";

export function WorkflowDeliveryEditor({
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
        title={t("workflows.editor.deliverables")}
        add={
          contract.deliverables.length < 10
            ? () =>
                change({
                  ...contract,
                  deliverables: [
                    ...contract.deliverables,
                    {
                      id: nextEditorId(
                        "deliverable",
                        contract.deliverables.map((item) => item.id),
                      ),
                      path: "",
                      kind: "md",
                    },
                  ],
                })
            : undefined
        }
      >
        {contract.deliverables.map((deliverable, index) => (
          <EditorRow
            key={deliverable.id}
            remove={() =>
              change({
                ...contract,
                deliverables: contract.deliverables.filter((_, item) => item !== index),
              })
            }
          >
            <input
              readOnly
              aria-label={t("workflows.editor.deliverableId")}
              value={deliverable.id}
            />
            <input
              aria-label={t("workflows.editor.path")}
              placeholder={t("workflows.editor.path")}
              value={deliverable.path}
              maxLength={200}
              aria-invalid={invalid(`contract.deliverables.${index}.path`) || undefined}
              onChange={(event) =>
                change({
                  ...contract,
                  deliverables: contract.deliverables.map((item, itemIndex) =>
                    itemIndex === index ? { ...item, path: event.currentTarget.value } : item,
                  ),
                })
              }
            />
            <select
              aria-label={t("workflows.editor.kind")}
              value={deliverable.kind}
              onChange={(event) =>
                change({
                  ...contract,
                  deliverables: contract.deliverables.map((item, itemIndex) =>
                    itemIndex === index
                      ? { ...item, kind: event.currentTarget.value as typeof deliverable.kind }
                      : item,
                  ),
                })
              }
            >
              {(["md", "docx", "xlsx", "pptx", "any"] as const).map((kind) => (
                <option key={kind} value={kind}>
                  {kind}
                </option>
              ))}
            </select>
            <input
              className={styles.rowWide}
              aria-label={t("workflows.editor.sections")}
              placeholder={t("workflows.editor.sectionsHint")}
              value={deliverable.sections?.join("，") ?? ""}
              onChange={(event) =>
                change({
                  ...contract,
                  deliverables: contract.deliverables.map((item, itemIndex) =>
                    itemIndex === index
                      ? {
                          ...item,
                          sections: event.currentTarget.value
                            .split(/[，,\n]/)
                            .map((value) => value.trim())
                            .filter(Boolean),
                        }
                      : item,
                  ),
                })
              }
            />
          </EditorRow>
        ))}
      </EditorSection>

      <EditorSection
        title={t("workflows.editor.acceptance")}
        add={
          contract.acceptance.length < 20
            ? () =>
                change({
                  ...contract,
                  acceptance: [
                    ...contract.acceptance,
                    {
                      id: nextEditorId(
                        "check",
                        contract.acceptance.map((item) => item.id),
                      ),
                      check: "exists",
                      deliverable: contract.deliverables[0]?.id,
                    },
                  ],
                })
            : undefined
        }
      >
        {contract.acceptance.map((acceptance, index) => (
          <EditorRow
            key={acceptance.id}
            remove={() =>
              change({
                ...contract,
                acceptance: contract.acceptance.filter((_, item) => item !== index),
              })
            }
          >
            <select
              aria-label={t("workflows.editor.checkType")}
              value={acceptance.check}
              aria-invalid={invalid(`contract.acceptance.${index}.check`) || undefined}
              onChange={(event) => {
                const check = event.currentTarget.value as typeof acceptance.check;
                change({
                  ...contract,
                  acceptance: contract.acceptance.map((item, itemIndex) =>
                    itemIndex === index
                      ? {
                          ...item,
                          check,
                          min: check === "minCitations" ? (item.min ?? 1) : undefined,
                          columns: check === "tableColumns" ? (item.columns ?? []) : undefined,
                          deliverable:
                            check === "manual"
                              ? undefined
                              : (item.deliverable ?? contract.deliverables[0]?.id),
                        }
                      : item,
                  ),
                });
              }}
            >
              {(
                [
                  "exists",
                  "sections",
                  "citations",
                  "manual",
                  "minCitations",
                  "sectionsSourced",
                  "tableColumns",
                  "hasChart",
                  "fileNaming",
                  "gbt7714",
                ] as const
              ).map((check) => (
                <option key={check} value={check}>
                  {t(`workflows.editor.acceptance.${check}`)}
                </option>
              ))}
            </select>
            {acceptance.check === "minCitations" && (
              <input
                type="number"
                min={1}
                max={200}
                aria-label={t("workflows.editor.citationMinimum")}
                value={acceptance.min ?? 1}
                aria-invalid={invalid(`contract.acceptance.${index}.min`) || undefined}
                onChange={(event) =>
                  change({
                    ...contract,
                    acceptance: contract.acceptance.map((item, n) =>
                      n === index ? { ...item, min: Number(event.currentTarget.value) } : item,
                    ),
                  })
                }
              />
            )}
            {acceptance.check === "tableColumns" && (
              <input
                aria-label={t("workflows.editor.columns")}
                placeholder={t("workflows.editor.columns")}
                value={(acceptance.columns ?? []).join(",")}
                aria-invalid={invalid(`contract.acceptance.${index}.columns`) || undefined}
                onChange={(event) =>
                  change({
                    ...contract,
                    acceptance: contract.acceptance.map((item, n) =>
                      n === index
                        ? {
                            ...item,
                            columns: event.currentTarget.value.split(/[,，]/u),
                          }
                        : item,
                    ),
                  })
                }
              />
            )}
            {acceptance.check === "manual" ? (
              <input
                aria-label={t("workflows.editor.manual")}
                placeholder={t("workflows.editor.manual")}
                value={acceptance.text ?? ""}
                maxLength={300}
                onChange={(event) =>
                  change({
                    ...contract,
                    acceptance: contract.acceptance.map((item, itemIndex) =>
                      itemIndex === index ? { ...item, text: event.currentTarget.value } : item,
                    ),
                  })
                }
              />
            ) : (
              <select
                aria-label={t("workflows.editor.deliverable")}
                value={acceptance.deliverable ?? ""}
                aria-invalid={invalid(`contract.acceptance.${index}.deliverable`) || undefined}
                onChange={(event) =>
                  change({
                    ...contract,
                    acceptance: contract.acceptance.map((item, itemIndex) =>
                      itemIndex === index
                        ? { ...item, deliverable: event.currentTarget.value || undefined }
                        : item,
                    ),
                  })
                }
              >
                <option value="">{t("workflows.editor.chooseDeliverable")}</option>
                {contract.deliverables.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.path || item.id}
                  </option>
                ))}
              </select>
            )}
          </EditorRow>
        ))}
      </EditorSection>
    </>
  );
}
