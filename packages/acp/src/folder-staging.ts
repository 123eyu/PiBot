import { waitForResponse } from "./request-wait.ts";
import type { AcpFolderStaging } from "./runtime-rpc.ts";

/** Serialize staged host picks without opening a dialog or sharing a path between requests. */
export function createAcpFolderStaging(): AcpFolderStaging & {
  host(signal: AbortSignal): Promise<string>;
} {
  let selected: string | undefined;
  let tail = Promise.resolve();
  return {
    async host(signal) {
      signal.throwIfAborted();
      if (!selected) throw new Error("ACP folder selection is not staged");
      return selected;
    },
    async withPath(path, action, signal) {
      const before = tail;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      // A cancelled queued pick must not let its successor overtake the active pick.
      tail = before.then(() => gate);
      try {
        await waitForResponse(before, signal);
        signal.throwIfAborted();
        selected = path;
        try {
          return await action();
        } finally {
          selected = undefined;
        }
      } finally {
        release();
      }
    },
  };
}
