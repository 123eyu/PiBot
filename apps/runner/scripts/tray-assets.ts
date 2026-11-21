import { chmod, cp, lstat, mkdir, readlink, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** T1 calls this before manifest hashing/signing; no second Node or copied desktop app. */
export async function copyRunnerTrayAssets(repo: string, resourcesDir: string, platform: string) {
  if (platform !== "darwin" && platform !== "win32") return;
  const directory = join(resourcesDir, "tray");
  await mkdir(directory, { recursive: true });
  const icons =
    platform === "darwin"
      ? ["trayTemplate.png", "trayTemplate@2x.png"]
      : ["tray-color-16.png", "tray-color-24.png", "tray-color-32.png"];
  for (const icon of icons)
    await cp(join(repo, "apps", "desktop", "resources", icon), join(resourcesDir, icon));
  const script = platform === "darwin" ? "mac.js" : "windows.ps1";
  await cp(join(repo, "apps", "runner", "src", "tray", script), join(directory, script));
}

/** The executable and resources are installed into Contents/MacOS and Contents/Resources by T1. */
export async function writeRunnerAppInfo(contentsDir: string, version: string, executable: string) {
  if (
    !/^[a-zA-Z0-9._-]+$/u.test(executable) ||
    !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/u.test(version)
  )
    throw new Error("runner_app_metadata_invalid");
  await mkdir(contentsDir, { recursive: true });
  const bundleVersion = version.split(/[-+]/u)[0];
  await writeFile(
    join(contentsDir, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.pibot.runner</string>
<key>CFBundleName</key><string>Pi Bot Runner</string>
<key>CFBundleExecutable</key><string>${executable}</string>
<key>CFBundleVersion</key><string>${bundleVersion}</string>
<key>CFBundleShortVersionString</key><string>${bundleVersion}</string>
<key>LSUIElement</key><true/>
<key>NSAppleEventsUsageDescription</key><string>Pi Bot Runner performs computer actions you approve.</string>
</dict></plist>\n`,
  );
  for (const [language, description] of [
    ["en", "Pi Bot Runner performs computer actions you approve."],
    ["zh-Hans", "Pi Bot 执行端只执行你批准的电脑操作。"],
  ]) {
    const localization = join(contentsDir, "Resources", `${language}.lproj`);
    await mkdir(localization, { recursive: true });
    await writeFile(
      join(localization, "InfoPlist.strings"),
      `"NSAppleEventsUsageDescription" = "${description}";\n`,
    );
  }
}

/** Assembly hook only. The caller signs the core and .app after all SEA/resources mutations. */
export async function createRunnerMacApp(options: {
  repo: string;
  executablePath: string;
  resourcesDir: string;
  bundleDir: string;
  version: string;
}) {
  // A fresh staging bundle prevents removed resources or an old shell launcher surviving upgrades.
  await mkdir(options.bundleDir);
  const contents = join(options.bundleDir, "Contents");
  const macos = join(contents, "MacOS");
  await mkdir(macos, { recursive: true });
  await cp(options.executablePath, join(macos, "runner-core"));
  await chmod(join(macos, "runner-core"), 0o755);
  const resources = join(contents, "Resources");
  await cp(options.resourcesDir, resources, { recursive: true });
  await copyRunnerTrayAssets(options.repo, resources, "darwin");
  // Preserve T1's exe-adjacent resource lookup without duplicating the resource payload.
  const compatibility = join(macos, "resources");
  try {
    const existing = await lstat(compatibility);
    if (!existing.isSymbolicLink() || (await readlink(compatibility)) !== "../Resources")
      throw new Error("runner_app_resources_conflict");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    await symlink("../Resources", compatibility);
  }
  await writeRunnerAppInfo(contents, options.version, "runner-core");
  return options.bundleDir;
}
