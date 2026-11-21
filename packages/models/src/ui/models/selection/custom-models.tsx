import { setupStyles as styles, useT } from "@pibot/renderer-kit";
import { Button, TextField } from "@pibot/ui";
import detailStyles from "../providers/provider-detail.module.css";
import { type ModelRow, modelRow } from "./custom-model-state.ts";

export function CustomModels({
  models,
  onChange,
  onPatch,
}: {
  models: ModelRow[];
  onChange(models: ModelRow[]): void;
  onPatch(rowId: string, patch: Partial<ModelRow>): void;
}) {
  const t = useT();
  return (
    <>
      {!models.length && <p className={styles.note}>{t("models.custom.noModels")}</p>}
      {models.map((model) => (
        <div key={model.rowId} className={detailStyles.customModel}>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={model.selected}
              onChange={(event) => onPatch(model.rowId, { selected: event.target.checked })}
            />
            {t("models.custom.selectModels")}
          </label>
          <TextField
            label={t("models.custom.modelId")}
            value={model.id}
            required
            onChange={(event) => onPatch(model.rowId, { id: event.target.value })}
          />
          <TextField
            label={t("models.custom.contextWindow")}
            type="number"
            min={1}
            step={1}
            required
            value={model.context}
            onChange={(event) => onPatch(model.rowId, { context: event.target.value })}
          />
          <TextField
            label={t("models.custom.maxTokens")}
            type="number"
            min={1}
            step={1}
            required
            value={model.maxOutput}
            onChange={(event) => onPatch(model.rowId, { maxOutput: event.target.value })}
          />
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={model.images}
              onChange={(event) => onPatch(model.rowId, { images: event.target.checked })}
            />
            {t("models.images")}
          </label>
          <p className={`${styles.note} ${detailStyles.modelSource}`}>
            {Object.values(model.manual).some(Boolean)
              ? t("models.custom.manual")
              : model.limitsSource === "provider"
                ? t("models.custom.provider")
                : model.capabilities?.inferredFrom?.provider === "family"
                  ? t("models.custom.family", { family: model.capabilities.inferredFrom.id })
                  : model.capabilities?.inferredFrom
                    ? t("models.custom.inferred", {
                        source: `${model.capabilities.inferredFrom.provider}/${model.capabilities.inferredFrom.id}`,
                      })
                    : model.capabilities || !model.id
                      ? t("models.custom.unrecognized")
                      : t("setup.loading")}
          </p>
          {Object.values(model.manual).some(Boolean) && (
            <Button
              variant="secondary"
              onClick={() =>
                onPatch(model.rowId, {
                  manual: { context: false, maxOutput: false, images: false, reasoning: false },
                })
              }
            >
              {t("models.custom.resetCapabilities")}
            </Button>
          )}
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={model.reasoning}
              onChange={(event) => onPatch(model.rowId, { reasoning: event.target.checked })}
            />
            {t("models.reasoning")}
          </label>
          <Button
            variant="ghost"
            onClick={() => onChange(models.filter((row) => row.rowId !== model.rowId))}
          >
            {t("setup.modelRemove")}
          </Button>
        </div>
      ))}
      <Button variant="secondary" onClick={() => onChange([...models, modelRow({ id: "" })])}>
        {t("models.custom.addModel")}
      </Button>
    </>
  );
}
