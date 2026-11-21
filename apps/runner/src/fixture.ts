import { join } from "node:path";
import { prepareRunnerDataDir, runnerDataDir } from "./data-dir.ts";
import { runnerFailure } from "./errors.ts";
import { createFixturePort } from "./fixture-port.ts";
import { createRunnerLogger } from "./logger.ts";
import { takeEnvironmentPassphrase } from "./passphrase.ts";
import { createRunnerRedactor } from "./redactor.ts";
import { runRunner } from "./runtime.ts";

async function main() {
  if (process.env.PIBOT_RUNNER_FIXTURE !== "1") throw new Error("fixture_disabled");
  delete process.env.PIBOT_RUNNER_FIXTURE;
  const dataDir = runnerDataDir();
  await prepareRunnerDataDir(dataDir);
  const redactor = createRunnerRedactor();
  const environmentPassphrase = takeEnvironmentPassphrase(redactor);
  const logger = createRunnerLogger(join(dataDir, "logs"), redactor, "stderr");
  const port = createFixturePort(process.stdin, process.stdout);
  const lifetime = new AbortController();
  port.onClose?.(() => lifetime.abort(new Error("fixture_port_closed")));
  await runRunner({
    dataDir,
    environmentPassphrase,
    logger,
    redactor,
    fixturePort: port,
    stopSignal: lifetime.signal,
  });
}

main().catch((error: unknown) => {
  process.exitCode = 1;
  const failure = runnerFailure(error);
  process.stderr.write(
    `${JSON.stringify({ level: "error", event: "runner.fixture.failed", ...failure })}\n`,
    () => {
      if (failure.code === "drain_incomplete") process.exit(1);
    },
  );
});
