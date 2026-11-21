import type { ClaudePluginComponent } from "@pibot/protocol-base";

/**
 * One policy table drives both host preview/exclusion and brain final validation.
 * Imported manifests cannot extend this trusted application-owned list.
 */
export const unsupportedClaudePluginComponents = [
  {
    path: "hooks",
    kind: "hook",
    reason: "policy-bypass",
    manifestFields: ["hooks"],
    experimentalFields: [],
  },
  {
    path: "monitors",
    kind: "monitor",
    reason: "policy-bypass",
    manifestFields: ["monitors"],
    experimentalFields: ["monitors"],
  },
  {
    path: "bin",
    kind: "bin",
    reason: "executable",
    manifestFields: ["bin"],
    experimentalFields: [],
  },
  {
    path: "agents",
    kind: "agent",
    reason: "not-supported",
    manifestFields: ["agents"],
    experimentalFields: [],
  },
  {
    path: ".lsp.json",
    kind: "lsp",
    reason: "not-supported",
    manifestFields: ["lspServers"],
    experimentalFields: [],
  },
  {
    path: "output-styles",
    kind: "output-style",
    reason: "not-supported",
    manifestFields: ["outputStyles"],
    experimentalFields: [],
  },
  {
    path: "themes",
    kind: "theme",
    reason: "not-supported",
    manifestFields: ["themes"],
    experimentalFields: [],
  },
  {
    path: "workflows",
    kind: "workflow",
    reason: "not-supported",
    manifestFields: ["workflows"],
    experimentalFields: [],
  },
  {
    path: "pibot.json",
    kind: "pibot",
    reason: "not-supported",
    manifestFields: ["pibot.json"],
    experimentalFields: [],
  },
] as const satisfies readonly {
  path: string;
  kind: ClaudePluginComponent["kind"];
  reason: NonNullable<ClaudePluginComponent["reason"]>;
  manifestFields: readonly string[];
  experimentalFields: readonly string[];
}[];
