import type { AutoCheckFolder, AutoCheckSettings } from "@pibot/protocol";
import type { Peer } from "@pibot/renderer-kit";
import { useCallback, useEffect, useState } from "react";

/**
 * A Bot's automatic check switch and the check commands of one conversation's folder.
 * `null` while unknown (older brain, unknown Bot); other windows follow `autoCheck.changed`.
 */
export function useAutoCheck(
  peer: Pick<Peer, "call" | "on"> | null | undefined,
  botId: string,
  conversationId: string | undefined,
) {
  const [settings, setSettings] = useState<AutoCheckSettings | null>(null);
  const [folder, setFolder] = useState<AutoCheckFolder | null>(null);
  useEffect(() => {
    setSettings(null);
    setFolder(null);
    if (!peer) return;
    let active = true;
    const loadSettings = () =>
      peer.call("autoCheck.get", { botId }).then(
        (value) => {
          if (active) setSettings(value);
        },
        () => {
          // An older brain or an unknown Bot: the section is not shown.
          if (active) setSettings(null);
        },
      );
    const loadFolder = () => {
      if (!conversationId) return;
      void peer.call("autoCheck.folder.get", { botId, conversationId }).then(
        (value) => {
          if (active) setFolder(value);
        },
        () => {
          // Not this Bot's conversation (any more): no folder line.
          if (active) setFolder(null);
        },
      );
    };
    const offs = [
      peer.on("autoCheck.changed", (event) => {
        if (event.reason === "folder") loadFolder();
        else if (event.botId === botId) void loadSettings();
      }),
      peer.on("brain.status", (event) => {
        if (event.state !== "ready") return;
        void loadSettings();
        loadFolder();
      }),
    ];
    void loadSettings();
    loadFolder();
    return () => {
      active = false;
      for (const off of offs) off();
    };
  }, [peer, botId, conversationId]);
  const set = useCallback(
    async (change: { enabled?: boolean; rounds?: number }) => {
      if (!peer) return;
      setSettings(await peer.call("autoCheck.set", { botId, ...change }));
    },
    [peer, botId],
  );
  const setCommands = useCallback(
    async (commands: string[] | null) => {
      if (!peer || !conversationId) return;
      setFolder(await peer.call("autoCheck.folder.set", { botId, conversationId, commands }));
    },
    [peer, botId, conversationId],
  );
  return { settings, folder, set, setCommands };
}
