import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    build: { type: "boolean" },
    keep: { type: "boolean" },
    "self-test": { type: "boolean" },
    help: { type: "boolean" },
  },
});
if (values.help) {
  console.log(
    "pnpm e2e [--build] [--keep] <browser-login|teach-once|routine-run|connector-mcp|approval-yolo|compact-manual|browser-secret|all>\npnpm e2e --self-test",
  );
} else if (values["self-test"]) {
  const { selfTest } = await import("./self-test.mts");
  await selfTest();
} else {
  const { flows, repo, runFlow, build } = await import("./runner.mts");
  if (positionals.includes("all") && positionals.length !== 1) throw new Error("all_must_be_alone");
  const names = positionals.includes("all") ? [...flows] : positionals;
  if (new Set(names).size !== names.length) throw new Error("duplicate_e2e_flow");
  if (!names.length || names.some((name) => !flows.includes(name as (typeof flows)[number])))
    throw new Error("unknown_or_missing_e2e_flow");
  const { mkdir } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const output = join(repo, ".codex", "e2e", new Date().toISOString().replaceAll(/[:.]/g, "-"));
  await mkdir(output, { recursive: true, mode: 0o700 });
  const lifetime = new AbortController();
  const stop = () => lifetime.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    if (values.build) await build(AbortSignal.any([lifetime.signal, AbortSignal.timeout(180_000)]));
    let ok = true;
    for (const name of names) {
      lifetime.signal.throwIfAborted();
      ok =
        (await runFlow(name as (typeof flows)[number], output, lifetime.signal, !!values.keep)) &&
        ok;
    }
    process.exitCode = ok ? 0 : 1;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    console.log(JSON.stringify({ artifacts: output }));
  }
}
