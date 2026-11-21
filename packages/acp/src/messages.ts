/*
 * Text and translation helpers for the ACP bridge: the card text a person sees, the stop reason
 * ACP understands, and how the interface language resolves.
 */
import type { AcpApproval, AcpMcpPreview } from "./types.ts";

export function language(value: "system" | "zh" | "en") {
  if (value !== "system") return value;
  return Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase().startsWith("zh")
    ? "zh"
    : "en";
}

export function approvalText(approval: AcpApproval, locale: "zh" | "en") {
  const localized = approval.localized?.[locale];
  const title = localized?.title ?? approval.title;
  const facts = localized?.facts ?? approval.facts;
  const details = facts.map((fact) => `${fact.kind}: ${fact.value}`).join("\n");
  return details ? `${title}\n${details}` : title;
}

export function mcpScope(preview: AcpMcpPreview, locale: "zh" | "en") {
  const local = preview.servers.filter((server) => server.transport === "stdio");
  const domains = [...new Set(preview.servers.flatMap((server) => server.networkDomains))];
  const secrets = [...new Set(preview.servers.flatMap((server) => server.secretNames))];
  const lines = preview.servers.map((server) => {
    if (server.transport === "stdio") {
      const command = [server.command, ...(server.args ?? [])].filter(Boolean).join(" ");
      return `${server.id} · stdio · ${command}`;
    }
    return `${server.id} · ${server.transport}`;
  });
  return {
    title:
      locale === "zh"
        ? `导入 MCP 插件「${preview.name.zh}」：${local.length} 个本地命令、${domains.length} 个网络域名、${secrets.length} 个密钥名`
        : `Import MCP plugin “${preview.name.en}”: ${local.length} local command(s), ${domains.length} network domain(s), ${secrets.length} secret name(s)`,
    details: [
      locale === "zh" ? "服务与传输：" : "Servers and transports:",
      ...lines,
      `${locale === "zh" ? "网络" : "Network"}: ${domains.join(", ") || (locale === "zh" ? "无" : "none")}`,
      `${locale === "zh" ? "所需密钥名" : "Required secret names"}: ${secrets.join(", ") || (locale === "zh" ? "无" : "none")}`,
    ].join("\n"),
  };
}

export function stopReason(value: string): "end_turn" | "max_tokens" | "refusal" | "cancelled" {
  if (value === "max_tokens") return "max_tokens";
  if (value === "aborted" || value === "cancelled") return "cancelled";
  if (value === "refusal") return "refusal";
  return "end_turn";
}
