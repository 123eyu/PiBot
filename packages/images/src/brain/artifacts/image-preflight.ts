import type { AgentRuntime } from "@pibot/agent";
import { canonicalImageModelId, type ImageMode, RpcError } from "@pibot/images-contract/full";

export async function requireImageModel(
  agent: AgentRuntime,
  selected: { provider: string; id: string } | undefined,
  mode: ImageMode | undefined,
  signal: AbortSignal,
) {
  if (!selected || !agent.listImageModels) throw new RpcError(-32602, "image_model_unavailable");
  const models = await agent.listImageModels({ availableOnly: true, signal });
  signal.throwIfAborted();
  const model = models.find(
    (m) =>
      m.provider === selected.provider &&
      m.id === canonicalImageModelId(selected.provider, selected.id),
  );
  if (!model) throw new RpcError(-32602, "image_model_unavailable");
  if (mode && !model.modes.includes(mode)) throw new RpcError(-32602, "image_mode_mismatch");
  return model;
}
