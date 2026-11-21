type Schema = Record<string, unknown>;
function object(value: unknown): value is Schema {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Factor repeated constraints without references, for providers that only accept inline schemas. */
export function compactOfficeSchema(
  schema: Schema,
  operationCatalog = false,
  presentationCatalog = false,
): Schema {
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!object(value)) return value;
    const visited = Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, visit(child)]),
    );
    return factorProperties(presentationCatalog ? presentationOutline(visited) : visited);
  };
  const compact = visit(schema) as Schema;
  if (operationCatalog && object(compact.properties)) {
    const operations = compact.properties.operations;
    if (object(operations) && object(operations.items)) {
      // Detailed arguments are discoverable on demand; the execution schema stays strict.
      const names = operationNames(operations.items);
      if (names.length)
        compact.properties.operations = {
          ...operations,
          items: {
            type: "object",
            properties: { op: { type: "string", enum: names } },
            required: ["op"],
            additionalProperties: true,
          },
        };
    }
  }
  return compact;
}
function factorProperties(schema: Schema): Schema {
  const keyword = Array.isArray(schema.oneOf) ? "oneOf" : "anyOf",
    variants = schema[keyword];
  if (schema.properties || !Array.isArray(variants) || variants.length < 2) return schema;
  if (
    !variants.every(
      (v) =>
        object(v) &&
        v.type === "object" &&
        v.additionalProperties === false &&
        object(v.properties),
    )
  )
    return schema;
  const occurrences = new Map<
    string,
    { value: Schema; signature: string; count: number; identical: boolean }
  >();
  for (const variant of variants)
    for (const [name, value] of Object.entries(variant.properties as Schema)) {
      if (!object(value)) continue;
      const signature = JSON.stringify(value),
        previous = occurrences.get(name);
      if (previous) {
        previous.count++;
        previous.identical &&= previous.signature === signature;
      } else occurrences.set(name, { value, signature, count: 1, identical: true });
    }
  const shared = Object.fromEntries(
    [...occurrences]
      .filter(([, item]) => item.identical && item.count > 1 && item.signature.length >= 256)
      .map(([name, item]) => [name, item.value]),
  );
  if (!Object.keys(shared).length) return schema;
  // Branches keep their allowed keys and required lists; identical value constraints apply
  // at the parent as well. Execution still validates the original discriminated zod schema.
  return {
    ...schema,
    type: "object",
    properties: shared,
    [keyword]: variants.map((variant) => ({
      ...variant,
      properties: Object.fromEntries(
        Object.entries(variant.properties as Schema).map(([name, value]) => [
          name,
          Object.hasOwn(shared, name) ? {} : value,
        ]),
      ),
    })),
  };
}

function operationNames(schema: Schema): string[] {
  if (object(schema.properties) && object(schema.properties.op)) {
    const op = schema.properties.op;
    if (typeof op.const === "string") return [op.const];
    if (Array.isArray(op.enum))
      return op.enum.filter((name): name is string => typeof name === "string");
  }
  return [schema.anyOf, schema.oneOf].flatMap((variants) =>
    Array.isArray(variants)
      ? variants.flatMap((variant) => (object(variant) ? operationNames(variant) : []))
      : [],
  );
}

function presentationOutline(schema: Schema): Schema {
  const properties = schema.properties;
  if (
    !object(properties) ||
    !object(properties.kind) ||
    properties.kind.const !== "pptx" ||
    !object(properties.slides)
  )
    return schema;
  // PPT creation details are discovered with capabilities; execution still uses full zod.
  return {
    ...schema,
    properties: {
      kind: properties.kind,
      title: properties.title,
      slides: { ...properties.slides, items: { type: "object", additionalProperties: true } },
    },
    additionalProperties: true,
  };
}
