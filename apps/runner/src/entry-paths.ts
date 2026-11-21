import { basename, dirname } from "node:path";

/** A signed macOS bundle starts the same core directly, without an interpreter shell. */
export function runnerAppContents(executable: string, platform: string) {
  const macos = dirname(executable);
  const contents = dirname(macos);
  return platform === "darwin" &&
    basename(macos) === "MacOS" &&
    basename(contents) === "Contents" &&
    dirname(contents).endsWith(".app")
    ? contents
    : undefined;
}
