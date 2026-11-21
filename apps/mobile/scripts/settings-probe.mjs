// Started by `probe.mjs --settings` under tools/dev/ts-hooks.mjs. Only this dev probe
// joins the phone's settings calls with the desktop's real brain and phone gateway; the app never
// imports desktop code. A real brain cannot be bundled (it reads migrations next to its sources).
import { startSettingsDesktop } from "../../../packages/remote/dev/settings-desktop.ts";
import { runSettingsScenario } from "../src/dev/settings-scenario.ts";

const desktop = await startSettingsDesktop();
try {
  process.stdout.write(`${JSON.stringify(await runSettingsScenario(desktop))}\n`);
} finally {
  await desktop.stop();
}
