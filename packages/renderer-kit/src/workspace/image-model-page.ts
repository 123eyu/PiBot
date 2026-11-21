import { canonicalImageModelId, type ImageModelInfo } from "@pibot/protocol";
import type { Peer } from "../rpc/context.ts";

export async function selectedImageModel(
  peer: Pick<Peer, "call">,
  selected: { provider: string; id: string },
  signal: AbortSignal,
): Promise<ImageModelInfo | undefined> {
  const models = await peer.call("models.images", { availableOnly: true, selected, limit: 1 });
  signal.throwIfAborted();
  return models.find(
    (model) =>
      model.provider === selected.provider &&
      model.id === canonicalImageModelId(selected.provider, selected.id),
  );
}
