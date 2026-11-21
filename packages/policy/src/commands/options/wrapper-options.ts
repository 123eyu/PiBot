import type { OptionSpec } from "./options.ts";
export const wrapperOptions: Readonly<Record<string, OptionSpec>> = {
  env: {
    flags: "i0v",
    values: "uCS",
    longFlags: ["--ignore-environment", "--null", "--debug"],
    longValues: ["--unset", "--chdir", "--split-string"],
  },
  time: {
    flags: "pv",
    values: "fo",
    longFlags: ["--portability", "--verbose"],
    longValues: ["--format", "--output"],
    writeValues: ["-o", "--output"],
  },
  xargs: {
    flags: "0rptx",
    values: "nPILsda",
    longFlags: ["--null", "--no-run-if-empty", "--interactive", "--verbose", "--exit"],
    longValues: [
      "--max-args",
      "--max-procs",
      "--replace",
      "--max-lines",
      "--max-chars",
      "--delimiter",
      "--arg-file",
    ],
    readValues: ["-a", "--arg-file"],
  },
  nohup: {},
  nice: { values: "n", longValues: ["--adjustment"] },
  timeout: {
    flags: "v",
    values: "sk",
    longFlags: ["--foreground", "--preserve-status", "--verbose"],
    longValues: ["--signal", "--kill-after"],
  },
  command: { flags: "pvV" },
  builtin: {},
};
