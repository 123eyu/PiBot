import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, open, readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

// 首次构建要下载 electron-builder 的 NSIS bundle（约 30 MB），给足时间。
const NSIS_TIMEOUT_MS = 600_000;
// 打包好的执行端加内置 Node 有几十 MB，比这小得多的东西一定不是安装包。
const MIN_INSTALLER_BYTES = 1_000_000;

export type WindowsTarget = { platform: "win32"; arch: "x64" | "arm64" };

export type InstallerBuild = {
  target: WindowsTarget;
  /** pnpm runner:package 产出的目录，安装包的内容就是它 */
  directory: string;
  /** 打包输出根目录（dist/runner），安装包放在它的 installer/ 子目录里 */
  output: string;
  /** 桌面版本号，规格要求安装包版本与桌面一致 */
  version: string;
  repo: string;
  /** --makensis 显式指定的 makensis，CI 或已经装好 NSIS 的机器用 */
  makensis?: string | undefined;
  /** T1 supplies the real SEA basename; omitted for the legacy directory layout. */
  executable?: string | undefined;
};

/** 产物名；arm64 不在本期范围，但 --all 会两个架构都试，加后缀免得互相覆盖。 */
export function installerArtifact(output: string, version: string, arch: WindowsTarget["arch"]) {
  const suffix = arch === "x64" ? "" : ` (${arch})`;
  return join(output, "installer", `Pi Bot Runner Setup ${version}${suffix}.exe`);
}

export async function buildWindowsInstaller(options: InstallerBuild) {
  if (options.executable && !/^[A-Za-z0-9._-]+\.exe$/iu.test(options.executable))
    throw new Error("Invalid runner SEA executable basename");
  await verifyRunnerDirectory(options.directory, options.target.arch, options.executable);
  const tool = await makensis(options.repo, options.makensis);
  const artifact = installerArtifact(options.output, options.version, options.target.arch);
  await mkdir(dirname(artifact), { recursive: true });
  await run(
    tool.path,
    [
      "-INPUTCHARSET",
      "UTF8",
      `-DPIBOT_VERSION=${options.version}`,
      `-DPIBOT_VERSION_QUAD=${versionQuad(options.version)}`,
      `-DPIBOT_SOURCE=${options.directory}`,
      `-DPIBOT_OUT=${artifact}`,
      ...(options.executable ? [`-DPIBOT_SEA_EXECUTABLE=${options.executable}`] : []),
      `-DPIBOT_ICON=${join(options.repo, "apps", "desktop", "build", "icon.ico")}`,
      join(options.repo, "apps", "runner", "installer", "windows", "installer.nsi"),
    ],
    { cwd: options.repo, env: { ...process.env, ...tool.env } },
  );
  await verifyArtifact(artifact);
  process.stdout.write(`runner installer size: ${(await stat(artifact)).size} bytes\n`);
  process.stdout.write(`runner installer: ${artifact}\n`);
  return artifact;
}

/** 安装包只能基于同一平台的目录产物生成，缺文件时早点报错，别等 makensis 编到一半。 */
async function verifyRunnerDirectory(
  directory: string,
  arch: WindowsTarget["arch"],
  executable?: string,
) {
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as {
    platform?: unknown;
    arch?: unknown;
  };
  if (manifest.platform !== "win32" || manifest.arch !== arch)
    throw new Error(
      `Installers need a win32-${arch} runner package; ${directory} is ${String(manifest.platform)}-${String(manifest.arch)}`,
    );
  for (const file of executable
    ? [executable]
    : ["pibot.cmd", "app/dist/runner.js", "runtime/node.exe"])
    await access(join(directory, file));
}

/**
 * 用 electron-builder 自带的那套 NSIS（不引入新的安装器工具）。
 * app-builder-lib 负责版本、校验和与缓存位置，`getMakeNsisPath` 返回的 env 里带着 NSISDIR，
 * makensis 靠它找到自己的 includes 和插件。
 */
async function makensis(repo: string, override: string | undefined) {
  if (override) {
    await access(override, constants.X_OK);
    return { path: override, env: {} as NodeJS.ProcessEnv };
  }
  // 下载缓存跟着仓库走（和 apps/desktop 的打包脚本一样），CI 和本机不用各自再下一份。
  process.env.ELECTRON_BUILDER_CACHE ??= join(repo, ".cache", "electron-builder");
  const require = createRequire(import.meta.url);
  try {
    const toolset = require("app-builder-lib/out/toolsets/windows.js") as {
      getMakeNsisPath: (
        nsis?: string | null,
      ) => Promise<{ path: string; env?: Record<string, string> }>;
    };
    const tool = await toolset.getMakeNsisPath(null);
    return { path: tool.path, env: (tool.env ?? {}) as NodeJS.ProcessEnv };
  } catch (error) {
    // 离线机器、或者 devDependency 没装时，说明白缺什么、能用什么替代。
    throw new Error(
      `Could not prepare NSIS (app-builder-lib is required and may need to download the NSIS bundle): ${
        error instanceof Error ? error.message : String(error)
      }. Pass --makensis <path> to use an installed makensis.`,
      { cause: error },
    );
  }
}

async function run(
  program: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(program, args, {
      ...options,
      shell: false,
      stdio: "inherit",
      signal: AbortSignal.timeout(NSIS_TIMEOUT_MS),
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolvePromise()
        : reject(new Error(`${program} exited with ${code ?? "signal"}`)),
    );
  });
}

/** 只认「有内容、而且是 Windows 可执行文件」的产物，makensis 报 0 不代表写出了东西。 */
async function verifyArtifact(artifact: string) {
  const info = await stat(artifact).catch(() => undefined);
  if (!info || info.size < MIN_INSTALLER_BYTES)
    throw new Error(`NSIS did not produce a usable installer at ${artifact}`);
  const handle = await open(artifact, "r");
  try {
    const header = Buffer.alloc(2);
    await handle.read(header, 0, header.length, 0);
    if (header.toString("latin1") !== "MZ")
      throw new Error(`Installer at ${artifact} is not a Windows executable`);
  } finally {
    await handle.close();
  }
}

/** VIProductVersion 只接受四段数字，版本号里的预发布后缀和多余段在这里被规范化。 */
export function versionQuad(version: string) {
  const parts = version.split(/[.+-]/u).slice(0, 3);
  while (parts.length < 3) parts.push("0");
  return `${parts.map((part) => (/^\d+$/u.test(part) ? part : "0")).join(".")}.0`;
}
