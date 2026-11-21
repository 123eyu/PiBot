import type { configOption, NewSessionResult, SessionUpdate } from "@pibot/acp-schemas";
import type { AgentSessionOptions } from "@pibot/external-agents-contract";
import type { z } from "zod";

type ConfigOption = z.infer<typeof configOption>;
type Option = { id: string; name: string };

/** Flattens a select option list (grouped or not) into id/name pairs. */
function choices(option: ConfigOption): Option[] {
  const out: Option[] = [];
  for (const entry of option.options ?? []) {
    if ("value" in entry && typeof entry.value === "string")
      out.push({
        id: entry.value,
        name: typeof entry.name === "string" ? entry.name : entry.value,
      });
    else if ("options" in entry && Array.isArray(entry.options))
      for (const item of entry.options) out.push({ id: item.value, name: item.name ?? item.value });
  }
  return out.slice(0, 4096);
}

/** The mode and model pickers a topic shows, from what the agent itself offered. */
export function sessionOptions(state: unknown): AgentSessionOptions {
  const value = (state ?? {}) as Partial<NewSessionResult>;
  const modes = value.modes;
  const mode = modes
    ? {
        current: modes.currentModeId,
        options: modes.availableModes
          .filter((item) => item.id)
          .slice(0, 256)
          .map((item) => ({ id: item.id, name: item.name || item.id })),
      }
    : null;
  // Codex and Claude report the model as a select config option; others may use `models`.
  const config = (value.configOptions ?? []).find(
    (option) => option.id === "model" || (option as { category?: unknown }).category === "model",
  );
  const configChoices = config ? choices(config) : [];
  const model =
    config && typeof config.currentValue === "string" && configChoices.length
      ? { configId: config.id, current: config.currentValue, options: configChoices }
      : value.models
        ? {
            // Empty: these ids belong to ACP `session/set_model`, not to a select setting (Cursor
            // lists bare `composer-2.5` there while its setting wants `composer-2.5[fast=true]`).
            configId: "",
            current: value.models.currentModelId,
            options: value.models.availableModels
              .filter((item) => item.modelId)
              .slice(0, 4096)
              .map((item) => ({ id: item.modelId, name: item.name || item.modelId })),
          }
        : null;
  const settings = (value.configOptions ?? [])
    .filter(
      (option) =>
        option.id !== config?.id &&
        option.id !== "mode" &&
        (option as { category?: unknown }).category !== "mode" &&
        typeof option.currentValue === "string",
    )
    .flatMap((option) => {
      const offered = choices(option).slice(0, 1024);
      if (!offered.length) return [];
      const category = (option as { category?: unknown }).category;
      return [
        {
          configId: option.id,
          name: typeof option.name === "string" ? option.name.slice(0, 200) : option.id,
          kind:
            category === "thought_level"
              ? ("effort" as const)
              : /(^|[-_])fast($|[-_])/.test(option.id)
                ? ("speed" as const)
                : ("other" as const),
          current: option.currentValue as string,
          options: offered,
        },
      ];
    })
    .slice(0, 32);
  return { mode, model, settings, commands: [], refusedModel: null };
}

/** A model id the agent did not list (typed by the user) shown as the current choice. */
export function withCustomModel(options: AgentSessionOptions, id: string): AgentSessionOptions {
  const model = options.model ?? { configId: "", current: id, options: [] };
  return {
    ...options,
    refusedModel: null,
    model: {
      ...model,
      current: id,
      options: model.options.some((item) => item.id === id)
        ? model.options
        : [...model.options, { id, name: id }].slice(-4096),
    },
  };
}

export const withSetting = (
  options: AgentSessionOptions,
  configId: string,
  value: string,
): AgentSessionOptions => ({
  ...options,
  settings: options.settings.map((item) =>
    item.configId === configId ? { ...item, current: value } : item,
  ),
});

/** The user's picks laid over what the agent last offered (only values it actually offers). */
export function withPreferences(
  options: AgentSessionOptions,
  preferences: { mode?: string; model?: string; config?: Record<string, string> },
) {
  let next = options;
  if (preferences.mode && next.mode?.options.some((item) => item.id === preferences.mode))
    next = withMode(next, preferences.mode);
  if (preferences.model && next.model?.options.some((item) => item.id === preferences.model))
    next = withModel(next, preferences.model);
  else if (preferences.model && preferences.model !== next.refusedModel)
    next = withCustomModel(next, preferences.model);
  for (const [configId, value] of Object.entries(preferences.config ?? {}))
    if (
      next.settings.some(
        (item) => item.configId === configId && item.options.some((o) => o.id === value),
      )
    )
      next = withSetting(next, configId, value);
  return next;
}

export const withMode = (options: AgentSessionOptions, id: string): AgentSessionOptions =>
  options.mode ? { ...options, mode: { ...options.mode, current: id } } : options;
export const withModel = (options: AgentSessionOptions, id: string): AgentSessionOptions =>
  options.model ? { ...options, model: { ...options.model, current: id } } : options;

/**
 * What an agent's own option updates change (mode, select settings, slash commands); undefined
 * for every other update. Applied whether or not a turn is running: agents announce their
 * commands right after the session opens.
 */
export function applyOptionUpdate(
  options: AgentSessionOptions,
  update: SessionUpdate,
): AgentSessionOptions | undefined {
  if (update.sessionUpdate === "current_mode_update")
    return withMode(options, update.currentModeId);
  if (update.sessionUpdate === "config_option_update") {
    // The update lists the select options again; the mode (and a `models` model) stay.
    const next = sessionOptions({ configOptions: update.configOptions });
    return { ...options, model: next.model ?? options.model, settings: next.settings };
  }
  if (update.sessionUpdate === "available_commands_update")
    return {
      ...options,
      commands: update.availableCommands.slice(0, 1000).map((command) => ({
        name: command.name.slice(0, 200),
        description: (command.description ?? "").slice(0, 300),
        hint: (command.input?.hint ?? "").slice(0, 200),
      })),
    };
  return undefined;
}
