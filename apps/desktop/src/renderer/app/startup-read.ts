import type { StartupLabelTables } from "../../shared/startup-labels.ts";
import type { StartupSnapshot } from "../../shared/startup-snapshot.ts";

/** A single deadline owns both reads; late IPC replies never update an already mounted App. */
export async function readStartupDisplay(
  source:
    | {
        read(): Promise<StartupSnapshot | null>;
        locale(): Promise<string>;
        labels?(): Promise<StartupLabelTables | null>;
      }
    | undefined,
  fallbackLocale: string,
  timeoutMs = 300,
): Promise<{
  snapshot: StartupSnapshot | null;
  systemLocale: string;
  labels: StartupLabelTables | null;
}> {
  let snapshot: StartupSnapshot | null = null;
  let labels: StartupLabelTables | null = null;
  let systemLocale = fallbackLocale;
  let active = true;
  let completed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  const reads = Promise.allSettled([
    Promise.resolve()
      .then(() => source?.read())
      .then((value) => {
        if (active) snapshot = value ?? null;
      }),
    Promise.resolve()
      .then(() => source?.locale())
      .then((value) => {
        if (active && value) systemLocale = value;
      }),
    Promise.resolve()
      .then(() => source?.labels?.())
      .then((value) => {
        if (active) labels = value ?? null;
      }),
  ]);
  try {
    await Promise.race([
      reads.then(() => {
        completed = true;
      }),
      deadline,
    ]);
  } finally {
    active = false;
    clearTimeout(timer);
  }
  // Labels never depend on the snapshot: a cache miss still gets a translated starting page.
  return {
    snapshot: completed && labels ? snapshot : null,
    systemLocale,
    labels: completed ? labels : null,
  };
}
