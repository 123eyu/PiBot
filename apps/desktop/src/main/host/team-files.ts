import type { Logger } from "@pibot/observability";
import { RpcError, RpcErrorCodes, type TeamTemplate, TeamTemplateSchema } from "@pibot/protocol";
import type { Redactor } from "@pibot/secrets";
import { inspectTeamFile, readTeamFile, saveTeamFile, TEAM_BYTES } from "./team-file-io.ts";

function waitDialog<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(new RpcError(RpcErrorCodes.closed, "team_cancelled"));
    };
    signal.addEventListener("abort", abort, { once: true });
    void pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}
function clean(value: unknown, redactor: Redactor): unknown {
  if (typeof value === "string") return redactor.redact(value);
  if (Array.isArray(value)) return value.map((v) => clean(v, redactor));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clean(v, redactor)]));
  return value;
}

export function createTeamFiles(options: {
  choose(): Promise<string | null>;
  save(defaultName?: string): Promise<string | null>;
  check(): void;
  redactor: Redactor;
  logger: Logger;
}) {
  let controller: AbortController | undefined;
  let busy = false;
  let closed = false;
  let selected: Awaited<ReturnType<typeof inspectTeamFile>> | undefined;
  let expires = 0;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    controller?.abort();
    selected = undefined;
    clearTimeout(expiryTimer);
    expiryTimer = undefined;
  };
  const check = () => {
    options.check();
    if (closed) throw new RpcError(RpcErrorCodes.closed, "team_closed");
  };
  async function dialog<T>(
    choose: () => Promise<string | null>,
    action: (file: string, signal: AbortSignal) => Promise<T>,
  ) {
    check();
    if (busy) throw new RpcError(RpcErrorCodes.busy, "team_picker_busy");
    cancel();
    busy = true;
    controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(600_000)]);
    let pending: Promise<string | null> | undefined;
    let nativeSettled = false;
    try {
      pending = choose();
      void pending.then(
        () => {
          nativeSettled = true;
        },
        () => {
          nativeSettled = true;
        },
      );
      const file = await waitDialog(pending, signal);
      signal.throwIfAborted();
      check();
      return file === null
        ? null
        : await action(file, AbortSignal.any([signal, AbortSignal.timeout(20_000)]));
    } catch (error) {
      cancel();
      if (error instanceof RpcError) throw error;
      throw new RpcError(RpcErrorCodes.invalidParams, "team_file_invalid");
    } finally {
      // Cancelling local waiting cannot close a native dialog; keep its exclusive guard until settled.
      if (!pending || nativeSettled) busy = false;
      else
        void pending.then(
          () => {
            busy = false;
          },
          () => {
            busy = false;
          },
        );
    }
  }
  return {
    pickFile: () =>
      dialog(options.choose, async (path, signal) => {
        const file = await inspectTeamFile(path, signal);
        signal.throwIfAborted();
        check();
        selected = file;
        expires = Date.now() + 30_000;
        expiryTimer = setTimeout(cancel, 30_000);
        expiryTimer.unref();
        return file.path;
      }),
    async read(file: string) {
      check();
      const grant = selected;
      const signal = AbortSignal.any([
        controller?.signal ?? AbortSignal.abort(),
        AbortSignal.timeout(20_000),
      ]);
      selected = undefined;
      clearTimeout(expiryTimer);
      if (!grant || file !== grant.path || Date.now() >= expires)
        throw new RpcError(RpcErrorCodes.invalidParams, "team_selection_required");
      try {
        return await readTeamFile(grant, signal);
      } catch {
        throw new RpcError(RpcErrorCodes.invalidParams, "team_file_invalid");
      }
    },
    async save(template: TeamTemplate) {
      let text: string;
      try {
        text = JSON.stringify(TeamTemplateSchema.parse(clean(template, options.redactor)));
      } catch {
        throw new RpcError(RpcErrorCodes.invalidParams, "team_file_invalid");
      }
      const saved = await dialog(
        () => options.save(template.groups[0]?.name ?? template.bots[0]?.name),
        async (path, signal) => {
          await saveTeamFile(path, text, signal);
          options.logger.info(
            JSON.stringify({ module: "host", event: "team.exported", audit: true }),
          );
          return true;
        },
      );
      return { saved: saved === true };
    },
    /**
     * Version-3 archive, already built and redacted by brain (the trusted side of this
     * port); the host only checks it is a bounded zip before writing it where the user chose.
     */
    async saveArchive(archive: string, defaultName?: string) {
      const data = Buffer.from(archive, "base64");
      if (data.length < 4 || data.length > TEAM_BYTES || data.readUInt32LE(0) !== 0x04034b50)
        throw new RpcError(RpcErrorCodes.invalidParams, "team_file_invalid");
      const saved = await dialog(
        () => options.save(defaultName),
        async (path, signal) => {
          await saveTeamFile(path, data, signal);
          options.logger.info(
            JSON.stringify({ module: "host", event: "team.exported", audit: true }),
          );
          return true;
        },
      );
      return { saved: saved === true };
    },
    cancel,
    dispose() {
      closed = true;
      cancel();
    },
  };
}
