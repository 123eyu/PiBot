import type { MethodResults } from "@pibot/protocol";
import { BotAvatar, useT, type useWorkspace } from "@pibot/renderer-kit";
import { Button, Combobox, Icon } from "@pibot/ui";
import type { Dispatch, SetStateAction } from "react";
import styles from "./message-actions.module.css";

export function TransferRecipients({
  data,
  createGroup,
  busy,
  query,
  setQuery,
  picked,
  setPicked,
  target,
  setTarget,
}: {
  data: ReturnType<typeof useWorkspace>;
  createGroup: boolean;
  busy: boolean;
  query: string;
  setQuery(value: string): void;
  picked: string[];
  setPicked: Dispatch<SetStateAction<string[]>>;
  target: string;
  setTarget(value: string): void;
}) {
  const t = useT();
  const bots = data.bots.filter((b) => !b.archivedAt),
    groups = data.groups;
  const match = (value: string) =>
    value.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  if (!createGroup)
    return (
      <>
        <Combobox
          label={t("messages.destination")}
          value={target}
          onValueChange={setTarget}
          placeholder={t("messages.chooseDestination")}
          searchPlaceholder={t("messages.search")}
          noResultsText={t("combobox.noResults")}
          moreResultsText={(count) => t("combobox.moreResults", { count })}
          disabled={busy || data.loading}
          options={[
            ...bots.map((bot) => ({
              value: `bot:${bot.id}`,
              label: bot.name,
              group: t("messages.botDestinations"),
            })),
            ...groups.map((group) => ({
              value: `group:${group.id}`,
              label: group.name,
              group: t("messages.groupDestinations"),
            })),
          ]}
        />
        {(data.hasMore || data.hasMoreBots) && (
          <Button
            variant="ghost"
            disabled={busy || data.loading}
            onClick={() => {
              if (data.hasMoreBots) void data.moreBots();
              if (data.hasMore) void data.more();
            }}
          >
            {t("messages.loadMore")}
          </Button>
        )}
      </>
    );
  return (
    <>
      <input
        className={styles.input}
        aria-label={t("common.search")}
        placeholder={t("messages.search")}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        disabled={busy}
      />
      <div className={styles.recipients}>
        {bots
          .filter((b) => match(b.name))
          .map((bot) => (
            <label className={styles.recipient} key={bot.id}>
              <input
                type={createGroup ? "checkbox" : "radio"}
                name="message-recipient"
                disabled={busy || (createGroup && !picked.includes(bot.id) && picked.length >= 6)}
                checked={createGroup ? picked.includes(bot.id) : target === `bot:${bot.id}`}
                onChange={() =>
                  createGroup
                    ? setPicked((old) =>
                        old.includes(bot.id) ? old.filter((id) => id !== bot.id) : [...old, bot.id],
                      )
                    : setTarget(`bot:${bot.id}`)
                }
              />
              <BotAvatar bot={bot} size={30} label={bot.name} />
              <span>{bot.name}</span>
            </label>
          ))}
        {!createGroup &&
          groups
            .filter((g) => match(g.name))
            .map((group) => (
              <label className={styles.recipient} key={group.id}>
                <input
                  type="radio"
                  name="message-recipient"
                  disabled={busy}
                  checked={target === `group:${group.id}`}
                  onChange={() => setTarget(`group:${group.id}`)}
                />
                <span className={styles.groupMark}>
                  <Icon name="users" size={15} />
                </span>
                <span>{group.name}</span>
              </label>
            ))}
        {(data.hasMore || data.hasMoreBots) && (
          <Button
            variant="ghost"
            onClick={() => {
              if (data.hasMoreBots) void data.moreBots();
              if (data.hasMore) void data.more();
            }}
          >
            {t("messages.loadMore")}
          </Button>
        )}
      </div>
    </>
  );
}
export function HandoffPreview({
  summary,
  busy,
  summarizing,
  generate,
  remove,
}: {
  summary?: MethodResults["messages.handoff"];
  busy: boolean;
  summarizing: boolean;
  generate(): void;
  remove(): void;
}) {
  const t = useT();
  return (
    <section className={styles.preview}>
      <p className={styles.hint}>{t("messages.handoffHint")}</p>
      {summary && (
        <>
          <pre>{summary.text}</pre>
          <p className={styles.hint}>
            {t(summary.limited ? "messages.handoffLimited" : "messages.handoffCount", {
              count: summary.sourceCount,
            })}
          </p>
        </>
      )}
      <Button
        variant="secondary"
        className={summarizing ? styles.summarizing : undefined}
        disabled={busy || summarizing}
        onClick={generate}
      >
        {summarizing && (
          <span className={styles.dots} aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        )}
        {t(
          summarizing
            ? "messages.summarizing"
            : summary
              ? "messages.regenerateHandoff"
              : "messages.handoff",
        )}
      </Button>
      {summary && (
        <Button variant="ghost" disabled={busy} onClick={remove}>
          {t("messages.removeHandoff")}
        </Button>
      )}
    </section>
  );
}
