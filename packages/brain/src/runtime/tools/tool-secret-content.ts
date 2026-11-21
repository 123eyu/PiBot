import type { LocalToolDefinition } from "@pibot/agent";

type Schema = {
  $ref?: string;
  type?: string;
  const?: unknown;
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, Schema>;
  items?: Schema;
  anyOf?: Schema[];
  oneOf?: Schema[];
};
/** Only rule out branches we can prove impossible; ambiguity keeps the stricter key scan. */
function possible(schema: Schema, value: unknown): boolean {
  if ("const" in schema && schema.const !== value) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const object = value as Record<string, unknown>;
    if (schema.required?.some((key) => !Object.hasOwn(object, key))) return false;
    for (const [key, child] of Object.entries(schema.properties ?? {}))
      if (Object.hasOwn(object, key) && !possible(child, object[key])) return false;
  }
  if (schema.type === "array" && !Array.isArray(value)) return false;
  if (schema.type === "string" && typeof value !== "string") return false;
  if (schema.type === "null" && value !== null) return false;
  return true;
}

function content(schema: Schema | undefined, value: unknown): unknown {
  // References (including arbitrary recursive JSON), records and unknown schemas remain intact:
  // their keys may be user content, not protocol vocabulary.
  if (!schema || schema.$ref) return value;
  if (schema.properties && value && typeof value === "object" && !Array.isArray(value)) {
    const properties = schema.properties;
    return Object.entries(value).map(([key, item]) =>
      Object.hasOwn(properties, key) ? content(properties[key], item) : { [key]: item },
    );
  }
  const union = schema.anyOf ?? schema.oneOf;
  if (union) {
    const branches = union.filter((branch) => possible(branch, value));
    return branches.length ? branches.map((branch) => content(branch, value)) : value;
  }
  if (Array.isArray(value) && schema.items) return value.map((item) => content(schema.items, item));
  return value;
}

/** Shared by preparation and final dispatch; no second tool/field allowlist to drift. */
export function toolSecretContent(
  tool: string,
  args: unknown,
  definitions: readonly LocalToolDefinition[],
): unknown {
  return content(
    definitions.find((definition) => definition.name === tool)?.parameters as Schema | undefined,
    args,
  );
}
