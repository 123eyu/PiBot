import { useT } from "@pibot/renderer-kit";
import { IconTile } from "@pibot/ui";
import css from "./plan-signin.module.css";

// Anthropic's page on the API credit that Max / Team plans include; amounts live there only.
const CREDITS_URL = "https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers";

/**
 * Claude subscriptions cannot sign in to third-party apps,
 * but plan API credit works through an ordinary API key. No amounts are hard-coded here.
 */
export function ClaudePlanNote() {
  const t = useT();
  return (
    <div className={css.band} role="note">
      <div className={css.head}>
        <IconTile icon="bulb" tone="orange" size="sm" />
        <div>
          <strong>{t("models.claudePlan.title")}</strong>
          <p>{t("models.claudePlan.body")}</p>
        </div>
      </div>
      <a className={css.link} href={CREDITS_URL} target="_blank" rel="noreferrer">
        {t("models.claudePlan.link")}
      </a>
    </div>
  );
}
