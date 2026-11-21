import type { SandboxBlock } from "@pibot/execution";
import type { Platform } from "@pibot/policy";

// Output is untrusted: a signature explains a possible cause, never creates block evidence or a
// permission. Recovery offers depend exclusively on the execution layer's recorded block.
const SIGNATURES = [
  {
    pattern: /OSStatus\s*[:=]?\s*-26276|errSecInternalComponent/i,
    reason:
      "证书信任评估失败，可能无法访问系统证书信任服务；这不证明证书无效。 / Certificate trust evaluation failed; the system trust service may be unavailable. This does not prove the certificate is invalid.",
  },
  {
    pattern: /system-configuration[\s\S]{0,500}NULL object/i,
    reason:
      "读取系统代理配置失败，工具可能无法访问系统配置服务。 / Reading system proxy configuration failed; the tool may be unable to reach the system configuration service.",
  },
  {
    pattern: /listen\s+EPERM|bind:\s*Operation not permitted/i,
    reason:
      "工具尝试绑定或监听端口，沙箱可能不支持这项操作；绑定失败不等于外网被拦。 / The tool tried to bind or listen on a port; the sandbox may not support that operation. A bind failure does not mean internet access was blocked.",
  },
  {
    pattern: /errSecInteractionNotAllowed|(?:OSStatus\s*[:=]?\s*)?-25308\b/i,
    reason:
      "钥匙串交互不可用；不要读取、复制或让用户粘贴凭据。 / Keychain interaction is unavailable; do not read or copy credentials or ask the user to paste them.",
  },
  {
    pattern: /x509:\s*certificate signed by unknown authority|CERTIFICATE_VERIFY_FAILED/i,
    reason:
      "HTTPS 证书校验失败，可能是证书链或系统信任服务问题；不要关闭 TLS 校验或自动安装 CA。 / HTTPS certificate verification failed, possibly because of the certificate chain or system trust service. Do not disable TLS verification or automatically install a CA.",
  },
] as const;

const REPORT =
  "没有可用的已确认处理路径：如实告诉用户原因，不要原样反复试错。 / No confirmed recovery is available: tell the user the reason plainly instead of repeatedly retrying unchanged.";
const OUTSIDE =
  "用 run_command 的 outsideSandbox: true 重跑同一条命令（同一工作目录），会请用户确认沙箱外运行一次。 / Rerun the same command in the same folder with run_command outsideSandbox: true; the user will be asked to confirm one run outside the sandbox.";

export function sandboxSignatureGuidance(
  output: string,
  platform: Platform,
  block: SandboxBlock | undefined,
  offerOutside: boolean,
  network?: { allowAll: boolean; domains: readonly string[] },
): string | undefined {
  const signature = SIGNATURES.find(({ pattern }) => pattern.test(output));
  const lookup = /getaddrinfo\s+ENOTFOUND(?:\s+([A-Za-z0-9.-]{1,253})(?![A-Za-z0-9.-]))?/i.exec(
    output,
  );
  const host = lookup?.[1]?.toLowerCase().replace(/\.$/, "");
  const outsideDomains =
    host &&
    host !== "localhost" &&
    host !== "127.0.0.1" &&
    network?.allowAll === false &&
    !network.domains.some((entry) => {
      // DNS has no destination port. A port-restricted entry still permits looking up that host.
      const domain = entry.toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
      return (
        domain === "*" ||
        domain === host ||
        (domain.startsWith("*.") && host.endsWith(domain.slice(1)))
      );
    });
  const dns = !!lookup && (block?.kinds.includes("network") || outsideDomains);
  const protectedName =
    /Read-only file system|Operation not permitted/i.test(output) &&
    block?.kinds.includes("protected_name");
  const reason =
    signature?.reason ??
    (dns
      ? "域名解析失败，目标不在本次允许的网站范围内或已有联网拦截记录；请用户核对联网设置，不要原样反复重试。 / Name resolution failed: the target is outside this call's allowed sites or a network block was recorded. Ask the user to check network settings instead of repeatedly retrying unchanged."
      : protectedName
        ? "沙箱拒绝写入受保护名称；不要用 chmod、sudo 或换路径绕过。 / The sandbox refused a protected name write; do not bypass it with chmod, sudo or another path."
        : undefined);
  if (!reason) return undefined;
  const localOnly = block?.kinds.every((kind) => kind === "local_service" || kind === "other");
  const next =
    offerOutside && platform === "darwin" && localOnly && block?.kinds.includes("local_service")
      ? "原样重跑同一条命令（同一工作目录、不加 outsideSandbox）会请用户允许这一个本机服务。 / Rerun the same command unchanged in the same folder, without outsideSandbox; the user will be asked to allow this one local service."
      : offerOutside
        ? OUTSIDE
        : REPORT;
  return `${reason}\n${next}`;
}
