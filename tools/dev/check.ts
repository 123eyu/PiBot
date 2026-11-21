import { enterCheckSlot } from "./check-slot.ts";
import { fail, pnpm } from "./process.ts";

await enterCheckSlot();

try {
  await pnpm(["install", "--frozen-lockfile"]);
  await pnpm(["run", "check:no-install"]);
} catch (error) {
  fail(error);
}
