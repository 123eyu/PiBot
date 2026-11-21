import { type Provider, providerFamily } from "@pibot/models-contract/full";
import { AppSelect, setupStyles as styles, useT } from "@pibot/renderer-kit";

export function ProviderRegion({
  provider,
  providers,
  disabled,
  change,
}: {
  provider: Provider;
  providers: Provider[];
  disabled: boolean;
  change(provider: Provider): void;
}) {
  const t = useT();
  const family = provider.auth !== "custom" && providerFamily(provider.id);
  if (!family) return null;
  return (
    <>
      <AppSelect
        label={t("models.region")}
        value={provider.id}
        disabled={disabled}
        change={(id) => {
          const region = providers.find((entry) => entry.id === id && entry.auth === provider.auth);
          if (region && !disabled) change(region);
        }}
        options={family.variants
          .filter(([id]) =>
            providers.some((entry) => entry.id === id && entry.auth === provider.auth),
          )
          .map(([value, region]) => ({ value, label: t(`models.region.${region}`) }))}
      />
      <p className={styles.note}>{t("models.regionNote")}</p>
    </>
  );
}
