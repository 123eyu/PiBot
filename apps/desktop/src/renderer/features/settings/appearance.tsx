import type { Settings } from "@pibot/protocol";
import { setupStyles as styles, useSettings } from "@pibot/renderer-kit";
import { SegmentedControl } from "@pibot/ui";
import tokenStyles from "@pibot/ui/tokens.css?raw";
import { useEffect, useState } from "react";

// Scope the UI package's existing palettes so light and dark previews work
// independently of the current document theme without duplicating color values.
const previewStyles = tokenStyles
  .replace(/^:root\s*\{[^}]*\}/, "")
  .replace(/:root,\s*:root\[data-theme=(?:"light"|light)\]/g, '[data-setup-preview="light"]')
  .replace(/\[data-theme=(?:"dark"|dark)\]/g, '[data-setup-preview="dark"]');

export function AppearanceControls({
  disabled,
  onChange,
  previews = false,
}: {
  disabled: boolean;
  onChange(patch: Partial<Settings>): void;
  previews?: boolean;
}) {
  const { t, settings } = useSettings();
  const [systemDark, setSystemDark] = useState(
    () =>
      typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystemDark(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const themes = ["light", "dark", "system"] as const;
  return (
    <div className={styles.stack}>
      <h2>{t("language.label")}</h2>
      <SegmentedControl
        label={t("language.label")}
        disabled={disabled}
        value={settings?.language ?? "system"}
        options={(["system", "zh", "en"] as const).map((value) => ({
          value,
          label: t(`language.${value}`),
        }))}
        onValueChange={(language) => onChange({ language })}
      />
      {previews && <p className={styles.note}>{t("language.note")}</p>}
      <h2>{t("theme.label")}</h2>
      {previews ? (
        <div className={styles.grid}>
          <style>{previewStyles}</style>
          {themes.map((theme) => (
            <button
              key={theme}
              type="button"
              className={styles.tile}
              disabled={disabled}
              aria-pressed={settings?.theme === theme}
              onClick={() => onChange({ theme })}
            >
              <div
                role="img"
                data-setup-preview={theme === "system" ? (systemDark ? "dark" : "light") : theme}
                className={styles.preview}
                aria-label={t("theme.preview", { theme: t(`theme.${theme}`) })}
              >
                <div className={styles.previewSide} />
                <div className={styles.previewChat}>
                  <span>{t("setup.preview")}</span>
                  <i />
                </div>
              </div>
              {t(`theme.${theme}`)}
            </button>
          ))}
        </div>
      ) : (
        <SegmentedControl
          label={t("theme.label")}
          disabled={disabled}
          value={settings?.theme ?? "system"}
          options={themes.map((value) => ({ value, label: t(`theme.${value}`) }))}
          onValueChange={(theme) => onChange({ theme })}
        />
      )}
    </div>
  );
}
