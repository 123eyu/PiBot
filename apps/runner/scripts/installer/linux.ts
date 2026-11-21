import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  chmod,
  cp,
  mkdir,
  open,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

// 首次构建要下载 electron-builder 的 fpm（约 30 MB，含自带 ruby），给足时间。
const FPM_TIMEOUT_MS = 600_000;
// 执行端加内置 Node 有几十 MB，比这小得多的东西一定不是安装包。
const MIN_INSTALLER_BYTES = 1_000_000;
const PACKAGE_NAME = "pibot-runner";
const INSTALL_ROOT = "/opt/pibot-runner";

type LinuxPackageType = "deb" | "rpm";

export type LinuxTarget = { platform: "linux"; arch: "x64" | "arm64" };

export type LinuxInstallerBuild = {
  target: LinuxTarget;
  /** pnpm runner:package 产出的目录，安装包的内容就是它 */
  directory: string;
  /** 打包输出根目录（dist/runner），安装包放在它的 installer/ 子目录里 */
  output: string;
  /** 桌面版本号，规格要求安装包版本与桌面一致 */
  version: string;
  repo: string;
  /** --fpm 显式指定的 fpm，已经装好 fpm / rpmbuild 的机器用 */
  fpm?: string | undefined;
};

/** 产物名：deb 用 Debian 的 <name>_<version>_<arch>.deb，rpm 用 <name>-<version>.<arch>.rpm。 */
export function linuxArtifact(
  output: string,
  version: string,
  arch: LinuxTarget["arch"],
  type: LinuxPackageType,
) {
  return type === "deb"
    ? join(output, "installer", `${PACKAGE_NAME}_${version}_${linuxArch(arch, "deb")}.deb`)
    : join(output, "installer", `${PACKAGE_NAME}-${version}.${linuxArch(arch, "rpm")}.rpm`);
}

/**
 * 出 deb 和 rpm (要求同一个 --installer 两个都产)。
 * deb 在 macOS 上构建由 electron-builder 带的 linux 工具集支撑；rpm 需要 rpmbuild，
 * macOS 上默认没有，缺它时跳过 rpm 并打印在 Linux 上构建的命令，而不是让整个打包失败。
 */
export async function buildLinuxInstallers(options: LinuxInstallerBuild) {
  await verifyRunnerDirectory(options.directory, options.target.arch, options.repo);
  const staging = join(options.output, `.stage-linux-${options.target.arch}`);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  try {
    await stageTree(options, staging);
    // Even --fpm still needs the macOS deb tools, so set the cache before either lookup.
    process.env.ELECTRON_BUILDER_CACHE ??= join(options.repo, ".cache", "electron-builder");
    const fpm = await fpmPath(options.fpm);
    const artifacts: string[] = [];
    const deb = linuxArtifact(options.output, options.version, options.target.arch, "deb");
    await mkdir(dirname(deb), { recursive: true });
    await runFpm(fpm, fpmArgs("deb", options, staging, deb), await fpmEnvironment("deb"));
    await verifyArtifact(deb, "deb");
    artifacts.push(deb);
    if (await hasRpmbuild()) {
      const rpm = linuxArtifact(options.output, options.version, options.target.arch, "rpm");
      await runFpm(fpm, fpmArgs("rpm", options, staging, rpm), await fpmEnvironment("rpm"));
      await verifyArtifact(rpm, "rpm");
      artifacts.push(rpm);
    } else {
      process.stdout.write(
        "runner installer: rpm 跳过 / skipped - 没有 rpmbuild。\n" +
          "  在装了 rpmbuild 的 Linux 主机上构建 / build on a Linux host with rpmbuild:\n" +
          `    pnpm runner:package -- --installer --platform linux --arch ${options.target.arch}\n` +
          "  macOS 上先装 rpm / install rpm first on macOS: brew install rpm\n" +
          "  （也可以用已装好的 fpm + rpmbuild：--fpm <path>，确保 rpmbuild 在 PATH 里）\n",
      );
    }
    for (const artifact of artifacts) process.stdout.write(`runner installer: ${artifact}\n`);
    return artifacts;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

function linuxArch(arch: LinuxTarget["arch"], type: LinuxPackageType) {
  if (type === "deb") return arch === "x64" ? "amd64" : "arm64";
  return arch === "x64" ? "x86_64" : "aarch64";
}

/** 安装包只能基于同一平台的目录产物生成，缺文件时早点报错，别等 fpm 跑完才失败。 */
async function verifyRunnerDirectory(directory: string, arch: LinuxTarget["arch"], repo: string) {
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as {
    platform?: unknown;
    arch?: unknown;
  };
  if (manifest.platform !== "linux" || manifest.arch !== arch)
    throw new Error(
      `Installers need a linux-${arch} runner package; ${directory} is ${String(manifest.platform)}-${String(manifest.arch)}`,
    );
  for (const file of ["pibot", "resources/package.json"]) await access(join(directory, file));
  await access(join(directory, "pibot"), constants.X_OK);

  for (const script of ["postinst.sh", "prerm.sh", "postrm.sh"])
    await access(join(repo, "apps", "runner", "installer", "linux", script));
}

/**
 * 把执行端目录摆成安装后的样子：/opt/pibot-runner、/usr/bin/pibot 软链接、
 * /usr/lib/systemd/user 的用户单元。fpm 的 -s dir 直接按这棵树打包。
 */
async function stageTree(options: LinuxInstallerBuild, staging: string) {
  const root = join(staging, INSTALL_ROOT);
  await cp(options.directory, root, { recursive: true });
  // 产物目录是从开发机拷来的（属主 501/staff，可执行位按工具链来）。安装后归 root：
  // 目录 755、普通文件 644、可执行文件 755，否则普通用户读不到也跑不了。
  await normalizeModes(root);
  const unitDir = join(staging, "usr", "lib", "systemd", "user");
  await mkdir(unitDir, { recursive: true });
  const unit = join(options.repo, "apps", "runner", "installer", "linux", "pibot-runner.service");
  await cp(unit, join(unitDir, "pibot-runner.service"));
  await chmod(join(unitDir, "pibot-runner.service"), 0o644);
  await chmod(unitDir, 0o755);
  // 保留系统入口；单文件主程序从自身所在目录加载 resources。
  const binDir = join(staging, "usr", "bin");
  await mkdir(binDir, { recursive: true });
  await chmod(binDir, 0o755);
  await symlink(join(INSTALL_ROOT, "pibot"), join(binDir, "pibot"), "file");
}

async function normalizeModes(directory: string) {
  await chmod(directory, 0o755);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) await normalizeModes(path);
    else await chmod(path, ((await stat(path)).mode & 0o111) !== 0 ? 0o755 : 0o644);
  }
}

function fpmArgs(
  type: LinuxPackageType,
  options: LinuxInstallerBuild,
  staging: string,
  artifact: string,
) {
  const scripts = join(options.repo, "apps", "runner", "installer", "linux");
  const args = [
    "-s",
    "dir",
    "-t",
    type,
    "--force",
    "--chdir",
    staging,
    "--package",
    artifact,
    "--name",
    PACKAGE_NAME,
    "--version",
    options.version,
    "--architecture",
    linuxArch(options.target.arch, type),
    "--maintainer",
    "Pi Bot <noreply@pibot.space>",
    "--vendor",
    "Pi Bot",
    "--url",
    "https://pibot.space",
    "--license",
    "UNLICENSED",
    "--description",
    "Pi Bot runner: runs commands and file tools for a paired desktop",
    // 沙箱要 bubblewrap，Linux 上的隔离探测要用 socat。
    "--depends",
    "bubblewrap",
    "--depends",
    "socat",
    "--after-install",
    join(scripts, "postinst.sh"),
    "--before-remove",
    join(scripts, "prerm.sh"),
    "--after-remove",
    join(scripts, "postrm.sh"),
  ];
  if (type === "deb") {
    // 安装目录必须是 root 拥有；打包机上的属主（501/staff）不能被带进包。
    args.push("--deb-user", "root", "--deb-group", "root", "--deb-priority", "optional");
  } else {
    args.push(
      "--rpm-user",
      "root",
      "--rpm-group",
      "root",
      "--rpm-summary",
      "Pi Bot runner",
      "--category",
      "Applications/System",
    );
  }
  // 安装树里的顶层目录；fpm 把它们映射到 /opt 和 /usr。
  args.push("opt", "usr");
  return args;
}

/**
 * 用 electron-builder 自带的那套 fpm（不引入新的安装器工具）。
 * deb 在 macOS 上要 electron-builder 的 linux 工具集（ar / tar），它随 app-builder-lib 一起
 * 下载；rpm 需要系统的 rpmbuild，所以调用方先检查。
 */
async function fpmPath(override: string | undefined) {
  if (override) {
    await access(override, constants.X_OK);
    return override;
  }
  const require = createRequire(import.meta.url);
  try {
    const toolset = require("app-builder-lib/out/toolsets/linux.js") as {
      getFpmPath: () => Promise<string>;
    };
    return await toolset.getFpmPath();
  } catch (error) {
    throw new Error(
      `Could not prepare fpm (app-builder-lib is required and may need to download the fpm bundle): ${
        error instanceof Error ? error.message : String(error)
      }. Pass --fpm <path> to use an installed fpm.`,
      { cause: error },
    );
  }
}

async function fpmEnvironment(type: LinuxPackageType) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (type !== "deb" || process.platform !== "darwin") return env;
  const require = createRequire(import.meta.url);
  const toolset = require("app-builder-lib/out/toolsets/linux.js") as {
    getLinuxToolsPath: () => Promise<string>;
  };
  const path = await toolset.getLinuxToolsPath();
  // fpm 写 deb 要用 Linux 版的 ar / tar，BSD 版不兼容；这与 electron-builder 的 deb 目标一致。
  env.PATH = [join(path, "bin"), env.PATH].filter(Boolean).join(":");
  env.DYLD_LIBRARY_PATH = [join(path, "lib"), env.DYLD_LIBRARY_PATH].filter(Boolean).join(":");
  return env;
}

/** rpmbuild 是 rpm 输出的硬依赖（fpm 只是它的包装）；没有它就别让 fpm 跑一半失败。 */
async function hasRpmbuild() {
  return await new Promise<boolean>((resolve) => {
    const child = spawn("rpmbuild", ["--version"], { stdio: "ignore", shell: false });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

async function runFpm(program: string, args: string[], env: NodeJS.ProcessEnv) {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(program, args, {
      env,
      shell: false,
      stdio: "inherit",
      signal: AbortSignal.timeout(FPM_TIMEOUT_MS),
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolvePromise()
        : reject(new Error(`${program} exited with ${code ?? "signal"}`)),
    );
  });
}

/** 只认「有内容、而且文件头对得上」的产物，fpm 报 0 不代表写出了东西。 */
async function verifyArtifact(artifact: string, type: LinuxPackageType) {
  const info = await stat(artifact).catch(() => undefined);
  if (!info || info.size < MIN_INSTALLER_BYTES)
    throw new Error(`fpm did not produce a usable ${type} package at ${artifact}`);
  const handle = await open(artifact, "r");
  try {
    const header = Buffer.alloc(type === "deb" ? 8 : 4);
    await handle.read(header, 0, header.length, 0);
    if (type === "deb" && header.toString("latin1") !== "!<arch>\n")
      throw new Error(`Package at ${artifact} is not a Debian archive`);
    // rpm 的 lead magic 是 \xed\xab\xee\xdb。
    if (type === "rpm" && header.toString("hex") !== "edabeedb")
      throw new Error(`Package at ${artifact} is not an RPM package`);
  } finally {
    await handle.close();
  }
}
