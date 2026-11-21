import { enterCheckSlot } from "./check-slot.ts";
// pnpm verify: the full pre-merge gate (maintainers 2026-10-21), staged so independent work overlaps
// (maintainers 2026-10-23). Same checks as before; only the order changes:
//   install → typecheck+lint+test ∥ build → renderer and owner smoke → tests/e2e chat ∥ routines ∥
//   connected-app acceptance → group-plan acceptance → workflow regression.
// The three acceptance suites share no state (each uses its own temporary data). The routines suite
// has real-time scheduler scenarios, so nothing else heavy runs beside it in that stage.
// group-plan runs in its own stage although it shares no state either: it keeps one core busy for
// about five minutes (309s measured) and its scenarios are already load-tolerant, so
// putting it beside routines would only add load to the suite that fails first under load
// while saving at most a couple of minutes of wall time.
import { pnpm, runStages } from "./run-steps.ts";

await enterCheckSlot();

try {
  await runStages([
    [pnpm("install", "install", "--frozen-lockfile")],
    [pnpm("check", "run", "check:no-install"), pnpm("build", "build")],
    [pnpm("smoke", "run", "smoke")],
    [
      pnpm("chat", "acceptance:chat"),
      pnpm("routines", "acceptance:routines"),
      pnpm("connected-app", "acceptance:connected-app"),
    ],
    [pnpm("group-plan", "acceptance:group-plan")],
    [pnpm("workflows", "eval", "workflows")],
  ]);
  console.log("verify: all passed");
} catch (error) {
  console.error(`verify: ${(error as Error).message}`);
  process.exit(1);
}
