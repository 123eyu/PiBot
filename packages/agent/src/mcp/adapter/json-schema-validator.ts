import { createRequire } from "node:module";
// Derived from nicobailon/pi-mcp-adapter@5.3.1 (commit efe943e637e503e10af382d0ace1aec834989c69), MIT.
// Copyright (c) 2026 Nico Bailon. Full license: packages/agent/src/mcp/adapter/LICENSE.
// Modified by Pi Bot: host temp directories, global caches and environment switches removed; files and redaction go through Pi Bot ports.
// Upstream file: json-schema-validator.ts

import type {
  JsonSchemaType,
  JsonSchemaValidator,
  jsonSchemaValidator as JsonSchemaValidatorProvider,
} from "@modelcontextprotocol/client";
import type { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import type { Ajv } from "ajv";

// ajv-formats types target its bundled ajv; the runtime accepts both instances.

// Rust servers built with schemars annotate numbers with these formats. The
// `type`, `minimum`, and `maximum` keywords already carry the constraint, so
// registering them as always-valid only stops Ajv's "unknown format" warnings.
// int32, int64, float, and double are omitted: ajv-formats validates them.
const SCHEMARS_NUMERIC_FORMATS = [
  "int",
  "int8",
  "int16",
  "int128",
  "uint",
  "uint8",
  "uint16",
  "uint32",
  "uint64",
  "uint128",
];

function addKnownFormats(ajv: Ajv): void {
  const addFormats = createRequire(import.meta.url)("ajv-formats") as (instance: Ajv) => void;
  addFormats(ajv);
  for (const format of SCHEMARS_NUMERIC_FORMATS) ajv.addFormat(format, true);
}

type SchemaDialect = { status: "unstamped" } | { status: "stamped"; uri: string };

const DRAFT_07_SCHEMA_URIS: ReadonlySet<string> = new Set([
  "http://json-schema.org/draft-07/schema",
  "https://json-schema.org/draft-07/schema",
]);
const DRAFT_2020_12_SCHEMA_URIS: ReadonlySet<string> = new Set([
  "https://json-schema.org/draft/2020-12/schema",
]);

function schemaDialect(schema: JsonSchemaType): SchemaDialect {
  if (!("$schema" in schema) || typeof schema.$schema !== "string") {
    return { status: "unstamped" };
  }
  return {
    status: "stamped",
    uri: schema.$schema.endsWith("#") ? schema.$schema.slice(0, -1) : schema.$schema,
  };
}

export function createJsonSchemaValidator(): JsonSchemaValidatorProvider {
  let draft07Validator: AjvJsonSchemaValidator | undefined;
  let draft2020Validator: AjvJsonSchemaValidator | undefined;

  return {
    getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T> {
      // CJS entry points keep synchronous validation without loading Ajv on brain startup.
      const require = createRequire(import.meta.url);
      const { AjvJsonSchemaValidator } =
        require("@modelcontextprotocol/client/validators/ajv") as typeof import("@modelcontextprotocol/client/validators/ajv");
      const { Ajv } = require("ajv") as typeof import("ajv");
      const Ajv2020Import = require("ajv/dist/2020.js").default as typeof Ajv;
      const dialect = schemaDialect(schema);
      if (dialect.status === "unstamped" || DRAFT_2020_12_SCHEMA_URIS.has(dialect.uri)) {
        draft2020Validator ??= (() => {
          const Ajv2020 = Ajv2020Import as unknown as typeof Ajv;
          const ajv = new Ajv2020({ strict: false, allErrors: true });
          addKnownFormats(ajv);
          return new AjvJsonSchemaValidator(ajv);
        })();
        return draft2020Validator.getValidator<T>(schema);
      }
      if (!DRAFT_07_SCHEMA_URIS.has(dialect.uri)) {
        throw new Error(`Unsupported JSON Schema dialect: ${dialect.uri}`);
      }

      draft07Validator ??= (() => {
        const ajv = new Ajv({
          strict: false,
          validateFormats: true,
          validateSchema: false,
          allErrors: true,
        });
        addKnownFormats(ajv);
        return new AjvJsonSchemaValidator(ajv);
      })();
      return draft07Validator.getValidator<T>(schema);
    },
  };
}
