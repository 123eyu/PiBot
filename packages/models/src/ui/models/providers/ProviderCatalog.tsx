import { type Provider, providerFamily } from "@pibot/models-contract/full";
import { setupStyles as styles, useT } from "@pibot/renderer-kit";
import { useState } from "react";
import { providerIdentity } from "../../setup/operations.ts";
import modelStyles from "../models.module.css";
import { modelCountText } from "./model-count.ts";
import {
  groupedProviderCatalog,
  providerGroups as groups,
  namedProviders,
  providerCatalog,
} from "./provider-catalog.ts";
import { providerMonogram } from "./provider-monogram.ts";

export function ProviderCatalog({
  providers,
  selection,
  disabled,
  onSelect,
  initialGroup = "common",
}: {
  providers: Provider[];
  selection?: string;
  disabled: boolean;
  onSelect(provider: Provider, button: HTMLElement): void;
  initialGroup?: (typeof groups)[number];
}) {
  const t = useT();
  const [group, setGroup] = useState(initialGroup);
  const [search, setSearch] = useState("");
  const named = namedProviders(providers, t("chatgpt.title"), t("chatgpt.codex.title"));
  const catalog = groupedProviderCatalog(
    providerCatalog(named, t("setup.customLabel"), t("models.payAsYouGo")),
  );
  const configured = providerCatalog(named, t("setup.customLabel"), t("models.payAsYouGo"))
    .filter((provider) => provider.configured)
    .sort((a, b) => a.name.localeCompare(b.name, "en"));
  const query = search.trim().toLowerCase();
  const visible = catalog.filter((provider) =>
    query
      ? `${provider.id} ${provider.name} ${t(`models.auth.${provider.auth}`)}`
          .toLowerCase()
          .includes(query)
      : group === "all" || provider.group === group,
  );
  const renderProvider = (provider: Provider, saved = false) => (
    <button
      key={providerIdentity(provider)}
      type="button"
      className={`${modelStyles.tile} ${saved ? modelStyles.configuredTile : ""}`}
      aria-pressed={providerIdentity(provider) === selection}
      data-add={provider.id === "new-custom" || undefined}
      title={provider.unavailableReason ? t(`errors.${provider.unavailableReason}`) : undefined}
      disabled={disabled || !provider.available}
      onClick={(event) => onSelect(provider, event.currentTarget)}
    >
      <span aria-hidden="true" className={modelStyles.monogram} data-group={provider.group}>
        {providerMonogram(provider.id, provider.name)}
      </span>
      <span className={modelStyles.tileText}>
        <strong>
          {provider.name}
          {saved && provider.auth !== "custom" && providerFamily(provider.id)
            ? ` · ${t(`models.region.${providerFamily(provider.id)?.variants.find(([id]) => id === provider.id)?.[1] ?? "global"}`)}`
            : ""}
        </strong>
        <span className={modelStyles.tileNote}>
          {!provider.available
            ? t(
                provider.unavailableReason
                  ? `errors.${provider.unavailableReason}`
                  : "common.comingSoon",
              )
            : saved
              ? provider.auth === "oauth"
                ? t("auth.state.connected")
                : provider.keyHint === undefined
                  ? t("setup.saved")
                  : t("models.keySaved", { hint: provider.keyHint })
              : `${t(`models.auth.${provider.auth}`)} · ${provider.available ? modelCountText(provider, t) : t("common.comingSoon")}`}
        </span>
      </span>
      {!saved && provider.configured && (
        <span role="img" className={modelStyles.configuredDot} aria-label={t("setup.saved")} />
      )}
    </button>
  );
  return (
    <div className={modelStyles.modelsList}>
      <p className={modelStyles.subtitle}>
        {t("setup.catalogNote", {
          count: providers.filter((provider) => provider.auth !== "custom").length,
        })}
      </p>
      <section className={modelStyles.providerSection}>
        <h2>
          {t("models.configured")} · {configured.length}
        </h2>
        {configured.length ? (
          <div className={modelStyles.configuredProviders}>
            {configured.map((provider) => renderProvider(provider, true))}
          </div>
        ) : (
          <p className={styles.note}>{t("models.noConfigured")}</p>
        )}
      </section>
      <section className={modelStyles.providerSection}>
        <div className={modelStyles.sectionHeading}>
          <h2>{t("models.catalog")}</h2>
          <input
            className={modelStyles.providerSearch}
            aria-label={t("models.search")}
            placeholder={t("models.search")}
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <fieldset className={modelStyles.groups} aria-label={t("models.groups")}>
          {groups.map((item) => (
            <button
              key={item}
              type="button"
              title={t(`models.group.${item}`)}
              aria-label={
                t(`models.groupShort.${item}`) === t(`models.group.${item}`)
                  ? t(`models.group.${item}`)
                  : `${t(`models.groupShort.${item}`)}: ${t(`models.group.${item}`)}`
              }
              aria-pressed={group === item}
              onClick={() => setGroup(item)}
            >
              {t(`models.groupShort.${item}`)}
            </button>
          ))}
        </fieldset>
        <div className={modelStyles.providers}>
          {visible.map((provider) => renderProvider(provider))}
        </div>
        {!visible.length && <p className={styles.note}>{t("models.noResults")}</p>}
      </section>
    </div>
  );
}
