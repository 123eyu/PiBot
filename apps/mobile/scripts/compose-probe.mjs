// Started by `probe.mjs --compose` under tools/dev/ts-hooks.mjs. Composer
// attachments from the phone app's own runtime through the desktop's real phone gateway and brain
// (the `--phone-data` harness); the app never imports desktop code.
import { startPhoneDataDesktop } from "../../../packages/remote/dev/phone-data-desktop.ts";
import { COMPOSE_SCRIPT, runComposeScenario } from "../src/dev/compose-scenario.ts";

const desktop = await startPhoneDataDesktop(COMPOSE_SCRIPT);
try {
  process.stdout.write(`${JSON.stringify(await runComposeScenario(desktop), null, 1)}\n`);
} finally {
  await desktop.stop();
}
