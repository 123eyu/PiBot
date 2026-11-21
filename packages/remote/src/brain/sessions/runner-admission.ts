import {
  type Port,
  RpcError,
  RpcErrorCodes,
  RunnerTransferDescriptorSchema,
} from "@pibot/protocol-base";
import { z } from "zod";

const response = z.object({
  id: z.union([z.string(), z.number()]),
  method: z.never().optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});
const descriptor = RunnerTransferDescriptorSchema.passthrough();
type Call = { method: string; transferId?: string };

/** A canceled RPC remains uncertain until its response or the physical generation closes. */
export function runnerAdmission(wire: Port) {
  const calls = new Map<string | number, Call>();
  const transfers = new Set<string>();
  let frozen = false;
  let uncertain = false;
  const port: Port = {
    ...wire,
    post(value) {
      const message = value as {
        id?: string | number;
        method?: string;
        params?: { transferId?: string };
      };
      if (message.id !== undefined && message.method) {
        if (frozen) throw new RpcError(RpcErrorCodes.closed, "runner_generation_retired");
        if (calls.size >= 256) throw new RpcError(RpcErrorCodes.busy, "runner_request_capacity");
        calls.set(message.id, { method: message.method, transferId: message.params?.transferId });
        if (message.method === "runner.transfer.begin" && message.params?.transferId) {
          if (transfers.size >= 8 && !transfers.has(message.params.transferId)) uncertain = true;
          else transfers.add(message.params.transferId);
        }
      }
      try {
        wire.post(value);
      } catch (error) {
        // A failed send is not proof that a remote side effect or transfer did not start.
        uncertain = true;
        throw error;
      }
    },
    onMessage(listener) {
      return wire.onMessage((value) => {
        const parsed = response.safeParse(value);
        if (
          parsed.success &&
          (Object.hasOwn(parsed.data, "result") || Object.hasOwn(parsed.data, "error"))
        ) {
          const call = calls.get(parsed.data.id);
          calls.delete(parsed.data.id);
          if (call) {
            const result = parsed.data.result;
            const output = descriptor.safeParse(result);
            if (output.success) {
              if (transfers.size >= 8 && !transfers.has(output.data.transferId)) uncertain = true;
              else transfers.add(output.data.transferId);
            }
            if (call.transferId && !Object.hasOwn(parsed.data, "error")) {
              const done = z.object({ done: z.literal(true) }).safeParse(result).success;
              if (
                call.method === "runner.transfer.commit" ||
                call.method === "runner.transfer.cancel" ||
                (call.method === "runner.transfer.pull" && done)
              )
                transfers.delete(call.transferId);
            }
          }
        }
        listener(value);
      });
    },
  };
  return {
    port,
    idle: () => !uncertain && calls.size === 0 && transfers.size === 0,
    freeze: () => {
      frozen = true;
    },
  };
}
