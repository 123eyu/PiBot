// Started by `probe.mjs --phone-data` under tools/dev/ts-hooks.mjs. Only this
// dev probe joins the phone's own phone-data code with the desktop's real brain, remote capability
// and phone tools; the app never imports desktop code.
import { startPhoneDataDesktop } from "../../../packages/remote/dev/phone-data-desktop.ts";
import { PHONE_DATA_SCRIPT, runPhoneDataScenario } from "../src/dev/phone-data-scenario.ts";

const desktop = await startPhoneDataDesktop(PHONE_DATA_SCRIPT);
try {
  process.stdout.write(`${JSON.stringify(await runPhoneDataScenario(desktop), null, 1)}\n`);
} finally {
  await desktop.stop();
}
