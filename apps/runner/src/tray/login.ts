import { spawn } from "node:child_process";
import { lstat, mkdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const LABEL = "com.pibot.runner.tray";
const escapeXml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const location = () => join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
export async function runnerLoginEnabled() {
  try {
    const info = await lstat(location());
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.())
      throw new Error("runner_login_unsafe");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Only a signed installed .app is registered; development source trees are never login items. */
export async function toggleRunnerLogin(executable: string) {
  if (process.platform !== "darwin" || !process.getuid) throw new Error("runner_login_unsupported");
  const marker = ".app/Contents/MacOS/";
  const index = executable.lastIndexOf(marker);
  if (index < 0) throw new Error("runner_login_requires_app");
  const bundle = executable.slice(0, index + 4);
  const path = location();
  const enabled = await runnerLoginEnabled();
  const domain = `gui/${process.getuid()}`;
  if (enabled) {
    // RunAtLoad uses open, so there may be no loaded live service after launching the app.
    await runLaunchctl(["bootout", `${domain}/${LABEL}`], true);
    await unlink(path);
    return;
  }
  const parent = join(homedir(), "Library", "LaunchAgents");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const info = await lstat(parent);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid())
    throw new Error("runner_login_unsafe");
  await writeFile(
    path,
    `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>Label</key><string>${LABEL}</string><key>ProgramArguments</key><array><string>/usr/bin/open</string><string>-g</string><string>-a</string><string>${escapeXml(bundle)}</string></array><key>RunAtLoad</key><true/></dict></plist>\n`,
    { flag: "wx", mode: 0o600 },
  );
  try {
    await runLaunchctl(["bootstrap", domain, path]);
  } catch (error) {
    await unlink(path);
    throw error;
  }
}
async function runLaunchctl(args: string[], allowMissing = false) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("/bin/launchctl", args, {
      stdio: "ignore",
      signal: AbortSignal.timeout(10_000),
    });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 || allowMissing ? resolve() : reject(new Error("runner_login_failed")),
    );
  });
}
