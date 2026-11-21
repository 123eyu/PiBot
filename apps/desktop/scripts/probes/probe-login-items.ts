// Run with Node; callbacks replace native login APIs and all files stay in a synthetic home.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveDataDir } from "../../../../packages/storage/src/database/data-dir.ts";
import { createBackgroundManagement } from "../../src/main/background/background-management.ts";
import {
  createLoginItemSync,
  desktopLaunchEnvironment,
  loginItemSyncEnabled,
} from "../../src/main/window/login-item-scope.ts";

const root = await mkdtemp(join(tmpdir(), "pibot-login-items-"));
let assertions = 0;
try {
  for (const platform of ["darwin", "win32", "linux"] as const) {
    const env = { APPDATA: "C:\\Synthetic\\AppData", XDG_DATA_HOME: "/synthetic/data" };
    const home = platform === "win32" ? "C:\\Synthetic" : "/synthetic/home";
    const defaultRoot = resolveDataDir({ platform, env, homedir: home, dev: false });
    for (const override of [undefined, "", defaultRoot, join(root, "custom")]) {
      for (const dev of [false, true]) {
        const launchEnv = {
          ...env,
          ...(override === undefined ? {} : { PIBOT_DATA_DIR: override }),
        };
        const scope = { dev, env: launchEnv };
        const expected = !dev && override === undefined;
        const calls: boolean[] = [];
        const sync = createLoginItemSync(scope, async (enabled) => {
          calls.push(enabled);
        });
        await sync(true);
        await sync(false);
        assert.deepEqual(calls, expected ? [true, false] : []);
        assert.equal(loginItemSyncEnabled(scope), expected);
        const dataDir = resolveDataDir({ platform, env: launchEnv, homedir: home, dev });
        const nextEnv = desktopLaunchEnvironment(scope, dataDir);
        assert.equal(loginItemSyncEnabled({ dev, env: nextEnv }), expected);
        assert.equal(resolveDataDir({ platform, env: nextEnv, homedir: home, dev }), dataDir);
        assert.equal(launchEnv.PIBOT_DATA_DIR, override, "source environment remains unchanged");
        assertions += 5;
      }
    }
    // Existing OS registrations belong to the user, even when the test run asks to turn off.
    const dataDir = join(root, platform, "data");
    const syntheticHome = join(root, platform, "home");
    const suffix = createHash("sha256").update(dataDir).digest("hex").slice(0, 16);
    const label = `org.pibot.background.${suffix}`;
    const files = [
      join(syntheticHome, "Library", "LaunchAgents", `${label}.plist`),
      join(syntheticHome, ".config", "systemd", "user", `${label}.service`),
      join(dataDir, "background-runtime", "task.xml"),
      join(syntheticHome, ".config", "autostart", "pi-bot.desktop"),
    ];
    for (const file of files) {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, "existing-user-registration");
    }
    let commands = 0;
    const manager = createBackgroundManagement({
      platform,
      packaged: true,
      loginItemsEnabled: loginItemSyncEnabled({ dev: false, env: { PIBOT_DATA_DIR: dataDir } }),
      home: syntheticHome,
      dataDir,
      executable: "synthetic-executable",
      command: async () => {
        commands++;
        throw new Error("native registration must not be touched");
      },
    });
    assert.equal((await manager.query()).available, false);
    const signal = AbortSignal.timeout(1000);
    await assert.rejects(manager.register(signal), /background_management_data_dir/);
    await assert.rejects(manager.disableLogin(signal), /background_management_data_dir/);
    await assert.rejects(manager.unregister(signal), /background_management_data_dir/);
    assert.equal(commands, 0);
    for (const file of files)
      assert.equal(await readFile(file, "utf8"), "existing-user-registration");
    assertions += 9;
  }
  await assert.rejects(
    createLoginItemSync({ dev: false, env: {} }, async () => {
      throw new Error("synthetic-sync-failure");
    })(true),
    /synthetic-sync-failure/,
  );
  assertions++;
  console.info(`Login item startup probe passed: ${assertions} assertions; native calls: 0`);
} finally {
  await rm(root, { recursive: true, force: true });
}
