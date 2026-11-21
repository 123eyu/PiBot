import type { Bot, Provider } from "@pibot/protocol";
import { useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import styles from "../chat.module.css";

/** Upgrade metadata never changes model selection or authorizes a request. */
export function SubscriptionAuthNotice({
  bot,
  providers,
  openSettings,
}: {
  bot?: Bot;
  providers: readonly Provider[];
  openSettings(): void;
}) {
  const t = useT();
  // `openai-chatgpt` is the current ChatGPT plan provider, not a retired sign-in.
  const retired = ["openai-codex", "github-copilot"].includes(bot?.modelProvider ?? "");
  const affected = providers.some(
    (provider) =>
      provider.id === bot?.modelProvider && provider.subscriptionRemoved && !provider.configured,
  );
  if (!retired && !affected) return null;
  return (
    <p className={`${styles.notice} ${styles.band}`} data-tone="warn" role="status">
      {t("errors.subscription_unsupported")}
      <Button variant="ghost" onClick={openSettings}>
        {t("chat.checkKey")}
      </Button>
    </p>
  );
}
