import { type MethodParams, RpcError, RpcErrorCodes } from "@pibot/protocol";
import { Button, Icon, IconButton, IconTile } from "@pibot/ui";
import { useEffect, useRef, useState } from "react";
import { hostPlatform } from "../host/platform.ts";
import { useRpc } from "../rpc/context.ts";
import { useT } from "../settings/context.ts";
import { useInPopupMenu } from "./menu-context.ts";

export type RevealFileSource =
  | { groupId: string; folderId?: string }
  | { attachmentId: string; messageId: string }
  | { overflowMessageId: string }
  | MethodParams["changes.reveal"];

export function revealFileLabel(platform = hostPlatform()) {
  return platform === "darwin"
    ? "log.reveal.mac"
    : platform === "win32"
      ? "log.reveal.win"
      : "log.reveal.linux";
}

/** A file identity crosses RPC; the renderer never chooses the host's allowed roots. */
export function RevealFileButton({
  source,
  disabled = false,
  className,
  compact = false,
}: {
  source: RevealFileSource;
  disabled?: boolean;
  className?: string;
  compact?: boolean;
}) {
  const { peer } = useRpc();
  const t = useT();
  const inMenu = useInPopupMenu();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<"failed" | "unsupported">();
  const pending = useRef<AbortController | undefined>(undefined);
  const identity = JSON.stringify(source);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a different peer/file owns a fresh action lifetime.
  useEffect(() => {
    setBusy(false);
    setFailed(undefined);
    return () => {
      pending.current?.abort();
      pending.current = undefined;
    };
  }, [peer, identity]);
  const reveal = async () => {
    if (!peer || disabled || pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setFailed(undefined);
    try {
      const options = { signal: controller.signal, timeoutMs: 20_000 };
      if ("groupId" in source) await peer.call("groups.folders.reveal", source, options);
      else if ("overflowMessageId" in source)
        await peer.call("chat.revealOverflow", { messageId: source.overflowMessageId }, options);
      else if ("attachmentId" in source)
        await peer.call(
          "chat.revealAttachment",
          { id: source.attachmentId, messageId: source.messageId },
          options,
        );
      else await peer.call("changes.reveal", source, options);
    } catch (error) {
      if (!controller.signal.aborted)
        setFailed(
          error instanceof RpcError && error.code === RpcErrorCodes.unsupported
            ? "unsupported"
            : "failed",
        );
    } finally {
      if (pending.current === controller) {
        pending.current = undefined;
        setBusy(false);
      }
    }
  };
  return (
    <>
      {compact ? (
        <IconButton
          data-file-reveal
          label={t(revealFileLabel())}
          title={t(revealFileLabel())}
          disabled={disabled || !peer || busy}
          onClick={() => void reveal()}
        >
          <Icon name="folder" size={14} />
        </IconButton>
      ) : (
        <Button
          data-file-reveal
          variant="ghost"
          className={className}
          disabled={disabled || !peer || busy}
          onClick={() => void reveal()}
        >
          {inMenu ? (
            <IconTile icon="folder" tone="blue" size="sm" />
          ) : (
            <Icon name="folder" size={14} />
          )}
          {t(revealFileLabel())}
        </Button>
      )}
      {failed && (
        <span role="alert">
          {t(failed === "unsupported" ? "log.unsupported" : "log.actionError")}
        </span>
      )}
    </>
  );
}
