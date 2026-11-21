import { botAvatarLook, useT } from "@pibot/renderer-kit";
import { Avatar, Chip, IconTile } from "@pibot/ui";
import { useState } from "react";
import { WorkspacePopupMenu } from "../../shell/ports.tsx";
import styles from "../changes.module.css";
import type { ReviewerList } from "./use-reviewers.ts";

type ReviewerBot = ReviewerList["bots"][number];

/**
 * The ⌄ half of the "ask X to review" button. Other Bots come first (recommended one
 * marked), the author itself last with a warning; picking one starts the review at once.
 */
export function ReviewerMenu({
  list,
  authorName,
  disabled,
  onPick,
  onCreate,
  onOpen,
}: {
  list: ReviewerList;
  authorName: string;
  disabled: boolean;
  onPick(choice: { botId: string; remember: boolean }): void;
  onCreate(): void;
  onOpen(): void;
}) {
  const t = useT();
  const [remember, setRemember] = useState(true);
  const others = list.bots
    .filter((bot) => bot.id !== list.authorId)
    .sort((a, b) => Number(b.id === list.recommendedId) - Number(a.id === list.recommendedId));
  const self = list.bots.find((bot) => bot.id === list.authorId);
  const row = (bot: ReviewerBot, meta: string, extra?: { warn?: string; self?: boolean }) => (
    <button
      key={bot.id}
      type="button"
      className={styles.reviewerRow}
      aria-current={bot.id === list.reviewerId || undefined}
      onClick={() => onPick({ botId: bot.id, remember })}
    >
      <Avatar size={24} image={bot.avatarImage} {...botAvatarLook(bot)} label={bot.name} />
      <span className={styles.reviewerText}>
        <span className={styles.reviewerName}>
          <b>{extra?.self ? t("changes.reviewer.self", { name: bot.name }) : bot.name}</b>
          {bot.id === list.recommendedId && !extra?.self && (
            <Chip tone="green">{t("changes.reviewer.recommended")}</Chip>
          )}
          {bot.id === list.defaultId && <Chip>{t("changes.reviewer.default")}</Chip>}
        </span>
        <small>{meta}</small>
        {extra?.warn && <small className={styles.reviewerWarn}>{extra.warn}</small>}
      </span>
    </button>
  );
  const meta = (bot: ReviewerBot) =>
    [
      bot.modelId,
      bot.role?.id === "code-reviewer" ? t("changes.reviewer.role.code-reviewer") : undefined,
    ]
      .filter(Boolean)
      .join(" · ");
  return (
    <WorkspacePopupMenu
      label={t("changes.reviewer.menu")}
      icon="chevron"
      disabled={disabled}
      onOpenChange={(open) => open && onOpen()}
    >
      <p>{t("changes.reviewer.heading", { name: authorName })}</p>
      {list.builtinMissing && (
        <button type="button" className={styles.reviewerRow} onClick={onCreate}>
          <IconTile icon="plus" tone="violet" />
          <span className={styles.reviewerText}>
            <span className={styles.reviewerName}>
              <b>{t("changes.reviewer.create")}</b>
              <Chip tone="violet">{t("changes.reviewer.createTag")}</Chip>
            </span>
            <small>{t("changes.reviewer.createHint")}</small>
          </span>
        </button>
      )}
      {others.map((bot) => row(bot, meta(bot)))}
      {self &&
        row(self, t("changes.reviewer.selfMeta"), {
          self: true,
          warn: t("changes.reviewer.selfHint"),
        })}
      <label className={styles.reviewerRemember}>
        <input
          type="checkbox"
          checked={remember}
          onChange={(event) => setRemember(event.target.checked)}
        />
        <span>{t("changes.reviewer.remember", { name: authorName })}</span>
      </label>
      <small className={styles.reviewerNote}>{t("changes.reviewer.readonly")}</small>
    </WorkspacePopupMenu>
  );
}
