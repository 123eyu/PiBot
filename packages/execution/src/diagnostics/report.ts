export function diagnosticCommand(platform: NodeJS.Platform, args: readonly string[]): string {
  const quoted = args.map((word) =>
    platform === "win32" ? `'${word.replaceAll("'", "''")}'` : `'${word.replaceAll("'", "'\\''")}'`,
  );
  return `${platform === "win32" ? "& " : ""}${quoted.join(" ")}`;
}

export interface SandboxDiagnosticRow {
  tool: string;
  status: "passed" | "failed" | "skipped";
  durationMs: number;
  reason: string;
  kinds: string[];
  rules: string[];
  signatures: string[];
}

// Only fixed features escape the process output boundary; CLI errors can contain credentials.
export function diagnosticSignatures(output: string): string[] {
  const features: readonly [string, RegExp][] = [
    ["certificate_trust_service", /OSStatus.{0,20}-26276|errSecInternalComponent/i],
    ["system_proxy", /system-configuration[\s\S]{0,160}NULL object/i],
    ["listener_denied", /listen EPERM|bind: Operation not permitted/i],
    ["keychain", /errSecInteractionNotAllowed|-25308/],
    [
      "certificate_verify",
      /certificate signed by unknown authority|CERTIFICATE_VERIFY_FAILED|certificate verify failed/i,
    ],
    ["dns", /getaddrinfo ENOTFOUND|EAI_AGAIN|Could not resolve host/i],
    ["read_only", /Read-only file system|EROFS/i],
    ["permission", /Operation not permitted|EACCES|EPERM|Permission denied/i],
    [
      "login_unavailable",
      /not logged in|unable to locate credentials|authentication required|gh auth login/i,
    ],
    ["dependency_missing", /No module named|command not found|not recognized as/i],
    ["connection", /ECONNREFUSED|Connection refused|ETIMEDOUT|Connection timed out/i],
  ];
  return features.filter(([, expression]) => expression.test(output)).map(([name]) => name);
}

const cell = (text: string) => text.replace(/[|\r\n]/g, " ");

/** The same bilingual, content-free report serves the developer probe and packaged doctor. */
export function sandboxDiagnosticMarkdown(rows: readonly SandboxDiagnosticRow[]): string {
  const status = { passed: "通过 / PASS", failed: "失败 / FAIL", skipped: "跳过 / SKIP" };
  return [
    "| 工具 / Tool | 结果 / Result | 耗时 ms / Duration | 拦截类别 / Kinds | 规则 / Rules | 报错特征 / Features | 原因 / Reason |",
    "| --- | --- | ---: | --- | --- | --- | --- |",
    ...rows
      .map((row) =>
        [
          row.tool,
          status[row.status],
          String(row.durationMs),
          row.kinds.join(", "),
          row.rules.join(", "),
          row.signatures.join(", "),
          row.reason,
        ]
          .map(cell)
          .join(" | "),
      )
      .map((row) => `| ${row} |`),
    "",
  ].join("\n");
}
