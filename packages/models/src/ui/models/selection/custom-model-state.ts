import type { CustomModel, CustomModelCapabilities } from "@pibot/models-contract/full";

export interface ModelRow {
  rowId: string;
  id: string;
  selected: boolean;
  context: string;
  maxOutput: string;
  images: boolean;
  reasoning: boolean;
  limitsSource?: "provider";
  details: Pick<CustomModel, "name">;
  manual: Record<"context" | "maxOutput" | "images" | "reasoning", boolean>;
  capabilities?: CustomModelCapabilities;
}

export function modelRow(model: CustomModel): ModelRow {
  return {
    rowId: crypto.randomUUID(),
    id: model.id,
    selected: true,
    context: String(model.contextWindow ?? 32768),
    maxOutput: String(model.maxTokens ?? 4096),
    images: model.input?.includes("image") ?? false,
    reasoning: model.reasoning ?? false,
    details: { name: model.name },
    limitsSource: model.limitsSource,
    manual: {
      context: model.contextWindow !== undefined && model.limitsSource !== "provider",
      maxOutput: model.maxTokens !== undefined && model.limitsSource !== "provider",
      images: model.input !== undefined,
      reasoning: model.reasoning !== undefined,
    },
  };
}

export function applyCapabilities(row: ModelRow, capabilities?: CustomModelCapabilities): ModelRow {
  return {
    ...row,
    capabilities,
    context: row.manual.context ? row.context : String(capabilities?.contextWindow ?? 32768),
    maxOutput: row.manual.maxOutput ? row.maxOutput : String(capabilities?.maxTokens ?? 4096),
    images: row.manual.images ? row.images : (capabilities?.input.includes("image") ?? false),
    reasoning: row.manual.reasoning ? row.reasoning : (capabilities?.reasoning ?? false),
  };
}

export function patchModel(row: ModelRow, patch: Partial<ModelRow>): ModelRow {
  const manual = { ...(patch.manual ?? row.manual) };
  for (const field of ["context", "maxOutput", "images", "reasoning"] as const) {
    if (patch[field] !== undefined) manual[field] = true;
  }
  const capabilities = patch.id !== undefined && patch.id !== row.id ? undefined : row.capabilities;
  return applyCapabilities(
    {
      ...row,
      ...patch,
      ...(patch.context !== undefined || patch.maxOutput !== undefined
        ? { limitsSource: undefined }
        : {}),
      manual,
    },
    capabilities,
  );
}

export function modelConfig(row: ModelRow): CustomModel {
  return {
    id: row.id,
    ...row.details,
    ...(row.manual.context ? { contextWindow: Number(row.context) } : {}),
    ...(row.manual.maxOutput ? { maxTokens: Number(row.maxOutput) } : {}),
    ...(row.limitsSource === "provider"
      ? {
          ...(!row.manual.context && row.context ? { contextWindow: Number(row.context) } : {}),
          ...(!row.manual.maxOutput && row.maxOutput ? { maxTokens: Number(row.maxOutput) } : {}),
          limitsSource: "provider" as const,
        }
      : {}),
    ...(row.manual.images ? { input: row.images ? ["text", "image"] : ["text"] } : {}),
    ...(row.manual.reasoning ? { reasoning: row.reasoning } : {}),
  };
}

// Derived catalog values must not mark an untouched form dirty or become manual overrides.
export function modelSnapshot(row: ModelRow) {
  return {
    rowId: row.rowId,
    id: row.id,
    selected: row.selected,
    details: row.details,
    manual: row.manual,
    context: row.manual.context ? row.context : undefined,
    maxOutput: row.manual.maxOutput ? row.maxOutput : undefined,
    images: row.manual.images ? row.images : undefined,
    reasoning: row.manual.reasoning ? row.reasoning : undefined,
  };
}
