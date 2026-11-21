// Linux has no reason to start Chromium (or need DISPLAY) for a command-sandbox diagnosis.
import { dirname, join } from "node:path";
import { startSandboxDoctor } from "./sandbox-doctor-entry.ts";

void startSandboxDoctor(process.env, join(dirname(process.execPath), "..")).then(
  (code) => {
    process.exitCode = code;
  },
  () => {
    process.stderr.write("pibot sandbox doctor: startup_failed\n");
    process.exitCode = 1;
  },
);
