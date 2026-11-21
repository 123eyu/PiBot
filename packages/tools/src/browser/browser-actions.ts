import type { ComputerStepAction } from "@pibot/protocol-base";
import type { BrowserToolInput } from "../runtime/tool-runtime.ts";

export function describe(
  input: BrowserToolInput,
): { target: string; action: ComputerStepAction } | undefined {
  switch (input.tool) {
    case "browser_open": {
      const subject = safeHost(input.args.url);
      return { target: `open ${subject}`, action: { kind: "open", subject } };
    }
    case "browser_click":
      return {
        target: `click ${"ref" in input.args ? input.args.ref : "screenshot point"}`,
        action: {
          kind: "click",
          subject: "ref" in input.args ? input.args.ref : "screenshot point",
        },
      };
    case "browser_type":
      return {
        target: `type ${input.args.text.length} chars → ${input.args.ref}${input.args.submit ? " + Enter" : ""}`,
        action: {
          kind: "type",
          subject: input.args.ref,
          chars: input.args.text.length,
          ...(input.args.submit ? { submit: true } : {}),
        },
      };
    case "browser_select":
      return {
        target: `select ${input.args.ref}`,
        action: { kind: "select", subject: input.args.ref },
      };
    case "browser_scroll":
      return {
        target: `scroll ${input.args.direction}`,
        action: { kind: "scroll", direction: input.args.direction },
      };
    case "browser_back":
      return { target: "back", action: { kind: "back" } };
    case "browser_close":
      return {
        target: `close ${input.args.tab}`,
        action: { kind: "close_tab", subject: input.args.tab },
      };
    case "browser_screenshot":
      return { target: "screenshot", action: { kind: "screenshot" } };
    default:
      return undefined;
  }
}

export const PICTURED_ACTIONS: ReadonlySet<BrowserToolInput["tool"]> = new Set([
  "browser_open",
  "browser_click",
  "browser_type",
  "browser_select",
  "browser_scroll",
  "browser_back",
]);

export function safeHost(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return "page";
  }
}
