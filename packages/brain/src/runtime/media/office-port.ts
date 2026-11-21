import type { LocalToolCall, LocalToolResult } from "@pibot/agent";
import type { OfficeToolInput } from "@pibot/protocol-base";
import type { PreparedTool, ToolRunContext } from "../../core/local-types.ts";
import type { LocalService } from "../../local-service.ts";
export interface BinaryToolRun {
  readonly local: LocalService;
  readonly target: LocalService["target"];
  readonly context: ToolRunContext;
  assertDispatch(prepared: PreparedTool): void;
  assertDerivedRead(prepared: PreparedTool, signal: AbortSignal): Promise<void>;
  writeRoots(prepared: PreparedTool): string[];
  approve(call: LocalToolCall, signal: AbortSignal): Promise<PreparedTool | string>;
}
export interface ExtractedOffice {
  text: string;
  totalChars: number;
  scanned: boolean;
  pages: number;
}
/** Binary execution stays behind the engine's authorization and cleanup boundary. */
export interface OfficePort {
  delivery?(
    data: Buffer,
    format: "docx" | "xlsx",
    signal: AbortSignal,
  ): Promise<{
    text: string;
    columns: string[];
    hasChart: boolean;
  }>;
  execute(
    run: BinaryToolRun,
    prepared: PreparedTool,
    input: OfficeToolInput,
    signal: AbortSignal,
  ): Promise<LocalToolResult>;
  extract(data: Buffer, format: "xlsx" | "pptx", signal: AbortSignal): Promise<ExtractedOffice>;
}
