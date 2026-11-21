import type { reserveDescriptor } from "./background-directory.ts";

// Callers own these resources; a failed writer-stop must leave the claim in place.
export async function rollbackBackgroundStartup(options: {
  reservation: Awaited<ReturnType<typeof reserveDescriptor>>;
  stopWriter(): Promise<void>;
  cleanup: readonly (() => unknown)[];
}) {
  await options.stopWriter();
  for (const dispose of [...options.cleanup].reverse()) await dispose();
  await options.reservation.release();
}
