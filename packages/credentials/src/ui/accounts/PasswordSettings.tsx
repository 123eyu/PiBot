import { type Credential, credentialSiteLabel } from "@pibot/credentials-contract/full";
import {
  layoutStyles,
  SettingsEmpty,
  SettingsLine,
  SettingsSection,
  useRpc,
  useSettings,
} from "@pibot/renderer-kit";
import { Button, IconTile, TextField } from "@pibot/ui";
import { useEffect, useRef, useState } from "react";
import styles from "./credentials.module.css";
import permissionStyles from "./permission.module.css";
import setupStyles from "./setup.module.css";
import {
  errorKey,
  useBrowserBots,
  useCredentialList,
  useCredentialStatus,
} from "./use-credentials.ts";

type Draft = {
  id?: string;
  site: string;
  username: string;
  password: string;
  totp?: string | null;
  hasTotp?: boolean;
  label: string;
  note: string;
  botIds: string[];
};
const empty = (botIds: string[]): Draft => ({
  site: "",
  username: "",
  password: "",
  label: "",
  note: "",
  botIds,
});

/**
 * Settings · Permissions › saved accounts: saved
 * accounts by site, display name and Bots. The list never holds a username or password; editing
 * leaves them empty ("keep"), and viewing one goes through `credentials.reveal`, which asks for
 * system authentication first (macOS only).
 */
export function PasswordSettings({
  focus = false,
  embedded = false,
}: {
  focus?: boolean;
  /**
   * Shown as the Permissions sub-page, whose title and lead already name the accounts and
   * explain them; the section is then just the list with its count.
   */
  embedded?: boolean;
}) {
  const { peer } = useRpc();
  const { t, language } = useSettings();
  const status = useCredentialStatus();
  const bots = useBrowserBots();
  const list = useCredentialList();
  const [draft, setDraft] = useState<Draft>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<ReturnType<typeof errorKey>>();
  const [notice, setNotice] = useState<"credentials.saved" | "credentials.deleted">();
  const [confirm, setConfirm] = useState<Credential>();
  const names = new Map(bots.map((bot) => [bot.id, bot.name]));
  const canSave = status?.storage === true;
  const root = useRef<HTMLDivElement>(null);
  // The older "passwords" page link lands on this section. Wait a frame so the settings
  // dialog's own initial focus has run and the page above has laid out.
  useEffect(() => {
    if (!focus) return;
    const frame = requestAnimationFrame(() => {
      const title = root.current?.querySelector<HTMLElement>("h2");
      root.current?.scrollIntoView({ block: "start" });
      if (!title) return;
      title.tabIndex = -1;
      title.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [focus]);

  const save = async () => {
    if (!peer || !draft || busy) return;
    setBusy("save");
    setError(undefined);
    setNotice(undefined);
    try {
      await peer.call(
        "credentials.save",
        {
          ...(draft.id ? { id: draft.id } : {}),
          site: draft.site,
          ...(draft.username.trim() ? { username: draft.username.trim() } : {}),
          ...(draft.password ? { password: draft.password } : {}),
          ...(draft.totp !== undefined ? { totp: draft.totp } : {}),
          ...(draft.label.trim() ? { label: draft.label.trim() } : {}),
          note: draft.note,
          botIds: draft.botIds,
        },
        { timeoutMs: 30_000 },
      );
      setDraft(undefined);
      setNotice("credentials.saved");
    } catch (failure) {
      setError(errorKey(failure));
    } finally {
      setBusy(undefined);
    }
  };
  const remove = async (credential: Credential) => {
    if (!peer || busy) return;
    setBusy(credential.id);
    setError(undefined);
    setNotice(undefined);
    try {
      await peer.call("credentials.delete", { id: credential.id });
      setConfirm(undefined);
      setNotice("credentials.deleted");
    } catch {
      setError("credentials.error.generic");
    } finally {
      setBusy(undefined);
    }
  };

  const startAdd = () => {
    setNotice(undefined);
    // A new account starts with the main Bot ticked (the one most chats go to), not
    // whichever Bot happens to sort first.
    const first = bots.find((bot) => bot.isMain) ?? bots[0];
    setDraft(empty(first ? [first.id] : []));
  };
  const noAccounts = !list.items.length && !list.loading && !list.error;
  let lastSite = "";
  return (
    <div ref={root} tabIndex={-1} className={layoutStyles.section}>
      <SettingsSection
        title={
          embedded
            ? `${t("credentials.accounts")} · ${list.items.length}${list.hasMore ? "+" : ""}`
            : t("credentials.title")
        }
        action={
          !draft &&
          !noAccounts && (
            <Button
              variant="secondary"
              className={layoutStyles.small}
              disabled={!peer || !canSave}
              // Without a system keyring no account can be saved, so say why the button is off
              // instead of leaving a merely pale button next to the reason line.
              title={canSave ? undefined : t("credentials.storageUnavailable")}
              onClick={startAdd}
            >
              {t("credentials.add")}
            </Button>
          )
        }
      >
        {status && !status.storage && (
          <SettingsLine role="alert" tone="danger">
            {t("credentials.storageUnavailable")}
          </SettingsLine>
        )}
        {status?.storage && !status.reveal && !noAccounts && (
          <SettingsLine>{t("credentials.revealUnsupported")}</SettingsLine>
        )}
        {error && !draft && (
          <SettingsLine role="alert" tone="danger" dot="danger">
            {t(error)}
          </SettingsLine>
        )}
        {notice && (
          <SettingsLine role="status" dot="ok">
            {t(notice)}
          </SettingsLine>
        )}
        {draft && (
          <div className={layoutStyles.inset}>
            <CredentialForm
              draft={draft}
              change={setDraft}
              bots={bots}
              canReveal={status?.reveal === true}
              busy={busy === "save"}
              canSave={canSave}
              error={error}
              onSave={() => void save()}
              onCancel={() => {
                setDraft(undefined);
                setError(undefined);
              }}
            />
          </div>
        )}
        {list.items.map((credential) => {
          const header = credential.site !== lastSite;
          lastSite = credential.site;
          const users = credential.botIds.map((id) => names.get(id)).filter(Boolean);
          return (
            <div key={credential.id}>
              {header && <div className={styles.site}>{credentialSiteLabel(credential.site)}</div>}
              <div className={permissionStyles.row}>
                <IconTile icon="user" tone="blue" size="lg" />
                <div>
                  <strong>{credential.label}</strong>
                  <small>
                    {users.length
                      ? t("credentials.usedBy", {
                          names: users.join(language === "zh" ? "、" : ", "),
                        })
                      : t("credentials.noBots")}
                    {" · "}
                    {credential.lastUsedAt
                      ? t("credentials.lastUsed", {
                          time: new Date(credential.lastUsedAt).toLocaleString(
                            language === "zh" ? "zh-CN" : "en",
                          ),
                        })
                      : t("credentials.neverUsed")}
                  </small>
                  {credential.note && <small>{credential.note}</small>}
                  {credential.hasTotp && <small>{t("credentials.totpEnabled")}</small>}
                </div>
                {confirm?.id === credential.id ? (
                  <div className={styles.actions}>
                    <small className={permissionStyles.danger}>
                      {t("credentials.deleteConfirm", {
                        site: credentialSiteLabel(credential.site),
                        label: credential.label,
                      })}
                    </small>
                    <Button variant="ghost" onClick={() => setConfirm(undefined)}>
                      {t("credentials.cancel")}
                    </Button>
                    <Button
                      variant="secondary"
                      className={permissionStyles.danger}
                      loading={busy === credential.id}
                      onClick={() => void remove(credential)}
                    >
                      {t("credentials.delete")}
                    </Button>
                  </div>
                ) : (
                  <div className={styles.actions}>
                    <Button
                      variant="ghost"
                      disabled={!peer || !!busy}
                      onClick={() => {
                        setNotice(undefined);
                        setError(undefined);
                        setDraft({
                          id: credential.id,
                          site: credential.site,
                          username: "",
                          password: "",
                          hasTotp: credential.hasTotp,
                          label: credential.label,
                          note: credential.note,
                          botIds: credential.botIds,
                        });
                      }}
                    >
                      {t("credentials.edit")}
                    </Button>
                    <Button
                      variant="ghost"
                      className={permissionStyles.danger}
                      disabled={!peer || !!busy}
                      onClick={() => setConfirm(credential)}
                    >
                      {t("credentials.delete")}
                    </Button>
                  </div>
                )}
              </div>
            </div>
          );
        })}
        {noAccounts && !draft && (
          <SettingsEmpty
            icon="user"
            title={t("credentials.emptyTitle")}
            body={embedded ? undefined : t("credentials.intro")}
            action={
              // A disabled primary renders as an empty slot, which reads as a broken control;
              // the secondary look plus the reason note is unambiguous when saving is impossible.
              <Button
                variant={canSave ? "primary" : "secondary"}
                disabled={!peer || !canSave}
                title={canSave ? undefined : t("credentials.storageUnavailable")}
                onClick={startAdd}
              >
                {t("credentials.add")}
              </Button>
            }
          />
        )}
        {list.error && (
          <SettingsLine
            role="alert"
            tone="danger"
            action={
              <Button variant="ghost" onClick={() => void list.load()}>
                {t("common.retry")}
              </Button>
            }
          >
            {t("credentials.loadError")}
          </SettingsLine>
        )}
        {list.loading && <SettingsLine role="status">{t("common.loading")}</SettingsLine>}
        {list.hasMore && (
          <SettingsLine
            action={
              <Button variant="ghost" disabled={list.loading} onClick={() => void list.load(true)}>
                {t("credentials.loadMore")}
              </Button>
            }
          >
            {null}
          </SettingsLine>
        )}
      </SettingsSection>
    </div>
  );
}

function CredentialForm({
  draft,
  change,
  bots,
  canReveal,
  canSave,
  busy,
  error,
  onSave,
  onCancel,
}: {
  draft: Draft;
  change(next: Draft): void;
  bots: { id: string; name: string }[];
  canReveal: boolean;
  canSave: boolean;
  busy: boolean;
  error?: ReturnType<typeof errorKey>;
  onSave(): void;
  onCancel(): void;
}) {
  const { peer } = useRpc();
  const { t } = useSettings();
  const [showTyped, setShowTyped] = useState(false);
  const [missing, setMissing] = useState<("site" | "username" | "password")[]>([]);
  const [revealed, setRevealed] = useState<{ username: string; password: string }>();
  const [revealState, setRevealState] = useState<"busy" | "failed">();
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // A revealed password is dropped as soon as the form closes or switches records.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Reset only when the record changes.
  useEffect(() => {
    setRevealed(undefined);
    setRevealState(undefined);
  }, [draft.id]);
  const set = (patch: Partial<Draft>) => {
    setMissing([]);
    change({ ...draft, ...patch });
  };
  const reveal = async () => {
    if (!peer || !draft.id) return;
    setRevealState("busy");
    try {
      const value = await peer.call("credentials.reveal", { id: draft.id }, { timeoutMs: 190_000 });
      if (!alive.current) return;
      setRevealed({ username: value.username, password: String.fromCharCode(...value.password) });
      setRevealState(undefined);
    } catch {
      if (alive.current) setRevealState("failed");
    }
  };
  const editing = !!draft.id;
  return (
    <form
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        const fields = [
          ...(!draft.site.trim() ? ["site" as const] : []),
          ...(!editing && !draft.username.trim() ? ["username" as const] : []),
          ...(!editing && !draft.password ? ["password" as const] : []),
        ];
        setMissing(fields);
        if (!fields.length) onSave();
      }}
    >
      <h3>
        {editing ? t("credentials.editTitle", { site: draft.site }) : t("credentials.addTitle")}
      </h3>
      <TextField
        label={t("credentials.site")}
        value={draft.site}
        placeholder={t("credentials.sitePlaceholder")}
        description={t("credentials.siteHint")}
        autoComplete="off"
        maxLength={2048}
        disabled={busy}
        onChange={(event) => set({ site: event.target.value })}
      />
      <TextField
        label={t("credentials.username")}
        value={draft.username}
        placeholder={editing ? t("credentials.keepHint") : ""}
        autoComplete="off"
        maxLength={500}
        disabled={busy}
        onChange={(event) => set({ username: event.target.value })}
      />
      <div className={styles.secretRow}>
        <TextField
          label={t("credentials.password")}
          value={draft.password}
          type={showTyped ? "text" : "password"}
          placeholder={editing ? t("credentials.keepHint") : ""}
          autoComplete="new-password"
          maxLength={1000}
          disabled={busy}
          onChange={(event) => set({ password: event.target.value })}
        />
        {draft.password && (
          <Button variant="ghost" onClick={() => setShowTyped((value) => !value)}>
            {showTyped ? t("credentials.hide") : t("credentials.showTyped")}
          </Button>
        )}
      </div>
      {editing && canReveal && (
        <div className={styles.secretRow}>
          {revealed ? (
            <>
              <p className={styles.revealed}>
                {revealed.username} · {revealed.password}
              </p>
              <Button variant="ghost" onClick={() => setRevealed(undefined)}>
                {t("credentials.hide")}
              </Button>
            </>
          ) : (
            <>
              <p className={styles.hint}>
                {revealState === "busy"
                  ? t("credentials.revealing")
                  : revealState === "failed"
                    ? t("credentials.revealFailed")
                    : t("credentials.revealNote")}
              </p>
              <Button
                variant="secondary"
                loading={revealState === "busy"}
                onClick={() => void reveal()}
              >
                {t("credentials.reveal")}
              </Button>
            </>
          )}
        </div>
      )}
      <div className={styles.secretRow}>
        <TextField
          label={t("credentials.totp")}
          type="password"
          value={draft.totp ?? ""}
          autoComplete="new-password"
          maxLength={4096}
          disabled={busy}
          placeholder={
            draft.hasTotp && draft.totp === undefined
              ? t("credentials.totpKeep")
              : t("credentials.totpPlaceholder")
          }
          description={t("credentials.totpHint")}
          onChange={(event) => set({ totp: event.currentTarget.value || undefined })}
        />
        {draft.hasTotp && (
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => set({ totp: draft.totp === null ? undefined : null })}
          >
            {t(draft.totp === null ? "credentials.totpUndoRemove" : "credentials.totpRemove")}
          </Button>
        )}
      </div>
      {draft.totp === null && (
        <p role="status" className={styles.hint}>
          {t("credentials.totpRemoving")}
        </p>
      )}
      <TextField
        label={t("credentials.label")}
        value={draft.label}
        description={t("credentials.labelHint")}
        autoComplete="off"
        maxLength={200}
        disabled={busy}
        onChange={(event) => set({ label: event.target.value })}
      />
      <TextField
        label={t("credentials.note")}
        value={draft.note}
        description={t("credentials.noteHint")}
        autoComplete="off"
        maxLength={1000}
        disabled={busy}
        onChange={(event) => set({ note: event.target.value })}
      />
      <fieldset className={styles.bots}>
        <legend>{t("credentials.bots")}</legend>
        {bots.map((bot) => (
          <label key={bot.id}>
            <input
              type="checkbox"
              checked={draft.botIds.includes(bot.id)}
              disabled={busy}
              onChange={(event) =>
                set({
                  botIds: event.currentTarget.checked
                    ? [...draft.botIds, bot.id]
                    : draft.botIds.filter((id) => id !== bot.id),
                })
              }
            />
            {bot.name}
          </label>
        ))}
      </fieldset>
      <p className={styles.hint}>{t("credentials.botsHint")}</p>
      {!!missing.length && (
        <p role="alert" className={setupStyles.error}>
          {t("credentials.error.required", {
            fields: missing.map((field) => t(`credentials.${field}`)).join("、"),
          })}
        </p>
      )}
      {error && (
        <p role="alert" className={setupStyles.error}>
          {t(error)}
        </p>
      )}
      <div className={setupStyles.row}>
        <Button type="submit" loading={busy} disabled={!peer || !canSave}>
          {t("credentials.save")}
        </Button>
        <Button variant="secondary" disabled={busy} onClick={onCancel}>
          {t("credentials.cancel")}
        </Button>
      </div>
    </form>
  );
}
