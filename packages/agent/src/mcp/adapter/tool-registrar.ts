// Derived from nicobailon/pi-mcp-adapter@5.3.1 (commit efe943e637e503e10af382d0ace1aec834989c69), MIT.
// Copyright (c) 2026 Nico Bailon. Full license: packages/agent/src/mcp/adapter/LICENSE.
// Modified by Pi Bot: host temp directories, global caches and environment switches removed; files and redaction go through Pi Bot ports.
// Upstream file: tool-registrar.ts
// MCP content transformation. Cut: binary resource materialization to the host
// temp directory and its cleanup/retry machinery — Pi Bot round 1 never writes
// model-visible files outside managed workspace ports, so binary blobs are
// omitted with a notice instead. The `scope` parameter is therefore dropped.
import type { ContentBlock, McpContent } from "./types.ts";

type BinaryResource = {
  uri?: string | undefined;
  text?: string | undefined;
  mimeType?: string | undefined;
  blob: string;
};
type McpResourceContent = {
  uri: string;
  text?: string | undefined;
  blob?: string | undefined;
  mimeType?: string | undefined;
  [key: string]: unknown;
};

function replaceBlob(resource: BinaryResource, text: string): string {
  delete (resource as Partial<BinaryResource>).blob;
  resource.text = text;
  return text;
}

function omitBinaryResource(resource: BinaryResource, reason: string): string {
  return replaceBlob(
    resource,
    [
      `[Resource: ${resource.uri ?? "(no URI)"}]`,
      `Binary content omitted: ${reason}`,
      `MIME type: ${resource.mimeType ?? "application/octet-stream"}`,
    ].join("\n"),
  );
}

function omitOversizedBinaryResource(resource: BinaryResource, decodedBytes: number): string {
  return omitBinaryResource(
    resource,
    decodedBytes > 10 * 1024 * 1024 ? "decoded size exceeds 10 MiB" : "not materialized",
  );
}

/**
 * Transform MCP resource contents to Pi content blocks.
 */
export function transformMcpResourceContents(contents: McpResourceContent[]): ContentBlock[] {
  return contents.map((resource) => {
    if (typeof resource.text === "string") return { type: "text" as const, text: resource.text };
    if (typeof resource.blob === "string") {
      const binaryResource = resource as BinaryResource;
      return {
        type: "text" as const,
        text: omitOversizedBinaryResource(
          binaryResource,
          Buffer.byteLength(binaryResource.blob, "base64"),
        ),
      };
    }
    return { type: "text" as const, text: JSON.stringify(resource) };
  });
}

export function transformMcpContent(content: McpContent[]): ContentBlock[] {
  return content.map((c) => {
    if (c.type === "text") {
      return { type: "text" as const, text: c.text ?? "" };
    }
    if (c.type === "image") {
      return {
        type: "image" as const,
        data: c.data ?? "",
        mimeType: c.mimeType ?? "image/png",
      };
    }
    if (c.type === "resource") {
      const resourceUri = c.resource?.uri ?? "(no URI)";
      if (c.resource && "blob" in c.resource && typeof c.resource.blob === "string") {
        const binaryResource = c.resource as typeof c.resource & {
          mimeType?: string;
          blob: string;
        };
        return {
          type: "text" as const,
          text: omitOversizedBinaryResource(
            binaryResource,
            Buffer.byteLength(binaryResource.blob, "base64"),
          ),
        };
      }
      const resourceContent =
        c.resource?.text ?? (c.resource ? JSON.stringify(c.resource) : "(no content)");
      return {
        type: "text" as const,
        text: `[Resource: ${resourceUri}]\n${resourceContent}`,
      };
    }
    if (c.type === "resource_link") {
      const linkName = c.name ?? c.uri ?? "unknown";
      const linkUri = c.uri ?? "(no URI)";
      return {
        type: "text" as const,
        text: `[Resource Link: ${linkName}]\nURI: ${linkUri}`,
      };
    }
    if (c.type === "audio") {
      return {
        type: "text" as const,
        text: `[Audio content: ${c.mimeType ?? "audio/*"}]`,
      };
    }
    return { type: "text" as const, text: JSON.stringify(c) };
  });
}

/**
 * Resolve a tool result's content blocks, appending structuredContent when it
 * coexists with ordinary content and falling back to it when content is empty.
 */
export function resolveMcpResultContent(result: Record<string, unknown>): ContentBlock[] {
  const blocks = transformMcpContent(
    (Array.isArray(result.content) ? result.content : []) as McpContent[],
  );
  if (result.structuredContent !== undefined && result.structuredContent !== null) {
    const structured = stringifyStructuredContent(result.structuredContent);
    if (blocks.length > 0) {
      return [...blocks, { type: "text" as const, text: `structuredContent:\n${structured}` }];
    }
    return [{ type: "text" as const, text: structured }];
  }

  return blocks;
}

function stringifyStructuredContent(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
