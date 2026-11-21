import { createHash } from "node:crypto";
import type { JsonSchemaType, JsonSchemaValidator } from "@modelcontextprotocol/client";
import type { ConnectorConnectionFactory } from "@pibot/protocol-base";
import { createJsonSchemaValidator } from "./adapter/json-schema-validator.ts";

export function argumentValidator(): NonNullable<ConnectorConnectionFactory["validateArguments"]> {
  const validators = new Map<string, JsonSchemaValidator<Record<string, unknown>>>();
  return (schema, args) => {
    try {
      if (Buffer.byteLength(JSON.stringify(schema)) > 64 * 1024) return "unsupported";
      const stack: { value: unknown; depth: number }[] = [{ value: schema, depth: 0 }];
      let nodes = 0;
      while (stack.length) {
        const node = stack.pop();
        if (!node || ++nodes > 2000 || node.depth > 24) return "unsupported";
        if (node.value && typeof node.value === "object")
          for (const [name, value] of Object.entries(node.value)) {
            if (
              ["$ref", "$dynamicRef"].includes(name) &&
              (typeof value !== "string" || !value.startsWith("#"))
            )
              return "unsupported";
            stack.push({ value, depth: node.depth + 1 });
          }
      }
      const key = createHash("sha256").update(JSON.stringify(schema)).digest("hex");
      let validate = validators.get(key);
      if (!validate) {
        validate = createJsonSchemaValidator().getValidator<Record<string, unknown>>(
          schema as JsonSchemaType,
        );
        if (validators.size >= 128) {
          const oldest = validators.keys().next().value;
          if (oldest) validators.delete(oldest);
        }
        validators.set(key, validate);
      }
      return validate(args).valid ? "valid" : "invalid";
    } catch {
      return "unsupported";
    }
  };
}
