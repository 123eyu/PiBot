// Started by `probe.mjs --records` under tools/dev/ts-hooks.mjs. Only this dev
// probe joins the phone's records code with the desktop's real phone gateway; the app never
// imports desktop code.
import { startRecordsGateway } from "../../../packages/remote/dev/records-gateway.ts";
import { runRecordsScenario } from "../src/dev/records-scenario.ts";

process.stdout.write(`${JSON.stringify(await runRecordsScenario(startRecordsGateway), null, 1)}\n`);
