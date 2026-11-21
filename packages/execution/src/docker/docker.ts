import { realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileIdentity } from "../core/file-identity.ts";
import { ExecError } from "../core/types.ts";

export type DockerRuntime = "orbstack" | "desktop" | "engine";
export interface DockerConnection {
  runtime: DockerRuntime;
  endpoint: string;
  socket?: string;
  device?: string;
  inode?: string;
}

/** Fixed local endpoints only: never read contexts, registry credentials or DOCKER_HOST. */
export async function resolveDockerConnection(
  platform: NodeJS.Platform,
  home: string,
  runtime: DockerRuntime,
): Promise<DockerConnection> {
  if (platform === "win32") {
    if (runtime !== "desktop") throw new ExecError("docker_unsupported");
    // A named pipe is not a normal file: the CLI reports readiness, without a filesystem probe.
    return { runtime, endpoint: "npipe:////./pipe/docker_engine" };
  }
  const candidate =
    platform === "darwin"
      ? runtime === "orbstack"
        ? join(home, ".orbstack", "run", "docker.sock")
        : runtime === "desktop"
          ? join(home, ".docker", "run", "docker.sock")
          : undefined
      : platform === "linux"
        ? runtime === "desktop"
          ? join(home, ".docker", "desktop", "docker.sock")
          : runtime === "engine"
            ? "/var/run/docker.sock"
            : undefined
        : undefined;
  if (!candidate) throw new ExecError("docker_unsupported");
  try {
    const socket = await realpath(candidate);
    if (/[\p{Cc}\p{Cf}]/u.test(socket)) throw new Error("Invalid socket path");
    const identity = await stat(socket, { bigint: true });
    if (!identity.isSocket()) throw new Error("Not a socket");
    return {
      runtime,
      endpoint: `unix://${socket}`,
      socket,
      ...fileIdentity(identity),
    };
  } catch {
    throw new ExecError("docker_endpoint_unavailable");
  }
}

export async function verifyDockerConnection(
  platform: NodeJS.Platform,
  home: string,
  approved: DockerConnection,
) {
  const current = await resolveDockerConnection(platform, home, approved.runtime);
  if (
    current.endpoint !== approved.endpoint ||
    current.device !== approved.device ||
    current.inode !== approved.inode
  )
    throw new ExecError("docker_endpoint_changed");
}

/** A dedicated Docker channel is not a host shell. No substitutions, pipelines or overrides. */
export function dockerArguments(command: string, platform: NodeJS.Platform): string[] {
  const words: string[] = [];
  let word = "";
  let quote = "";
  let present = false;
  for (let i = 0; i < command.length; i++) {
    const char = command[i] as string;
    if (/[\p{Cc}\p{Cf}$`]/u.test(char)) throw new ExecError("docker_command_invalid");
    if (quote) {
      if (char === quote) quote = "";
      else if (char === "\\" && platform !== "win32" && quote === '"') {
        const next = command[++i];
        if (!next || !/["\\]/.test(next)) throw new ExecError("docker_command_invalid");
        word += next;
      } else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      present = true;
    } else if (/\s/u.test(char)) {
      if (present) {
        words.push(word);
        word = "";
        present = false;
      }
    } else if (/[|&;<>*?[\]{}~]/.test(char)) throw new ExecError("docker_command_invalid");
    else if (char === "\\" && platform !== "win32") {
      const next = command[++i];
      if (!next || /[\p{Cc}\p{Cf}$`]/u.test(next)) throw new ExecError("docker_command_invalid");
      word += next;
      present = true;
    } else {
      word += char;
      present = true;
    }
  }
  if (quote) throw new ExecError("docker_command_invalid");
  if (present) words.push(word);
  if (!/^(?:docker|docker\.exe)$/i.test(words.shift() ?? "") || !words.length)
    throw new ExecError("docker_command_invalid");
  if (words.some((arg) => /^(?:-[Hc].*|--(?:host|context|config|tls[^=]*)(?:=|$))/.test(arg)))
    throw new ExecError("docker_command_invalid");
  return words;
}

/** Output is diagnostic evidence, never instructions or proof of host OS permissions. */
export function dockerFailureHint(output: string): string | undefined {
  if (!/docker/i.test(output)) return undefined;
  if (/(?:command not found|docker: not found|executable file not found)/i.test(output))
    return "未找到 Docker CLI，请检查安装及命令搜索路径 / Docker CLI not found; check installation and command search paths.";
  if (/(?:permission denied|operation not permitted|access is denied)/i.test(output))
    return "Docker 报告访问被拒，不能据此判断是系统权限、配置文件还是沙箱限制。若未申请本机 Docker 能力，请在设置 → 权限 → 本机 Docker 开启，并在下一次命令显式设置 docker=true；不要用 sudo/chmod 或关闭沙箱重试 / Docker reports access denied; this does not identify OS, configuration or sandbox permissions. If local Docker access was not requested, enable Settings → Permissions → Local Docker and explicitly set docker=true on a new request. Do not retry with sudo/chmod or disable isolation.";
  if (
    /(?:cannot connect to the docker daemon|is the docker daemon running|connection refused|no such file or directory|the system cannot find the file specified)/i.test(
      output,
    )
  )
    return "Docker 端点不可连接，请确认所选运行时已启动并就绪、连接配置正确；打开应用不等于服务已经就绪，也不证明需要额外系统权限 / Docker endpoint is unreachable; check runtime readiness and connection configuration. Opening the app does not establish daemon readiness or prove that additional OS permissions are needed.";
  return undefined;
}
