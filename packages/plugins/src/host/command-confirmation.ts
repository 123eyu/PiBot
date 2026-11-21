import { homedir } from "node:os";
import type { ConnectorCommandConfirmation } from "@pibot/plugins-contract/full";

/**
 * One readable line, the way the person would type it (maintainers 2026-11-15: the pretty-printed JSON
 * made the dialog hard to read). Display only: the server is started from the stored argv.
 */
function commandLine(command: string, args: readonly string[], platform: NodeJS.Platform) {
  const home = homedir();
  const shown = (word: string) =>
    platform !== "win32" && home && (word === home || word.startsWith(`${home}/`))
      ? `~${word.slice(home.length)}`
      : word;
  const quoted = (word: string) =>
    /^[\w@%+=:,./\\~-]+$/u.test(word)
      ? word
      : platform === "win32"
        ? `'${word.replaceAll("'", "''")}'`
        : `'${word.replaceAll("'", "'\\''")}'`;
  const line = [command, ...args].map((word) => quoted(shown(word))).join(" ");
  // PowerShell needs the call operator for a quoted executable path. Display only, never executed.
  return platform === "win32" ? `& ${line}` : line;
}

/**
 * The native confirmation for a local MCP that runs without the sandbox. The answer is a real
 * click in a system dialog of the desktop's main process: no Bot, YOLO, remembered approval or
 * phone can produce it. Windows and the "run as me" choice share it; only the wording
 * differs, and the run-as-me text names everything the program can then reach.
 */
export function commandConfirmationDialog(
  input: ConnectorCommandConfirmation,
  zh: boolean,
  platform: NodeJS.Platform,
) {
  const command = commandLine(input.command, input.args, platform);
  if (input.mode !== "outside_sandbox")
    return {
      buttons: zh
        ? ["取消", "我知道它能访问整台电脑，继续"]
        : ["Cancel", "Allow access to this computer"],
      title: zh ? "本机 MCP 不隔离运行" : "Local MCP runs without isolation",
      message: zh
        ? "Windows 上这个命令没有沙箱，可以访问整台电脑。"
        : "On Windows this command runs without a sandbox and can access this computer.",
      detail: [
        command,
        ...(input.networkDomains.length
          ? [
              `${zh ? "声明的联网范围不是 Windows 上的隔离保证" : "Declared network domains are not an isolation guarantee on Windows"}: ${input.networkDomains.join(", ")}`,
            ]
          : []),
      ].join("\n\n"),
    };
  const keychain =
    platform === "darwin"
      ? zh
        ? "你的钥匙串和各种登录凭据"
        : "your Keychain and saved credentials"
      : zh
        ? "你的密钥环和各种登录凭据"
        : "your keyring and saved credentials";
  const reach = zh
    ? ["你所有的文件", keychain, "任何网络", "任何程序"]
    : ["all your files", keychain, "any network", "any program"];
  return {
    buttons: zh ? ["取消", "以我的身份运行"] : ["Cancel", "Run as me"],
    title: zh ? "在沙箱外运行这个 MCP（以你的身份）" : "Run this MCP outside the sandbox (as you)",
    // macOS shows `message` bold and `detail` as plain text: a short question, then the command
    // on its own line, then one paragraph (maintainers 2026-11-15: the old dialog was one dense block).
    message: zh ? "以你的身份在沙箱外运行这个 MCP？" : "Run this MCP outside the sandbox, as you?",
    detail: [
      command,
      zh
        ? `它能访问${reach.join("、")}。Bot 调用它的工具时，仍按这个连接的确认方式询问并记录；随时可以在连接详情里关掉。只在你信任这个程序时继续。`
        : `It can reach ${reach.join(", ")}. Every tool call a Bot makes is still checked under this connection's confirmation setting and recorded; you can turn this off in the connection details at any time. Only continue if you trust this program.`,
    ].join("\n\n"),
  };
}
