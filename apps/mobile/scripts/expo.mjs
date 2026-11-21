import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const child = spawn(
  process.execPath,
  [join(dirname(require.resolve("expo/package.json")), "bin/cli"), ...process.argv.slice(2)],
  {
    stdio: "inherit",
    env: { ...process.env, EXPO_NO_TELEMETRY: "1" },
  },
);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
child.on("error", () => {
  process.exitCode = 1;
});
