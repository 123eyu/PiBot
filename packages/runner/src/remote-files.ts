import type { ExecutionTarget, FileContext } from "@pibot/execution";
import { ExecError } from "@pibot/execution";
import {
  RunnerBinaryPublicationSchema,
  RunnerFileRequestSchema,
  runnerFileResultSchemas,
} from "@pibot/protocol-base";
import {
  fileContext,
  fileInput,
  issueKey,
  type RemoteDeps,
  requireDispatch,
} from "./remote-state.ts";

/**
 * The file half of the remote target: one request document up, one result document down, both
 * through the transfer channel. A write additionally needs the dispatch confirmation and an
 * idempotency key, so a retry after a dropped link replays instead of writing twice.
 */
export function createFileChannel(deps: RemoteDeps): FileMembers {
  const { call, callSignal, tracked, withDispatch, transfer } = deps;
  const { pull, upload } = transfer;

  async function fileCall<K extends keyof typeof runnerFileResultSchemas>(
    operation: K,
    input: FileContext & Record<string, unknown>,
    write = false,
  ) {
    const confirm = write ? requireDispatch(input.assertCurrent) : undefined;
    const request = RunnerFileRequestSchema.parse({ operation, input: fileInput(input) });
    const bytes = Buffer.from(JSON.stringify(request), "utf8");
    const key = write ? issueKey() : undefined;
    const signal = callSignal(input.signal);
    const work = async (dispatchOpId?: string) => {
      const descriptor = await upload(bytes, { kind: "file" }, signal, key, dispatchOpId);
      const result = JSON.parse((await pull(descriptor, signal)).toString("utf8"));
      return runnerFileResultSchemas[operation].parse(result);
    };
    return key
      ? withDispatch(confirm as () => void | Promise<void>, (dispatchOpId) =>
          tracked(key, `file.${operation}`, () => work(dispatchOpId)),
        )
      : work();
  }

  return {
    inspectPath: (input) =>
      fileCall("inspectPath", input as never) as ReturnType<
        NonNullable<ExecutionTarget["inspectPath"]>
      >,
    listEntries: (input) =>
      fileCall("listEntries", input as never) as ReturnType<
        NonNullable<ExecutionTarget["listEntries"]>
      >,
    listDir: (input: Parameters<ExecutionTarget["listDir"]>[0]) =>
      fileCall("listDir", input as never) as ReturnType<ExecutionTarget["listDir"]>,
    readFile: (input: Parameters<ExecutionTarget["readFile"]>[0]) =>
      fileCall("readFile", input as never) as ReturnType<ExecutionTarget["readFile"]>,
    readLog: (input: Parameters<ExecutionTarget["readLog"]>[0]) =>
      fileCall("readLog", input as never) as ReturnType<ExecutionTarget["readLog"]>,
    observeChanges: (input: Parameters<ExecutionTarget["observeChanges"]>[0]) =>
      fileCall("observeChanges", input as never) as ReturnType<ExecutionTarget["observeChanges"]>,
    async findFiles(input: Parameters<ExecutionTarget["findFiles"]>[0]) {
      return (await fileCall("findFiles", input as never)) as Awaited<
        ReturnType<ExecutionTarget["findFiles"]>
      >;
    },
    async searchText(input: Parameters<ExecutionTarget["searchText"]>[0]) {
      return (await fileCall("searchText", input as never)) as Awaited<
        ReturnType<ExecutionTarget["searchText"]>
      >;
    },
    writeFile: (input: Parameters<ExecutionTarget["writeFile"]>[0]) =>
      fileCall("writeFile", input as never, true) as ReturnType<ExecutionTarget["writeFile"]>,
    editFile: (input: Parameters<ExecutionTarget["editFile"]>[0]) =>
      fileCall("editFile", input as never, true) as ReturnType<ExecutionTarget["editFile"]>,
    async applyPatch(input: Parameters<ExecutionTarget["applyPatch"]>[0]) {
      // A patch publishes files; it needs the same dispatch confirmation and idempotency key as
      // write_file so a retried call after a dropped link replays instead of writing again.
      return (await fileCall("applyPatch", input as never, true)) as Awaited<
        ReturnType<ExecutionTarget["applyPatch"]>
      >;
    },
    async readBinary(input: Parameters<ExecutionTarget["readBinary"]>[0]) {
      const descriptor = await call(
        "runner.binary.read",
        { path: input.path, context: fileContext(input) },
        { signal: callSignal(input.signal) },
      );
      const bytes = await pull(descriptor, callSignal(input.signal));
      // The wire carries an ArrayBuffer-backed buffer; the shared type names it that way.
      return {
        path: descriptor.path,
        bytes: bytes as Buffer<ArrayBuffer>,
        revision: descriptor.sha256,
      };
    },
    async writeBinary(input: Parameters<ExecutionTarget["writeBinary"]>[0]) {
      await input.revalidate();
      const key = issueKey();
      return withDispatch(
        () => input.revalidate(),
        (dispatchOpId) =>
          tracked(key, "binary.write", async () => {
            const descriptor = await upload(
              input.bytes,
              { kind: "binary_write", path: input.path, context: fileContext(input) },
              callSignal(input.signal),
              key,
              dispatchOpId,
            );
            return RunnerBinaryPublicationSchema.parse(
              JSON.parse((await pull(descriptor, callSignal(input.signal))).toString("utf8")),
            );
          }),
      );
    },
    writeImage: async () => {
      throw new ExecError("file_failed", "unsupported_platform");
    },
    readCheckpoint: async () => {
      throw new ExecError("file_failed", "unsupported_platform");
    },
  };
}

type FileMembers = Pick<
  ExecutionTarget,
  | "inspectPath"
  | "listEntries"
  | "listDir"
  | "readFile"
  | "readLog"
  | "observeChanges"
  | "findFiles"
  | "searchText"
  | "writeFile"
  | "editFile"
  | "applyPatch"
  | "readBinary"
  | "writeBinary"
  | "writeImage"
  | "readCheckpoint"
>;
