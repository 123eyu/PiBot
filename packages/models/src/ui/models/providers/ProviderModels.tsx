import { defaultModelFor, type ModelInfo, type Provider } from "@pibot/models-contract/full";
import { setupStyles as styles, useSettings } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useMemo, useState } from "react";
import detailStyles from "./provider-detail.module.css";

export function ProviderModels({
  provider,
  models,
  testModelId,
}: {
  provider: Provider;
  models: ModelInfo[];
  testModelId?: string;
}) {
  const { t, settings } = useSettings();
  const [limit, setLimit] = useState(50);
  const included = useMemo(
    () => models.filter((model) => model.provider === provider.id),
    [models, provider.id],
  );
  const suggested = included.find((model) => model.id === testModelId) ?? defaultModelFor(included);
  const current = settings?.defaultModel;
  return (
    <section
      className={`${styles.stack} ${detailStyles.included}`}
      aria-label={t("models.includedModels")}
    >
      <p>
        {t("models.currentDefault", {
          model: current?.provider === provider.id ? current.id : t("models.notDefault"),
        })}
      </p>
      {current?.provider === provider.id && !included.some((model) => model.id === current.id) && (
        <p role="alert" className={styles.error}>
          {t("models.defaultUnavailable")}
        </p>
      )}
      <p className={styles.note}>
        {t("models.suggestedModel", { model: suggested?.id ?? t("models.noModels") })}
      </p>
      <details>
        <summary>
          {t("models.includedModels")} · {included.length}
        </summary>
        <p className={styles.note}>{t("models.includedNote")}</p>
        {included.length ? (
          <ul>
            {included.slice(0, limit).map((model) => (
              <li key={model.id}>
                {model.name} · {model.id}
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.note}>{t("models.noModels")}</p>
        )}
        {included.length > limit && (
          <Button variant="secondary" onClick={() => setLimit((value) => value + 50)}>
            {t("models.moreModels")}
          </Button>
        )}
      </details>
    </section>
  );
}
