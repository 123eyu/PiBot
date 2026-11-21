// 卸载器在用户选择删除配对数据时调用：删掉执行端在 Windows 凭据管理器里的设备种子。
//
// 只删数据目录的话，identity.json 里记录的设备 id 和凭据引用会一起消失，重装后执行端会新建
// 一个设备身份，但旧凭据还留在凭据管理器里；更糟的是老版本（metadata v1）用的是全局账户名，
// 重装后可能又读到同一个种子，等于没有真正解除配对。这里按 identity.json 里记的账户名算出
// just-secrets 用的 target（"secrets:" + 长度框架的十六进制），再用 cmdkey 删除。
//
// 输入只有卸载器传进来的数据目录；账户名先按 identity.ts 的格式校验，不把外部字符串拼进命令。
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";

const SERVICE = "com.pibot.runner";
const LEGACY_ACCOUNT = "device-seed-v1";
const ACCOUNT_PATTERN = /^device-seed-v1(?:-[0-9a-f]{16})?$/u;
const DELETE_TIMEOUT_MS = 10_000;

/** 与 just-secrets 的 windows.ps1 一致：4 字节长度框架 + service + account，转十六进制。 */
function credentialTarget(service, account) {
  const serviceBytes = Buffer.from(service, "utf8");
  const accountBytes = Buffer.from(account, "utf8");
  const framed = Buffer.alloc(4 + serviceBytes.length + accountBytes.length);
  framed.writeUInt16BE(serviceBytes.length, 0);
  framed.writeUInt16BE(accountBytes.length, 2);
  serviceBytes.copy(framed, 4);
  accountBytes.copy(framed, 4 + serviceBytes.length);
  return `secrets:${framed.toString("hex")}`;
}

/** cmdkey 返回非零通常表示条目不存在；对卸载来说这和删除成功一样，不再重试。 */
function deleteCredential(target) {
  const executable = process.env.SystemRoot
    ? join(process.env.SystemRoot, "System32", "cmdkey.exe")
    : "cmdkey.exe";
  return new Promise((resolve) => {
    const child = spawn(executable, [`/delete:${target}`], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), DELETE_TIMEOUT_MS);
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 4096) stderr += chunk.toString("utf8");
    });
    child.once("error", () => {
      clearTimeout(timer);
      resolve(1);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
}

async function main() {
  const dataDir = process.argv[2];
  if (!dataDir) process.exit(0);

  let metadata;
  try {
    metadata = JSON.parse(await readFile(join(dataDir, "identity", "identity.json"), "utf8"));
  } catch {
    // 没启动过、或用的是文件后端（种子加密在 identity.enc.json 里），凭据管理器里没有条目。
    metadata = undefined;
  }
  if (metadata?.backend !== "system") {
    process.stdout.write("No system credential entry to delete.\n");
    process.exit(0);
  }

  const accounts = new Set();
  if (metadata.version === 2) {
    const service = metadata.credential?.service;
    const account = metadata.credential?.account;
    if (service !== SERVICE || typeof account !== "string" || !ACCOUNT_PATTERN.test(account)) {
      process.stdout.write(
        "Identity metadata was not recognized; no credential entry was deleted.\n",
      );
      process.exit(0);
    }
    accounts.add(account);
  } else {
    // v1 元数据没有账户引用，读的是全局名；迁移时还会写一份按数据目录路径派生的名字。
    accounts.add(LEGACY_ACCOUNT);
    try {
      const root = await realpath(dataDir);
      accounts.add(
        `${LEGACY_ACCOUNT}-${createHash("sha256").update(root).digest("hex").slice(0, 16)}`,
      );
    } catch {
      // 数据目录拿不到真实路径时只删全局名，不猜其它名字。
    }
  }

  let failed = 0;
  for (const account of accounts) {
    const target = credentialTarget(SERVICE, account);
    const code = await deleteCredential(target);
    if (code === 0) process.stdout.write(`Deleted credential ${account}.\n`);
    else {
      failed += 1;
      process.stdout.write(`Credential ${account} was not deleted (cmdkey exit ${code}).\n`);
    }
  }
  process.exit(failed === 0 ? 0 : 1);
}
void main().catch(() => {
  process.exitCode = 1;
});
