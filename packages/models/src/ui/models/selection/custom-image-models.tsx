import type { CustomImageModel } from "@pibot/models-contract/full";
import { setupStyles as styles, useT } from "@pibot/renderer-kit";
import { Button, IconTile, TextField } from "@pibot/ui";
import detailStyles from "../providers/provider-detail.module.css";

export type ImageModelRow = CustomImageModel & { rowId: string };
export function CustomImageModels({
  models,
  change,
}: {
  models: ImageModelRow[];
  change(models: ImageModelRow[]): void;
}) {
  const t = useT();
  const patch = (rowId: string, update: Partial<CustomImageModel>) =>
    change(models.map((model) => (model.rowId === rowId ? { ...model, ...update } : model)));
  return (
    <div className={styles.stack}>
      {/* Image models are their own card group inside the custom provider form. */}
      <strong className={detailStyles.groupHead}>
        <IconTile icon="image" tone="pink" size="sm" />
        {t("media.imageModels")}
      </strong>
      <p className={styles.note}>{t("media.imageModelsHint")}</p>
      {models.map((model) => (
        <div className={detailStyles.imageModel} key={model.rowId}>
          <TextField
            required
            label={t("media.modelId")}
            value={model.id}
            maxLength={200}
            onChange={(event) => patch(model.rowId, { id: event.currentTarget.value })}
          />
          <TextField
            label={t("media.modelName")}
            value={model.name ?? ""}
            maxLength={200}
            onChange={(event) =>
              patch(model.rowId, { name: event.currentTarget.value || undefined })
            }
          />
          {(["text-to-image", "image-to-image"] as const).map((mode) => (
            <label className={styles.check} key={mode}>
              <input
                type="checkbox"
                checked={model.modes.includes(mode)}
                onChange={(event) =>
                  patch(model.rowId, {
                    modes: event.currentTarget.checked
                      ? [...model.modes, mode]
                      : model.modes.filter((value) => value !== mode),
                  })
                }
              />
              {t(`media.mode.${mode}`)}
            </label>
          ))}
          <Button
            variant="ghost"
            onClick={() => change(models.filter((row) => row.rowId !== model.rowId))}
          >
            {t("common.delete")}
          </Button>
        </div>
      ))}
      <Button
        variant="secondary"
        disabled={models.length >= 200}
        onClick={() =>
          change([...models, { rowId: crypto.randomUUID(), id: "", modes: ["text-to-image"] }])
        }
      >
        {t("media.addImageModel")}
      </Button>
    </div>
  );
}
