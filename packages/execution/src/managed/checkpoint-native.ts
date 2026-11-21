import { Worker } from "node:worker_threads";
import { ExecError } from "../core/types.ts";
import { CHECKPOINT_OPERATION_SOURCE } from "./checkpoint-recipe-source.ts";
import { type ManagedPathIdentity, managedIdentity } from "./managed-boundary.ts";

/** Fixed filesystem recipe only; no shell, model program, network or general worker API. */
export async function runNativeCheckpoint(
  payload: object,
  identities: ManagedPathIdentity[],
  parent: AbortSignal,
  authorize: () => void,
) {
  const signal = AbortSignal.any([parent, AbortSignal.timeout(120_000)]);
  const check = async () => {
    signal.throwIfAborted();
    authorize();
    for (const pinned of identities) {
      const actual = await managedIdentity(pinned.path);
      if (actual.device !== pinned.device || actual.inode !== pinned.inode)
        throw new ExecError("outside_workplace");
    }
    signal.throwIfAborted();
    authorize();
  };
  await check();
  const worker = new Worker(
    `${CHECKPOINT_OPERATION_SOURCE}
    const {parentPort,workerData}=require('node:worker_threads');
    let sequence=0;const waiting=new Map();
    parentPort.on('message',id=>{const resolve=waiting.get(id);waiting.delete(id);resolve?.()});
    const authorize=()=>new Promise(resolve=>{const id=++sequence;waiting.set(id,resolve);parentPort.postMessage({authorize:id})});
    checkpointOperation(workerData,authorize).then(result=>{parentPort.postMessage({result});parentPort.close()},()=>{parentPort.postMessage({failed:true});parentPort.close()});
  `,
    { eval: true, workerData: payload, resourceLimits: { maxOldGenerationSizeMb: 256 } },
  );
  try {
    return await new Promise<unknown>((resolve, reject) => {
      let result: unknown;
      let failure: unknown;
      let reported = false;
      const stop = (error: unknown) => {
        failure ??= error;
        void worker.terminate().catch(() => reject(new ExecError("file_failed", "cleanup_failed")));
      };
      const abort = () => stop(signal.reason);
      worker.on("message", (message) => {
        if (message?.authorize) {
          void check().then(() => worker.postMessage(message.authorize), stop);
        } else if (message?.result) {
          result = message.result;
          reported = true;
        } else stop(new ExecError("file_failed"));
      });
      worker.once("error", stop);
      worker.once("exit", (code) => {
        signal.removeEventListener("abort", abort);
        if (failure) reject(failure);
        else if (code !== 0 || !reported) reject(new ExecError("file_failed"));
        else resolve(result);
      });
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  } finally {
    await worker.terminate().catch(() => {
      throw new ExecError("file_failed", "cleanup_failed");
    });
  }
}
