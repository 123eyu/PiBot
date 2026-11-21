import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { AgentError, mapAgentError } from "../core/errors.ts";
import type { AgentRuntimeDeps, AuxiliaryPurpose } from "../core/types.ts";

type TextModel = Awaited<ReturnType<ModelRuntime["getAvailable"]>>[number];
type ModelRef = Pick<TextModel, "provider" | "id">;
const FALLBACK_CODES = ["no_model", "auth_failed", "context_too_large"];

/** Selection never retries a generated response: fallback is decided before dispatch. */
export function createAuxiliaryModelSelector(
  deps: Pick<AgentRuntimeDeps, "auxiliaryModel" | "auxiliaryModelFallback">,
  injectKey: (runtime: ModelRuntime, provider: string) => Promise<void>,
) {
  async function configured(
    runtime: ModelRuntime,
    auxiliary: ModelRef,
    signal: AbortSignal,
    fits: (model: TextModel) => boolean,
  ) {
    const model = (await runtime.getAvailable(auxiliary.provider, { signal })).find(
      (entry) => entry.id === auxiliary.id,
    );
    signal.throwIfAborted();
    if (!model) throw new AgentError("no_model");
    if (!fits(model)) throw new AgentError("context_too_large");
    await injectKey(runtime, model.provider);
    signal.throwIfAborted();
    if (!(await runtime.getAuth(model, { signal }))) throw new AgentError("auth_failed");
    signal.throwIfAborted();
    return model;
  }
  const select = async (
    runtime: ModelRuntime,
    primary: ModelRef,
    purpose: AuxiliaryPurpose,
    signal: AbortSignal,
    fits: (model: TextModel) => boolean = () => true,
  ): Promise<TextModel> => {
    signal = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
    signal.throwIfAborted();
    const auxiliary = deps.auxiliaryModel?.();
    if (auxiliary && (auxiliary.provider !== primary.provider || auxiliary.id !== primary.id)) {
      try {
        return await configured(runtime, auxiliary, signal, fits);
      } catch (error) {
        signal.throwIfAborted();
        const code = mapAgentError(error);
        if (!FALLBACK_CODES.includes(code)) throw error;
        deps.auxiliaryModelFallback?.(purpose, code);
      }
    }
    const model = (await runtime.getAvailable(primary.provider, { signal })).find(
      (entry) => entry.id === primary.id,
    );
    signal.throwIfAborted();
    if (!model) throw new AgentError("no_model");
    await injectKey(runtime, model.provider);
    signal.throwIfAborted();
    return model;
  };
  /**
   * Work that is only worth doing on the cheap model (web page extraction) never falls
   * back to the Bot's main model; the caller keeps its non-model behaviour instead.
   */
  select.only = async (
    runtime: ModelRuntime,
    purpose: AuxiliaryPurpose,
    signal: AbortSignal,
    fits: (model: TextModel) => boolean = () => true,
  ): Promise<TextModel> => {
    signal = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
    signal.throwIfAborted();
    const auxiliary = deps.auxiliaryModel?.();
    if (!auxiliary) throw new AgentError("no_model");
    try {
      return await configured(runtime, auxiliary, signal, fits);
    } catch (error) {
      signal.throwIfAborted();
      const code = mapAgentError(error);
      if (FALLBACK_CODES.includes(code)) deps.auxiliaryModelFallback?.(purpose, code);
      throw error;
    }
  };
  return select;
}
