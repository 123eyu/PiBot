import type { MethodResults } from "@pibot/protocol";
import {
  layoutStyles,
  SettingsLine,
  SettingsRow,
  useComboboxText,
  useRpc,
  useT,
} from "@pibot/renderer-kit";
import { Button, Combobox, Switch } from "@pibot/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PermissionEditorProps } from "./permission-editor.ts";

type HostList = MethodResults["permissions.sshHosts.list"];
type HostEntry = HostList["hosts"][number];

/**
 * Hosts come from the user's own ~/.ssh/config, so the panel only chooses among them; it never
 * creates an alias. A host without an IdentityFile must end up with one of these keys stored,
 * otherwise the recipe refuses to run.
 */
// Newest first: the host must accept the key the panel saves, and some test machines rejected
// id_rsa as the first available key. This is the product order, not OpenSSH's fallback order.
const OPENSSH_IDENTITY_ORDER = ["id_ed25519", "id_ed25519_sk", "id_ecdsa", "id_ecdsa_sk", "id_rsa"];
const REASON_KEYS = {
  proxy: "ssh.reason.proxy",
  match: "ssh.reason.match",
  include_outside_home: "ssh.reason.includeOutsideHome",
  include_in_workspace: "ssh.reason.includeInWorkspace",
  strict_host_key: "ssh.reason.strictHostKey",
  option: "ssh.reason.option",
  user: "ssh.reason.user",
  identity_outside_ssh: "ssh.reason.identityOutsideSsh",
  other: "ssh.reason.other",
} as const;

/**
 * Status names and the reason why a host from the configuration still cannot run. The
 * reason names the line to fix, and a key the panel already preselected is announced instead of
 * asking the person to choose again.
 */
function useHostStatusText() {
  const t = useT();
  return (host: HostEntry, chosen?: string) => {
    if (host.status === "unsupported") {
      const reason = host.reason ?? "other";
      // Only this reason has a name to echo; the others are fixed sentences.
      const text =
        reason === "option" && host.option
          ? t("ssh.reason.option", { option: host.option })
          : t(REASON_KEYS[reason]);
      return t("ssh.status.unsupported", { reason: text });
    }
    if (host.status === "ready") return t("ssh.status.ready");
    return chosen ? t("ssh.status.willUse", { identity: chosen }) : t("ssh.status.needsKey");
  };
}

/**
 * The list is read on demand: ~/.ssh/config is the user's file and can change between panel visits,
 * so each open re-reads it instead of trusting a cached copy.
 */
function useHostList() {
  const { peer } = useRpc();
  const [list, setList] = useState<HostList>();
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const epoch = useRef(0);
  // A click and a window focus can land together; the second caller would only race the first for
  // the same answer, so it waits for the request already on its way. Holds that request's token
  // (0 = idle) so only its owner can free the slot.
  const inFlight = useRef(0);
  const startedAt = useRef(0);
  const load = useCallback(async () => {
    if (!peer || inFlight.current) return;
    const token = ++epoch.current;
    inFlight.current = token;
    startedAt.current = Date.now();
    setLoading(true);
    setFailed(false);
    try {
      const result = await peer.call("permissions.sshHosts.list", undefined);
      if (epoch.current === token) setList(result);
    } catch {
      // Keeping an old list next to an error would show states the panel can no longer confirm.
      if (epoch.current === token) {
        setList(undefined);
        setFailed(true);
      }
    } finally {
      // After a reconnect the request started with the old peer can finish late; it must not free
      // the slot held by the read that replaced it.
      if (inFlight.current === token) inFlight.current = 0;
      if (epoch.current === token) setLoading(false);
    }
  }, [peer]);
  useEffect(() => {
    void load();
    return () => {
      epoch.current++;
      // A reconnect replaces `load`; the request started with the old peer must not keep the new
      // one from reading the file.
      inFlight.current = 0;
    };
  }, [load]);
  return { list, failed, loading, load, startedAt };
}

/**
 * Coming back to the window is when the user is most likely to have just edited ~/.ssh/config, so
 * the panel re-reads it then. Alt-tabbing back and forth would otherwise re-read the file on every
 * focus, hence the interval.
 */
const AUTO_REFRESH_INTERVAL_MS = 2000;

/**
 * The advanced section keeps its children mounted while folded (the `hidden` attribute), so a window
 * focus can arrive while this list is not on screen; a hidden ancestor leaves no offsetParent.
 */
function isListOnScreen(element: HTMLElement | null) {
  return !!element && element.offsetParent !== null;
}

export function SshHosts({ data, disabled, save }: PermissionEditorProps) {
  const t = useT();
  const comboboxText = useComboboxText();
  const statusText = useHostStatusText();
  const { list, failed, loading, load, startedAt } = useHostList();
  const refreshButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const onReturn = () => {
      if (document.visibilityState !== "visible") return;
      if (!isListOnScreen(refreshButton.current)) return;
      if (Date.now() - startedAt.current < AUTO_REFRESH_INTERVAL_MS) return;
      void load();
    };
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, [load, startedAt]);
  const stored = data.sshHosts ?? {};
  const identities = list?.identities ?? [];
  const options = identities.map((name) => ({ value: name, label: name }));
  // Enabling a host has to store the key it will use, so the preselection is also the saved value.
  const defaultIdentity = OPENSSH_IDENTITY_ORDER.find((name) => identities.includes(name));
  // The server merges by alias, so sending only this row cannot drop a host saved elsewhere.
  const write = (alias: string, entry: { enabled: boolean; identity?: string }) =>
    void save({ sshHosts: { [alias]: entry } });
  const unreadable = failed || list?.unavailable === "configuration_unavailable";
  // A rejected shape (wildcard Include, symlinked config) is permanent, not a read to retry.
  const unsupportedConfiguration = !failed && list?.unavailable === "configuration_unsupported";
  const hosts = unreadable || list?.unavailable ? [] : (list?.hosts ?? []);
  return (
    <>
      {/* The sub-page title already names the hosts, so the head is the note and 刷新. */}
      <SettingsLine
        action={
          <Button
            ref={refreshButton}
            variant="secondary"
            className={layoutStyles.small}
            aria-label={t("ssh.refreshLabel")}
            loading={loading}
            disabled={disabled}
            onClick={() => void load()}
          >
            {/* The spinner plus the list below it are the progress state; the label stays put so
                the button does not jump while the read is in flight. */}
            {t("ssh.refresh")}
          </Button>
        }
      >
        {t("ssh.note")}
      </SettingsLine>
      {unreadable && (
        <SettingsLine
          role="alert"
          tone="danger"
          action={
            <Button
              variant="ghost"
              className={layoutStyles.small}
              disabled={disabled || loading}
              onClick={() => void load()}
            >
              {t("common.retry")}
            </Button>
          }
        >
          {t("ssh.error")}
        </SettingsLine>
      )}
      {!list && !unreadable && <SettingsLine role="status">{t("common.loading")}</SettingsLine>}
      {unsupportedConfiguration && (
        <SettingsLine role="status">{t("ssh.unavailable.configurationUnsupported")}</SettingsLine>
      )}
      {list?.unavailable === "unsupported_platform" && (
        <SettingsLine>{t("ssh.unsupportedPlatform")}</SettingsLine>
      )}
      {list && !unreadable && !list.unavailable && !hosts.length && (
        <SettingsLine>{t("ssh.empty")}</SettingsLine>
      )}
      {hosts.map((host) => {
        const setting = stored[host.alias];
        const enabled = setting?.enabled ?? host.enabled;
        const storedIdentity = setting?.identity;
        // Only offer the OpenSSH default when there is a key to offer at all.
        const chosen =
          storedIdentity ??
          (identities.length && host.status === "needs_key" ? defaultIdentity : undefined);
        // Choosing a key makes the row usable before the next read of ~/.ssh/config.
        const statusHost =
          host.status === "needs_key" && storedIdentity
            ? { ...host, status: "ready" as const }
            : host;
        return (
          <SettingsRow
            key={host.alias}
            icon="server"
            tone={host.status === "unsupported" ? "neutral" : "violet"}
            label={host.alias}
            note={statusText(statusHost, storedIdentity ? undefined : chosen)}
          >
            {host.status === "needs_key" && (
              <div className={layoutStyles.select}>
                <Combobox
                  {...comboboxText}
                  variant="pill"
                  hideLabel
                  label={t("ssh.identityFor", { alias: host.alias })}
                  placeholder={t("ssh.chooseIdentity")}
                  options={options}
                  value={chosen ?? ""}
                  // A host whose configuration names its own IdentityFile shows no picker at all.
                  disabled={disabled || !identities.length}
                  onValueChange={(identity) => write(host.alias, { enabled, identity })}
                />
              </div>
            )}
            <Switch
              label={t("ssh.toggle", { alias: host.alias })}
              checked={enabled}
              // A host the recipe cannot serve stays off, but an enabled one must remain switchable so
              // the person can turn it back off after the configuration changed.
              disabled={disabled || (host.status === "unsupported" && !enabled)}
              onCheckedChange={(next) =>
                write(host.alias, {
                  enabled: next,
                  identity: storedIdentity ?? (host.status === "needs_key" ? chosen : undefined),
                })
              }
            />
          </SettingsRow>
        );
      })}
      {hosts.some((host) => host.status === "needs_key") && !identities.length && (
        <SettingsLine>{t("ssh.noIdentities")}</SettingsLine>
      )}
    </>
  );
}
