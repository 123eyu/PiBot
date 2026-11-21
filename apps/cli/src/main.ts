import { parseCommand, USAGE } from "./args.ts";
import { type Emit, runOnce } from "./run.ts";

/** Kept out of `run.ts` so the single-turn flow stays testable with any `Emit`. */
export async function main(argv: string[]): Promise<number> {
  const command = parseCommand(argv);
  if (command.kind === "help") {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (command.kind === "invalid") {
    process.stderr.write(`${command.message}\n\n${USAGE}\n`);
    return 2;
  }
  if (command.kind === "acp-attach") {
    const { runAcpAttach } = await import("./acp-attach.ts");
    return runAcpAttach();
  }
  // Reading the key from the environment keeps it out of argv, shell history and process listings.
  const provider = command.options.provider;
  const ambientKey = process.env.PIBOT_API_KEY;
  // Anything this run starts (the brain, and through it a Bot's commands) inherits this environment.
  delete process.env.PIBOT_API_KEY;
  const keyed =
    provider && !provider.apiKey && ambientKey
      ? { ...command.options, provider: { ...provider, apiKey: ambientKey } }
      : command.options;
  if (command.kind === "mcp") {
    const { runMcp } = await import("./mcp.ts");
    return runMcp(keyed);
  }
  if (command.kind === "acp") {
    const { runAcp } = await import("./acp.ts");
    return runAcp(keyed);
  }
  const runOptions = {
    ...command.options,
    ...(keyed.provider ? { provider: keyed.provider } : {}),
  };
  const json = runOptions.json;
  let streamed = false;
  const emit: Emit = {
    event(record) {
      if (json) process.stdout.write(`${JSON.stringify(record)}\n`);
    },
    text(chunk) {
      if (json) return emit.event({ type: "delta", text: chunk });
      streamed ||= chunk.length > 0;
      process.stdout.write(chunk);
    },
    notice(line) {
      if (!json && streamed) process.stdout.write("\n");
      process.stderr.write(`${line}\n`);
    },
  };
  process.stderr.write(
    "note: this entry point is for development and testing; credentials in --data are not encrypted\n",
  );
  const code = await runOnce(runOptions, emit);
  // Output is already written; a handle the brain left behind must not keep the command hanging.
  setTimeout(() => process.exit(code), 5000).unref();
  return code;
}
