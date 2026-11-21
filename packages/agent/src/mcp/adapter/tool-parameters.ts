// Derived from nicobailon/pi-mcp-adapter@5.3.1 (commit efe943e637e503e10af382d0ace1aec834989c69), MIT.
// Copyright (c) 2026 Nico Bailon. Full license: packages/agent/src/mcp/adapter/LICENSE.
// Modified by Pi Bot: host temp directories, global caches and environment switches removed; files and redaction go through Pi Bot ports.
// Upstream file: tool-parameters.ts
import { Type } from "typebox";

// OMP remaps `typebox` to a host shim that historically lacked Type.Unsafe.
// Prefer Unsafe when present (real TypeBox / fixed OMP shim); otherwise pass
// the normalized JSON Schema through as a plain object so toolWireSchema and
// validateToolArguments still treat it as JSON Schema.
export function toToolParameters(schema: Record<string, unknown>): unknown {
  return typeof (Type as { Unsafe?: (value: never) => unknown }).Unsafe === "function"
    ? (Type as { Unsafe: (value: never) => unknown }).Unsafe(schema as never)
    : schema;
}
