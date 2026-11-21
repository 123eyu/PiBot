import type { Events, Methods, Peer } from "@pibot/protocol";

/** A detached GUI reply is not a stopped model call; every abnormal exit waits for owner drain. */
export function startMemorySort(peer: Pick<Peer<typeof Methods, typeof Events>, "call">) {
  const runId = crypto.randomUUID();
  const controller = new AbortController();
  let cancellation: Promise<unknown> | undefined;
  const cancel = () => {
    if (!cancellation) {
      cancellation = peer.call("memory.cancelSortIntoPlace", { runId });
      // Also retract a GUI request that has not yet acquired a dispatch slot.
      controller.abort();
    }
    return cancellation;
  };
  const result = peer
    .call("memory.sortIntoPlace", { ownerInitiated: true, runId }, { signal: controller.signal })
    .catch(async (failure: unknown) => {
      await cancel();
      throw failure;
    });
  return { result, cancel };
}
