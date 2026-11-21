import { access, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { testDataDirectory } from "./data.ts";
import { fail, pnpm, projectRoot, run } from "./process.ts";

async function packagedExecutable(): Promise<string> {
  const dir = join(projectRoot, "apps/desktop/dist");
  if (process.platform === "darwin") {
    for (const child of ["mac-arm64", "mac", "mac-universal"]) {
      const path = join(dir, child, "Pi Bot.app/Contents/MacOS/Pi Bot");
      try {
        await access(path);
        return path;
      } catch {
        /* Try the next builder output directory. */
      }
    }
  } else if (process.platform === "win32") return join(dir, "win-unpacked/Pi Bot.exe");
  else if (process.platform === "linux") {
    for (const child of ["linux-unpacked", "linux-arm64-unpacked"]) {
      try {
        const files = await readdir(join(dir, child));
        if (files.includes("pibot")) return join(dir, child, "pibot");
      } catch {
        /* Try next architecture. */
      }
    }
  }
  throw new Error(
    "No packaged app found. Run pnpm app:package first (win/linux packaging is not yet exposed).",
  );
}
try {
  const { values } = parseArgs({
    options: { data: { type: "string" }, fresh: { type: "boolean" }, dev: { type: "boolean" } },
  });
  const data = await testDataDirectory(values.data, true);
  if (values.fresh) await rm(data, { recursive: true, force: true });
  await testDataDirectory(data, true);
  const env = { ...process.env, PIBOT_DATA_DIR: data };
  console.log(`Test data: ${data}. Quit any existing Pi Bot instance before starting.`);
  if (values.dev) await pnpm(["dev"], projectRoot, env);
  else await run(await packagedExecutable(), [], projectRoot, env);
} catch (error) {
  fail(error);
}
