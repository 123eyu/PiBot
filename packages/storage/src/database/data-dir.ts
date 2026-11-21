import { posix, win32 } from "node:path";

export interface DataDirOptions {
  platform: NodeJS.Platform;
  env: Readonly<NodeJS.ProcessEnv>;
  homedir: string;
  dev: boolean;
}

export function resolveDataDir({ platform, env, homedir, dev }: DataDirOptions): string {
  if (env.PIBOT_DATA_DIR) return env.PIBOT_DATA_DIR;
  switch (platform) {
    case "darwin":
      return posix.join(homedir, "Library", "Application Support", dev ? "Pi Bot Dev" : "Pi Bot");
    case "win32":
      return win32.join(
        env.APPDATA || win32.join(homedir, "AppData", "Roaming"),
        dev ? "Pi Bot Dev" : "Pi Bot",
      );
    case "linux":
      return posix.join(
        env.XDG_DATA_HOME || posix.join(homedir, ".local", "share"),
        dev ? "pi-bot-dev" : "pi-bot",
      );
    default:
      throw new Error(`Unsupported platform: ${platform}`);
  }
}
