import { type MethodParams, RpcError } from "@pibot/protocol";
import { actionError, Overlay, useAction, useRpc, useT } from "@pibot/renderer-kit";
import { Button, SegmentedControl } from "@pibot/ui";
import { useState } from "react";
import styles from "../chat.module.css";
import type { BlockWarning } from "./SandboxNotices.tsx";

type Scope = MethodParams["permissions.allowBlockedWebsite"]["scope"];

export function BlockedWebsite({ notice }: { notice: BlockWarning }) {
  const t = useT();
  const { peer } = useRpc();
  const action = useAction();
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState<Scope>();
  const website = notice.sandbox.website;
  const current = website?.groupId ? "group" : "bot";
  const [scope, setScope] = useState<Scope>(current);
  if (!website) return null;
  const confirm = async () => {
    if (!peer) return;
    const result = await action.run(
      (signal) =>
        peer.call(
          "permissions.allowBlockedWebsite",
          { noticeId: notice.id, scope },
          { signal, timeoutMs: 60000 },
        ),
      (error) =>
        error instanceof RpcError && error.message === "website_permission_list_full"
          ? "tool.website.full"
          : error instanceof RpcError &&
              ["website_permission_scope_changed", "website_permission_unavailable"].includes(
                error.message,
              )
            ? "tool.website.unavailable"
            : actionError(error),
    );
    if (result?.network.domains.includes(website.domain)) {
      setSaved(scope);
      setOpen(false);
    } else if (result) {
      action.setError("workspace.failed");
    }
  };
  return (
    <>
      <button
        type="button"
        className={styles.sandboxLink}
        disabled={!peer || action.busy}
        onClick={() => {
          setScope(saved ?? current);
          action.setError(undefined);
          setOpen(true);
        }}
      >
        {t(saved ? "tool.website.saved" : "tool.website.add", { domain: website.domain })}
      </button>
      {open && (
        <div className={styles.sandboxWebsiteDialog}>
          <Overlay
            title={t("tool.website.title")}
            icon="globe"
            tone="green"
            busy={action.busy}
            close={() => setOpen(false)}
            footer={
              <>
                <Button variant="secondary" disabled={action.busy} onClick={() => setOpen(false)}>
                  {t("common.cancel")}
                </Button>
                <Button loading={action.busy} disabled={!peer} onClick={() => void confirm()}>
                  {t("tool.website.confirm")}
                </Button>
              </>
            }
          >
            <p>{t("tool.website.domain", { domain: website.domain })}</p>
            <SegmentedControl<Scope>
              label={t("tool.website.scope")}
              value={scope}
              disabled={action.busy}
              onValueChange={setScope}
              options={[
                {
                  value: current,
                  label: t(current === "group" ? "tool.website.group" : "tool.website.bot"),
                },
                { value: "global", label: t("tool.website.global") },
              ]}
            />
            <p>
              {t(
                scope === "global"
                  ? "tool.website.globalHelp"
                  : current === "group"
                    ? "tool.website.groupHelp"
                    : "tool.website.botHelp",
              )}
            </p>
            <p>{t("tool.website.noRetry")}</p>
            {action.error && <p role="alert">{t(action.error)}</p>}
          </Overlay>
        </div>
      )}
    </>
  );
}
